import { test } from "node:test";
import assert from "node:assert/strict";
import { EbayClient, EbayError, buildFilter, legacyIdFromUrl, summarise, HOSTS, SCOPE, clientFromEnv } from "../ebay.mjs";
import { fakeFetch, makeItem } from "./fake-ebay.mjs";

const creds = { clientId: "app-id", clientSecret: "cert-id" };
const noSleep = async () => {};

test("buildFilter produces eBay's filter syntax", () => {
  assert.equal(buildFilter({ priceMin: 10, priceMax: 500 }), "price:[10..500],priceCurrency:EUR");
  assert.equal(buildFilter({ priceMax: 50, currency: "GBP" }), "price:[..50],priceCurrency:GBP");
  assert.equal(buildFilter({ conditions: ["USED", "NEW"], buyingOptions: ["FIXED_PRICE"], deliveryCountry: "IE" }),
    "conditions:{USED|NEW},buyingOptions:{FIXED_PRICE},deliveryCountry:IE");
  assert.equal(buildFilter({}), "");
});

test("legacyIdFromUrl handles the URL shapes eBay uses", () => {
  assert.equal(legacyIdFromUrl("https://www.ebay.ie/itm/123456789012"), "123456789012");
  assert.equal(legacyIdFromUrl("https://www.ebay.co.uk/itm/Boss-DS-1-pedal/123456789012?hash=abc"), "123456789012");
  assert.equal(legacyIdFromUrl("https://www.ebay.com/itm/123456789012?_trkparms=x"), "123456789012");
  assert.equal(legacyIdFromUrl("v1|123456789012|0"), "123456789012");
  assert.equal(legacyIdFromUrl("not a url"), null);
});

test("summarise flattens an itemSummary and computes landed price", () => {
  const s = summarise(makeItem(1, { price: 40, shipping: 5.5 }));
  assert.equal(s.price, 40); assert.equal(s.shipping, 5.5); assert.equal(s.landed, 45.5);
  assert.equal(s.legacyItemId, "100000000001"); assert.equal(s.location, "IE");
  const noShip = summarise(makeItem(2, { price: 40, shipping: null }));
  assert.equal(noShip.shipping, null); assert.equal(noShip.landed, 40);
});

test("token: minted once with the right request, cached, refreshed near expiry", async () => {
  let t = 1_000_000;
  const fetch = fakeFetch({ tokenTtl: 7200 });
  const c = new EbayClient({ ...creds, fetch, now: () => t, sleep: noSleep });
  assert.equal(c.host, HOSTS.production);
  const tok = await c.getToken();
  assert.equal(tok, "tok-1");
  const req = fetch.calls[0];
  assert.equal(req.url, "https://api.ebay.com/identity/v1/oauth2/token");
  assert.equal(req.init.headers.Authorization, "Basic " + Buffer.from("app-id:cert-id").toString("base64"));
  assert.equal(req.init.body, "grant_type=client_credentials&scope=" + encodeURIComponent(SCOPE));
  assert.equal(await c.getToken(), "tok-1", "cached");
  t += 7200 * 1000 - 30_000; // 30s before expiry → refresh
  assert.equal(await c.getToken(), "tok-2");
  assert.equal(c.calls.token, 2);
});

test("sandbox env uses the sandbox host for both token and API", async () => {
  const fetch = fakeFetch({ items: [makeItem(1, { price: 10 })] });
  const c = new EbayClient({ ...creds, env: "sandbox", fetch, sleep: noSleep });
  await c.search({ q: "x" });
  assert.ok(fetch.calls[0].url.startsWith("https://api.sandbox.ebay.com/identity"));
  assert.ok(fetch.calls[1].url.startsWith("https://api.sandbox.ebay.com/buy/browse/v1/item_summary/search?"));
});

test("bad credentials give a readable error naming the env vars", async () => {
  const c = new EbayClient({ ...creds, fetch: fakeFetch({ badSecret: true }), sleep: noSleep });
  await assert.rejects(c.getToken(), (e) => e instanceof EbayError && e.status === 401 && /EBAY_CLIENT_SECRET/.test(e.message) && /PRODUCTION keyset/.test(e.message));
});

test("search sends marketplace header, params and filter; parses total + items", async () => {
  const fetch = fakeFetch({ items: [makeItem(1, { price: 30, shipping: 4 }), makeItem(2, { price: 50 })] });
  const c = new EbayClient({ ...creds, fetch, marketplace: "EBAY_GB", sleep: noSleep });
  const r = await c.search({ q: "Boss DS-1", limit: 500, filter: { conditions: ["USED"], deliveryCountry: "IE" }, sort: "price" });
  const req = fetch.calls[1];
  const u = new URL(req.url);
  assert.equal(req.init.headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_GB");
  assert.equal(req.init.headers.Authorization, "Bearer tok-1");
  assert.equal(u.searchParams.get("q"), "Boss DS-1");
  assert.equal(u.searchParams.get("limit"), "200", "clamped to eBay max");
  assert.equal(u.searchParams.get("filter"), "conditions:{USED},deliveryCountry:IE");
  assert.equal(u.searchParams.get("sort"), "price");
  assert.equal(u.searchParams.get("auto_correct"), "KEYWORD");
  assert.equal(r.total, 2); assert.equal(r.items.length, 2); assert.equal(r.items[0].landed, 34);
});

test("searchAll pages through results up to max, following next", async () => {
  const items = Array.from({ length: 130 }, (_, i) => makeItem(i, { price: 10 + i }));
  const fetch = fakeFetch({ items });
  const c = new EbayClient({ ...creds, fetch, sleep: noSleep });
  const r = await c.searchAll({ q: "x", limit: 50 }, 120);
  assert.equal(r.total, 130); assert.equal(r.items.length, 120);
  assert.equal(c.calls.api, 3, "50 + 50 + 20");
  assert.equal(new URL(fetch.calls[3].url).searchParams.get("offset"), "100");
  assert.equal(new URL(fetch.calls[3].url).searchParams.get("limit"), "20");
});

test("401 on an API call refreshes the token once and retries", async () => {
  const fetch = fakeFetch({ items: [makeItem(1, { price: 1 })], rejectToken: "tok-1" });
  const c = new EbayClient({ ...creds, fetch, sleep: noSleep });
  const r = await c.search({ q: "x" });
  assert.equal(r.items.length, 1);
  assert.equal(c.calls.token, 2); assert.equal(c.calls.api, 2);
});

test("429 / 5xx retry with backoff then succeed; honour Retry-After", async () => {
  const waits = [];
  const fetch = fakeFetch({ items: [makeItem(1, { price: 1 })] });
  fetch.calls; // touch
  const script = [
    { status: 429, body: { errors: [{ errorId: 2001, message: "Too many requests" }] }, headers: { "retry-after": "2" } },
    { status: 503, body: "Service Unavailable" },
  ];
  const c = new EbayClient({ ...creds, fetch: fakeFetch({ items: [makeItem(1, { price: 1 })], script }), sleep: async (ms) => { waits.push(ms); } });
  const r = await c.search({ q: "x" });
  assert.equal(r.items.length, 1);
  assert.deepEqual(waits, [2000, 2000], "retry-after=2s, then 1000*2^1 backoff");
  assert.equal(c.calls.api, 3);
});

test("persistent 429 gives up with the call-limit hint", async () => {
  const script = Array.from({ length: 4 }, () => ({ status: 429, body: { errors: [{ errorId: 2001, message: "Too many requests" }] } }));
  const c = new EbayClient({ ...creds, fetch: fakeFetch({ script }), sleep: noSleep });
  await assert.rejects(c.search({ q: "x" }), (e) => e.status === 429 && e.errorId === 2001 && /5,000 calls\/day/.test(e.message));
});

test("403 explains the keyset/approval situation", async () => {
  const script = [{ status: 403, body: { errors: [{ errorId: 1100, message: "Access denied", longMessage: "Insufficient permissions to fulfill the request." }] } }];
  const c = new EbayClient({ ...creds, fetch: fakeFetch({ script }), sleep: noSleep });
  await assert.rejects(c.search({ q: "x" }), (e) => e.status === 403 && /Insufficient permissions/.test(e.message) && /Production keyset/.test(e.message));
});

test("network errors retry then surface a reachability hint", async () => {
  let n = 0;
  const c = new EbayClient({ ...creds, retries: 1, sleep: noSleep, fetch: async (url, init) => {
    if (url.includes("oauth2/token")) return fakeFetch()(url, init);
    n++; throw new Error("ECONNRESET");
  } });
  await assert.rejects(c.search({ q: "x" }), /reachable/);
  assert.equal(n, 2);
});

test("itemStatus: active, ended by date, gone on 404, by URL or id", async () => {
  const items = [makeItem(1, { price: 20, legacy: "111111111111" }), makeItem(2, { price: 20, legacy: "222222222222", endsAt: "2020-01-01T00:00:00.000Z" })];
  const c = new EbayClient({ ...creds, fetch: fakeFetch({ items }), sleep: noSleep });
  assert.equal((await c.itemStatus("https://www.ebay.ie/itm/111111111111")).status, "active");
  assert.equal((await c.itemStatus("222222222222")).status, "ended");
  assert.equal((await c.itemStatus("https://www.ebay.ie/itm/333333333333")).status, "gone");
  assert.equal((await c.itemStatus("v1|111111111111|0")).status, "active");
});

test("clientFromEnv reads EBAY_* and rejects missing keys", () => {
  const c = clientFromEnv({ EBAY_CLIENT_ID: "a", EBAY_CLIENT_SECRET: "b", EBAY_ENV: "Sandbox", EBAY_MARKETPLACE: "EBAY_GB" }, { fetch: fakeFetch() });
  assert.equal(c.env, "sandbox"); assert.equal(c.marketplace, "EBAY_GB");
  assert.throws(() => clientFromEnv({}, { fetch: fakeFetch() }), /EBAY_CLIENT_ID/);
});
