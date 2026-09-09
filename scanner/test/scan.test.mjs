import { test } from "node:test";
import assert from "node:assert/strict";
import { findCandidates, median, runScan, resolveConfig, DEFAULT_CONFIG } from "../scan.mjs";
import { EbayClient, summarise } from "../ebay.mjs";
import { fakeFetch, makeItem } from "./fake-ebay.mjs";
import { parseEnv, parseArgs } from "../env.mjs";

const cfg = { ...DEFAULT_CONFIG, niche: "music-gear", discount: 0.3, minMarginEur: 15, maxPerQuery: 3, minComps: 5 };
const L = (i, price, extra = {}) => summarise(makeItem(i, { price, ...extra }));

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("findCandidates flags listings well under the median landed price", () => {
  const listings = [L(1, 100), L(2, 95), L(3, 105), L(4, 110), L(5, 100), L(6, 60), L(7, 90)];
  const out = findCandidates("Boss DS-1", listings, cfg, 123);
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.price, 60); assert.equal(c.estResale, 100); assert.equal(c.soldQuery, "Boss DS-1");
  assert.equal(c.category, "music-gear"); assert.equal(c.status, "new"); assert.equal(c.foundAt, 123);
  assert.equal(c.id, "ebay-100000000006"); assert.match(c.reasoning, /40% under the €100 median/);
});

test("postage counts: a cheap item with dear postage is not a deal", () => {
  const listings = [L(1, 100), L(2, 100), L(3, 100), L(4, 100), L(5, 100), L(6, 60, { shipping: 35 })];
  assert.equal(findCandidates("x", listings, cfg).length, 0);
  const deal = [...listings.slice(0, 5), L(7, 55, { shipping: 5 })];
  const out = findCandidates("x", deal, cfg);
  assert.equal(out.length, 1); assert.equal(out[0].price, 60); assert.match(out[0].reasoning, /incl. €5.00 postage/);
});

test("too few comps → no candidates; broken/parts listings excluded from comps", () => {
  assert.equal(findCandidates("x", [L(1, 100), L(2, 100), L(3, 10)], cfg).length, 0);
  const listings = [L(1, 100), L(2, 100), L(3, 100), L(4, 100), L(5, 100), L(6, 20, { title: "Boss DS-1 for parts not working" })];
  assert.equal(findCandidates("x", listings, cfg).length, 0, "the parts listing is dropped, not flagged");
});

test("minMarginEur stops tiny absolute gaps on cheap items; maxPerQuery caps", () => {
  const cheap = [L(1, 20), L(2, 20), L(3, 20), L(4, 20), L(5, 20), L(6, 10)];
  assert.equal(findCandidates("x", cheap, cfg).length, 0, "50% under but only €10 gap");
  const many = [L(1, 100), L(2, 100), L(3, 100), L(4, 100), L(5, 100), L(6, 50), L(7, 40), L(8, 30), L(9, 20)];
  const out = findCandidates("x", many, cfg);
  assert.equal(out.length, 3); assert.equal(out[0].price, 20, "biggest gap first");
});

test("runScan end-to-end against the fake API writes the discovery schema", async () => {
  const items = [makeItem(1, { price: 100 }), makeItem(2, { price: 100 }), makeItem(3, { price: 100 }), makeItem(4, { price: 110 }), makeItem(5, { price: 90 }), makeItem(6, { price: 55 })];
  const fetch = fakeFetch({ items });
  const client = new EbayClient({ clientId: "a", clientSecret: "b", fetch, sleep: async () => {} });
  const logs = [];
  const { results, stats } = await runScan(client, { ...cfg, queries: ["Boss DS-1", "Zoom H4n"], compsPerQuery: 40, deliveryCountry: "IE" }, { log: (m) => logs.push(m), now: () => 5 });
  assert.equal(stats.queries, 2); assert.equal(stats.errors, 0); assert.equal(results.length, 2);
  for (const r of results) for (const k of ["title", "price", "estResale", "cond", "soldQuery", "category", "source", "reasoning", "foundAt", "status", "url"]) assert.ok(k in r, "missing " + k);
  const u = new URL(fetch.calls[1].url);
  assert.equal(u.searchParams.get("filter"), "conditions:{USED},buyingOptions:{FIXED_PRICE},deliveryCountry:IE");
  assert.equal(u.searchParams.get("sort"), "price");
  assert.equal(client.calls.api, 2, "one call per query when comps fit in a page");
});

test("runScan keeps going when one query fails", async () => {
  const script = [{ status: 500, body: "boom" }, { status: 500, body: "boom" }, { status: 500, body: "boom" }, { status: 500, body: "boom" }];
  const items = [makeItem(1, { price: 100 }), makeItem(2, { price: 100 }), makeItem(3, { price: 100 }), makeItem(4, { price: 100 }), makeItem(5, { price: 100 }), makeItem(6, { price: 50 })];
  const client = new EbayClient({ clientId: "a", clientSecret: "b", fetch: fakeFetch({ items, script }), sleep: async () => {} });
  const { results, stats } = await runScan(client, { ...cfg, queries: ["bad", "good"] }, { log: () => {} });
  assert.equal(stats.errors, 1); assert.equal(results.length, 1);
});

test("resolveConfig: CLI overrides, env marketplace, repeated --q", () => {
  const c = resolveConfig(parseArgs(["--q", "Boss DS-1", "--q", "Zoom H4n", "--niche", "books", "--discount", "0.4"]), { EBAY_MARKETPLACE: "EBAY_GB" });
  assert.deepEqual(c.queries, ["Boss DS-1", "Zoom H4n"]); assert.equal(c.niche, "books"); assert.equal(c.discount, 0.4); assert.equal(c.marketplace, "EBAY_GB");
});

test("parseEnv / parseArgs basics", () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="two words"\nexport C=3 # trailing\n\nbad\n'), { A: "1", B: "two words", C: "3" });
  assert.deepEqual(parseArgs(["--dry-run", "--out=x.json", "pos", "--sandbox"]), { _: ["pos"], "dry-run": true, out: "x.json", sandbox: true });
});
