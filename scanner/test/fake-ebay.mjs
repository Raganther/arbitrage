/* A fake eBay: enough of the token + Browse endpoints to test the client offline. */
export function makeItem(i, { price, shipping = 0, cond = "Used", title, legacy, endsAt } = {}) {
  const id = legacy || String(100000000000 + i);
  return {
    itemId: `v1|${id}|0`, legacyItemId: id, title: title || `Item ${i}`,
    price: { value: String(price), currency: "EUR" }, condition: cond, conditionId: cond === "New" ? "1000" : "3000",
    itemWebUrl: `https://www.ebay.ie/itm/${id}`, itemLocation: { country: "IE" },
    shippingOptions: shipping == null ? undefined : [{ shippingCostType: "FIXED", shippingCost: { value: String(shipping), currency: "EUR" } }],
    buyingOptions: ["FIXED_PRICE"], itemEndDate: endsAt || "2099-01-01T00:00:00.000Z",
    seller: { username: "s" + i, feedbackPercentage: "99.5", feedbackScore: 120 },
  };
}

function res(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => text, json: async () => JSON.parse(text) };
}

/**
 * opts.items: array of itemSummaries returned by search (paged by limit/offset)
 * opts.script: optional array of responses to return in order for API calls (overrides items)
 * opts.tokenTtl, opts.badSecret
 */
export function fakeFetch(opts = {}) {
  const calls = [];
  let tokenN = 0;
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname.endsWith("/oauth2/token")) {
      const auth = init.headers.Authorization || "";
      if (opts.badSecret) return res(401, { error: "invalid_client", error_description: "client authentication failed" });
      if (!auth.startsWith("Basic ")) return res(400, { error: "invalid_request" });
      if (!/grant_type=client_credentials/.test(init.body) || !/scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope/.test(init.body)) return res(400, { error: "invalid_scope", error_description: "bad body: " + init.body });
      tokenN++;
      return res(200, { access_token: "tok-" + tokenN, expires_in: opts.tokenTtl || 7200, token_type: "Application Access Token" });
    }
    const auth = init.headers.Authorization || "";
    if (opts.rejectToken && auth === "Bearer " + opts.rejectToken) return res(401, { errors: [{ errorId: 1001, domain: "OAuth", message: "Invalid access token" }] });
    if (!auth.startsWith("Bearer tok-")) return res(401, { errors: [{ errorId: 1001, message: "Invalid access token" }] });
    if (opts.script && opts.script.length) { const next = opts.script.shift(); return typeof next === "function" ? next(url, init) : res(next.status, next.body, next.headers); }
    if (u.pathname.endsWith("/item_summary/search")) {
      const limit = Number(u.searchParams.get("limit")) || 50, offset = Number(u.searchParams.get("offset")) || 0;
      const items = opts.items || [];
      const page = items.slice(offset, offset + limit);
      const body = { total: items.length, limit, offset, itemSummaries: page };
      if (offset + limit < items.length) body.next = url.replace(/offset=\d+/, "offset=" + (offset + limit));
      return res(200, body);
    }
    if (u.pathname.endsWith("/get_item_by_legacy_id")) {
      const id = u.searchParams.get("legacy_item_id");
      const it = (opts.items || []).find((x) => x.legacyItemId === id);
      return it ? res(200, it) : res(404, { errors: [{ errorId: 11001, message: "The specified item Id was not found." }] });
    }
    if (/\/item\/v1%7C/.test(u.pathname) || /\/item\/v1\|/.test(u.pathname)) {
      const id = decodeURIComponent(u.pathname.split("/item/")[1]);
      const it = (opts.items || []).find((x) => x.itemId === id);
      return it ? res(200, it) : res(404, { errors: [{ errorId: 11001, message: "The specified item Id was not found." }] });
    }
    return res(404, { errors: [{ message: "no such route " + u.pathname }] });
  };
  fn.calls = calls;
  fn.res = res;
  return fn;
}
