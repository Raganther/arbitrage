/*
 * ebay.mjs — a small, dependency-free client for the eBay Browse API.
 *
 * Covers exactly what the toolkit needs:
 *   - client-credentials OAuth (Application token) with caching + auto-refresh
 *   - sandbox / production switching
 *   - item_summary/search with paging and a filter builder
 *   - item lookup (by Browse itemId or legacy numeric id) for "did it sell?" checks
 *   - retries on 429 / 5xx, one token refresh on 401, readable errors
 *   - a call counter so you can see how much of the 5,000/day budget a run used
 *
 * Node 18+. `fetch` is injectable so the whole thing is testable offline.
 */

export const HOSTS = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};

export const SCOPE = "https://api.ebay.com/oauth/api_scope";

export class EbayError extends Error {
  constructor(message, { status, errorId, body, url } = {}) {
    super(message);
    this.name = "EbayError";
    this.status = status;
    this.errorId = errorId;
    this.body = body;
    this.url = url;
  }
}

/** Build a Browse API `filter` string from a plain object. Unknown keys pass through as-is. */
export function buildFilter(f = {}) {
  const parts = [];
  if (f.priceMin != null || f.priceMax != null) {
    const lo = f.priceMin != null ? f.priceMin : "";
    const hi = f.priceMax != null ? f.priceMax : "";
    parts.push(`price:[${lo}..${hi}]`);
    parts.push(`priceCurrency:${f.currency || "EUR"}`);
  }
  if (f.conditions && f.conditions.length) parts.push(`conditions:{${f.conditions.join("|")}}`);
  if (f.conditionIds && f.conditionIds.length) parts.push(`conditionIds:{${f.conditionIds.join("|")}}`);
  if (f.buyingOptions && f.buyingOptions.length) parts.push(`buyingOptions:{${f.buyingOptions.join("|")}}`);
  if (f.itemLocationCountry) parts.push(`itemLocationCountry:${f.itemLocationCountry}`);
  if (f.deliveryCountry) parts.push(`deliveryCountry:${f.deliveryCountry}`);
  if (f.sellers && f.sellers.length) parts.push(`sellers:{${f.sellers.join("|")}}`);
  if (f.raw) parts.push(f.raw);
  return parts.join(",");
}

/** Pull the numeric legacy item id out of an eBay item URL, or a Browse id like v1|123456|0. */
export function legacyIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/itm\/(?:[^/]*\/)?(\d{9,15})/) || String(url).match(/[?&]item=(\d{9,15})/) ||
    String(url).match(/^v1\|(\d+)\|/);
  return m ? m[1] : null;
}

/** Normalise an itemSummary into the flat shape the scanner works with. */
export function summarise(it) {
  const price = it.price ? Number(it.price.value) : NaN;
  const ship = it.shippingOptions && it.shippingOptions[0] && it.shippingOptions[0].shippingCost
    ? Number(it.shippingOptions[0].shippingCost.value) : null;
  return {
    itemId: it.itemId || "",
    legacyItemId: it.legacyItemId || legacyIdFromUrl(it.itemWebUrl) || "",
    title: it.title || "",
    price,
    currency: it.price ? it.price.currency : "",
    shipping: ship != null && isFinite(ship) ? ship : null,
    landed: isFinite(price) ? price + (ship != null && isFinite(ship) ? ship : 0) : NaN,
    cond: it.condition || "",
    conditionId: it.conditionId || "",
    url: it.itemWebUrl || "",
    image: it.image ? it.image.imageUrl : "",
    buyingOptions: it.buyingOptions || [],
    bidCount: it.bidCount || 0,
    endsAt: it.itemEndDate || "",
    location: it.itemLocation ? (it.itemLocation.country || "") : "",
    seller: it.seller ? { name: it.seller.username || "", feedbackPct: it.seller.feedbackPercentage, feedbackScore: it.seller.feedbackScore } : null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class EbayClient {
  /**
   * @param {object} o
   * @param {string} o.clientId       App ID (Client ID) from developer.ebay.com → Application Keys
   * @param {string} o.clientSecret   Cert ID (Client Secret)
   * @param {"production"|"sandbox"} [o.env="production"]
   * @param {string} [o.marketplace="EBAY_IE"]   EBAY_GB, EBAY_US, EBAY_DE ...
   * @param {Function} [o.fetch]      injectable fetch for tests
   * @param {number} [o.retries=3]    retries on 429/5xx/network errors
   * @param {Function} [o.log]        optional logger (msg) => void
   */
  constructor(o = {}) {
    if (!o.clientId || !o.clientSecret) throw new EbayError("EbayClient needs clientId and clientSecret (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET).");
    this.env = o.env === "sandbox" ? "sandbox" : "production";
    this.host = HOSTS[this.env];
    this.marketplace = o.marketplace || "EBAY_IE";
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.fetch = o.fetch || globalThis.fetch;
    this.retries = o.retries == null ? 3 : o.retries;
    this.log = o.log || (() => {});
    this.sleep = o.sleep || sleep;
    this.now = o.now || (() => Date.now());
    this.token = null;        // { value, expiresAt }
    this.calls = { token: 0, api: 0 };
    if (!this.fetch) throw new EbayError("No fetch available — use Node 18+ or pass { fetch }.");
  }

  /** Mint (or reuse) an Application access token. Refreshes 60s before expiry. */
  async getToken(force = false) {
    if (!force && this.token && this.token.expiresAt - this.now() > 60_000) return this.token.value;
    const basic = Buffer.from(this.clientId + ":" + this.clientSecret).toString("base64");
    const url = this.host + "/identity/v1/oauth2/token";
    this.calls.token++;
    const res = await this.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + basic },
      body: "grant_type=client_credentials&scope=" + encodeURIComponent(SCOPE),
    });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) {
      const desc = body && (body.error_description || body.error) ? `${body.error}: ${body.error_description || ""}`.trim() : text.slice(0, 300);
      let hint = "";
      if (res.status === 401 || (body && body.error === "invalid_client")) {
        hint = ` — check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET, and that they are the ${this.env.toUpperCase()} keyset (sandbox and production keys are different).`;
      }
      throw new EbayError(`Token request failed (${res.status}) ${desc}${hint}`, { status: res.status, body, url });
    }
    if (!body || !body.access_token) throw new EbayError("Token response had no access_token", { status: res.status, body, url });
    const ttl = Number(body.expires_in || 7200) * 1000;
    this.token = { value: body.access_token, expiresAt: this.now() + ttl };
    return this.token.value;
  }

  /** Authenticated GET against the Browse API with retry + one 401 refresh. */
  async get(path, params = {}, { _retried401 = false, attempt = 0 } = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)))
      .join("&");
    const url = this.host + path + (qs ? "?" + qs : "");
    const token = await this.getToken();
    this.calls.api++;
    let res;
    try {
      res = await this.fetch(url, {
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json",
          "X-EBAY-C-MARKETPLACE-ID": this.marketplace,
        },
      });
    } catch (e) {
      if (attempt < this.retries) {
        const wait = 500 * 2 ** attempt;
        this.log(`network error (${e.message}); retry in ${wait}ms`);
        await this.sleep(wait);
        return this.get(path, params, { _retried401, attempt: attempt + 1 });
      }
      throw new EbayError("Network error calling eBay: " + e.message + " (is api.ebay.com reachable from here?)", { url });
    }
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { /* non-JSON */ }
    if (res.ok) return body;

    const err = body && body.errors && body.errors[0];
    const errorId = err ? err.errorId : undefined;
    const msg = err ? `${err.message}${err.longMessage ? " — " + err.longMessage : ""}` : text.slice(0, 300);

    if (res.status === 401 && !_retried401) {
      this.log("401 — refreshing token once");
      await this.getToken(true);
      return this.get(path, params, { _retried401: true, attempt });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
      const ra = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
      const wait = ra > 0 ? ra * 1000 : 1000 * 2 ** attempt;
      this.log(`${res.status} from eBay; retry in ${wait}ms`);
      await this.sleep(wait);
      return this.get(path, params, { _retried401, attempt: attempt + 1 });
    }
    let hint = "";
    if (res.status === 403) hint = " — 403 usually means this keyset isn't allowed to call this API here: in Production, the Browse API is open to all developers but the keyset must be a Production keyset; other Buy APIs need eBay approval.";
    if (res.status === 429) hint = " — you've hit the call limit (Browse API default is 5,000 calls/day per app). Lower compsPerQuery or run less often.";
    throw new EbayError(`eBay ${res.status}${errorId ? " [" + errorId + "]" : ""}: ${msg}${hint}`, { status: res.status, errorId, body, url });
  }

  /**
   * One page of item_summary/search.
   * @param {object} o  { q, limit (≤200), offset, sort, categoryIds, filter (string or object for buildFilter), fieldgroups }
   * @returns {{ total:number, items:object[], raw:object, next:boolean }}
   */
  async search(o = {}) {
    const filter = typeof o.filter === "string" ? o.filter : buildFilter(o.filter || {});
    const raw = await this.get("/buy/browse/v1/item_summary/search", {
      q: o.q,
      category_ids: o.categoryIds,
      filter: filter || undefined,
      sort: o.sort,
      limit: Math.min(Math.max(Number(o.limit) || 50, 1), 200),
      offset: o.offset || 0,
      fieldgroups: o.fieldgroups,
      auto_correct: o.autoCorrect === false ? undefined : "KEYWORD",
    });
    const items = (raw.itemSummaries || []).map(summarise);
    return { total: Number(raw.total) || 0, items, raw, next: !!raw.next };
  }

  /** Page through search results up to `max` items (default 200) — mind the call budget. */
  async searchAll(o = {}, max = 200) {
    const out = [];
    let offset = o.offset || 0, total = Infinity;
    const pageSize = Math.min(Number(o.limit) || 50, 200);
    while (out.length < max && offset < total) {
      const page = await this.search({ ...o, limit: Math.min(pageSize, max - out.length), offset });
      total = page.total;
      out.push(...page.items);
      if (!page.items.length || !page.next) break;
      offset += page.items.length;
    }
    return { total: total === Infinity ? out.length : total, items: out };
  }

  /** Full item by Browse id (v1|123|0). */
  async getItem(itemId) {
    return this.get("/buy/browse/v1/item/" + encodeURIComponent(itemId));
  }

  /** Full item by the numeric id in an ebay.* URL. */
  async getItemByLegacyId(legacyItemId) {
    return this.get("/buy/browse/v1/item/get_item_by_legacy_id", { legacy_item_id: legacyItemId });
  }

  /**
   * Is a listing still live? Returns { live, endsAt, price, url, status } where status is one of
   * "active" | "ended" | "gone" (404 — sold, removed, or expired past retention).
   */
  async itemStatus(idOrUrl) {
    const legacy = legacyIdFromUrl(idOrUrl) || (/^\d{9,15}$/.test(String(idOrUrl)) ? String(idOrUrl) : null);
    try {
      const it = legacy ? await this.getItemByLegacyId(legacy) : await this.getItem(idOrUrl);
      const endsAt = it.itemEndDate ? Date.parse(it.itemEndDate) : NaN;
      const avail = it.estimatedAvailabilities && it.estimatedAvailabilities[0];
      const outOfStock = avail && avail.estimatedAvailabilityStatus === "OUT_OF_STOCK";
      const ended = (isFinite(endsAt) && endsAt < this.now()) || !!outOfStock;
      return {
        live: !ended, status: ended ? "ended" : "active",
        endsAt: it.itemEndDate || "", price: it.price ? Number(it.price.value) : NaN,
        currency: it.price ? it.price.currency : "", url: it.itemWebUrl || "", title: it.title || "",
      };
    } catch (e) {
      if (e instanceof EbayError && e.status === 404) return { live: false, status: "gone", endsAt: "", price: NaN, url: "", title: "" };
      throw e;
    }
  }
}

/** Build a client from process.env (after loadEnv). EBAY_ENV=sandbox switches hosts. */
export function clientFromEnv(env = process.env, extra = {}) {
  return new EbayClient({
    clientId: env.EBAY_CLIENT_ID,
    clientSecret: env.EBAY_CLIENT_SECRET,
    env: (env.EBAY_ENV || "production").toLowerCase(),
    marketplace: env.EBAY_MARKETPLACE || "EBAY_IE",
    ...extra,
  });
}
