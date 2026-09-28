import { test } from "node:test";
import assert from "node:assert/strict";
import { findCandidates, flipEconomics, importTax, typoQueries, runScan, DEFAULT_CONFIG } from "../scan.mjs";
import { EbayClient, summarise } from "../ebay.mjs";
import { fakeFetch, makeItem } from "./fake-ebay.mjs";

const cfg = { ...DEFAULT_CONFIG, niche: "trade-parts", cheapBandLimit: 0 };
const L = (i, price, { loc = "IE", shipping = 0, title, postcode, auction, bids } = {}) => {
  const it = makeItem(i, { price, shipping, title: title || "Vaillant fan 193593 #" + i });
  it.itemLocation = { country: loc, ...(postcode ? { postalCode: postcode } : {}) };
  if (auction) { it.buyingOptions = ["AUCTION"]; it.currentBidPrice = it.price; delete it.price; it.bidCount = bids || 0; it.itemEndDate = "2026-09-29T18:00:00.000Z"; }
  return summarise(it);
};

test("flipEconomics: resale after 13% + €0.35 fees, postage and packaging; ceiling clears €15 and 30% ROI", () => {
  const e = flipEconomics(100, cfg);
  assert.equal(e.postage, 8, "falls back to assumedPostage.home");
  assert.equal(Math.round(e.proceeds * 100) / 100, 77.65);
  assert.equal(Math.round(e.maxCost * 100) / 100, 59.73, "ROI binds: 77.65 / 1.3");
  assert.equal(flipEconomics(40, cfg).maxCost < 15, true, "a €40 item leaves almost nothing");
  assert.equal(flipEconomics(100, { ...cfg, sellPostage: 12 }).postage, 12);
});

test("importTax: 23% on non-EU origins (GB included), none from the EU, Northern Ireland or an unknown origin", () => {
  assert.equal(importTax(L(1, 100, { loc: "GB" }), cfg), 23);
  assert.equal(importTax(L(1, 100, { loc: "US" }), cfg), 23);
  assert.equal(importTax(L(1, 100, { loc: "GB", postcode: "BT7***" }), cfg), 0);
  assert.equal(importTax(L(1, 100, { loc: "DE" }), cfg), 0);
  assert.equal(importTax(L(1, 100, { loc: "IE" }), cfg), 0);
  assert.equal(importTax(L(1, 100, { loc: "" }), cfg), 0);
});

test("regression: the GB Vaillant fan that Discover showed at '59% under' is not a deal", () => {
  // 27 Sep 2026: €21.44 + €9.16 postage from GB, against a ~€79 median asking.
  const comps = [75, 79, 79, 82, 85, 70, 90].map((p, i) => L(i + 1, p, { loc: "GB" }));
  const fan = L(20, 21.44, { loc: "GB", shipping: 9.16 });
  assert.deepEqual(findCandidates("Vaillant fan", comps.concat(fan), cfg), [],
    "worth ~€47 (0.6 × €79), nets ~€32 after fees and postage; costs €37.64 with VAT");
});

test("a real deal passes, with net profit, ROI and the all-in price Scout uses", () => {
  const comps = [200, 190, 210, 205, 195, 200].map((p, i) => L(i + 1, p, { title: "Focusrite Scarlett 2i2 #" + i }));
  const deal = L(9, 50, { title: "Focusrite Scarlett 2i2 interface" });
  const [c, ...rest] = findCandidates("Focusrite Scarlett 2i2", comps.concat(deal), cfg, 1);
  assert.equal(rest.length, 0);
  assert.equal(c.price, 50); assert.equal(c.estResale, 120); assert.equal(c.estBasis, "asking-x0.6");
  assert.equal(c.netProfit, 45); assert.equal(c.roi, 90); assert.equal(c.targetBuy, 73);
  assert.match(c.reasoning, /Worth ~€120 \(60% of the €200 median asking\).*~€45 profit \(90% ROI\) on €50 all-in/);
});

test("VAT is added to the price for a GB listing, and can tip it out", () => {
  const comps = [200, 190, 210, 205, 195, 200].map((p, i) => L(i + 1, p, { title: "Focusrite Scarlett 2i2 #" + i }));
  const gb = L(9, 50, { loc: "GB", title: "Focusrite Scarlett 2i2 interface" });
  const [c] = findCandidates("Focusrite Scarlett 2i2", comps.concat(gb), cfg);
  assert.equal(c.price, 61.5); assert.match(c.reasoning, /\+€12 import VAT \(ships from GB\)/);
  const gb2 = L(10, 62, { loc: "GB", title: "Focusrite Scarlett 2i2 interface" });
  assert.equal(findCandidates("Focusrite Scarlett 2i2", comps.concat(gb2), cfg).length, 0, "€62 × 1.23 = €76 > €73 ceiling");
});

test("verified sold prices set the value; the market's targetBuy caps the ceiling", () => {
  const comps = [150, 140, 160, 155, 145, 150].map((p, i) => L(i + 1, p, { title: "Focusrite Scarlett 2i2 #" + i }));
  const deal = L(9, 55, { title: "Focusrite Scarlett 2i2 interface" });
  const market = { "Focusrite Scarlett 2i2": { estSold: 97, targetBuy: 49, basis: "verified" } };
  assert.equal(findCandidates("Focusrite Scarlett 2i2", comps.concat(deal), cfg, 1, [], market).length, 0, "€55 > €49 targetBuy");
  const [c] = findCandidates("Focusrite Scarlett 2i2", comps.concat(L(10, 45, { title: "Focusrite Scarlett 2i2 box" })), cfg, 1, [], market);
  assert.equal(c.estResale, 97); assert.equal(c.estBasis, "verified-sales"); assert.equal(c.targetBuy, 49);
});

test("auctions: a low current bid is not floored out, and comes with a max bid", () => {
  const comps = [200, 190, 210, 205, 195, 200].map((p, i) => L(i + 1, p, { title: "Focusrite Scarlett 2i2 #" + i }));
  const au = L(9, 20, { title: "Focusrite Scarlett 2i2 interface", shipping: 5, auction: true, bids: 2 });
  assert.equal(au.price, 20, "summarise reads currentBidPrice");
  const [c] = findCandidates("Focusrite Scarlett 2i2", comps, cfg, 1, [au]);
  assert.equal(c.auction, true); assert.equal(c.maxBid, 68, "€73.12 ceiling − €5 postage"); assert.equal(c.bidCount, 2);
  assert.match(c.reasoning, /^Auction, 2 bids, ends 2026-09-29 18:00 UTC: current bid €20 .*Bid up to €68/);
  const gb = L(10, 20, { title: "Focusrite Scarlett 2i2 interface", shipping: 5, auction: true, loc: "GB" });
  assert.equal(findCandidates("Focusrite Scarlett 2i2", comps, cfg, 1, [gb])[0].maxBid, 54, "€73.12 / 1.23 − €5");
});

test("typoQueries swaps whole words only", () => {
  const t = { Vaillant: ["Vailant", "Valliant"], Scarlett: ["Scarlet"] };
  assert.deepEqual(typoQueries("Vaillant 0020132764", t), ["Vailant 0020132764", "Valliant 0020132764"]);
  assert.deepEqual(typoQueries("Focusrite Scarlett 2i2", t), ["Focusrite Scarlet 2i2"]);
  assert.deepEqual(typoQueries("Boss DS-1", t), []);
  assert.deepEqual(typoQueries("Vaillantx fan", t), []);
});

test("a misspelled listing is matched against the typo and valued against the real product", () => {
  const comps = [200, 190, 210, 205, 195, 200].map((p, i) => L(i + 1, p, { title: "Focusrite Scarlett 2i2 #" + i }));
  const typo = { ...L(9, 50, { title: "Focusrite Scarlet 2i2 audio interface" }), matchQuery: "Focusrite Scarlet 2i2" };
  const [c] = findCandidates("Focusrite Scarlett 2i2", comps, cfg, 1, [typo]);
  assert.equal(c.typo, "Focusrite Scarlet 2i2"); assert.equal(c.estResale, 120);
  assert.match(c.reasoning, /^Misspelled title/);
  assert.equal(findCandidates("Focusrite Scarlett 2i2", comps, cfg, 1, [{ ...typo, matchQuery: undefined }]).length, 0, "without the tag it fails the query-word gate");
});

test("runScan asks eBay for auctions ending soon and for typos with auto-correct off", async () => {
  const items = [1, 2, 3, 4, 5, 6].map((i) => makeItem(i, { price: 100, title: "Vaillant fan #" + i }));
  const fetch = fakeFetch({ items });
  const client = new EbayClient({ clientId: "a", clientSecret: "b", fetch, sleep: async () => {} });
  const now = Date.parse("2026-09-28T06:00:00Z");
  await runScan(client, { ...cfg, queries: ["Vaillant fan"], typos: { Vaillant: ["Vailant"] }, compsPerQuery: 40 }, { log: () => {}, now: () => now });
  const urls = fetch.calls.map((c) => c.url).filter((u) => u.includes("item_summary")).map((u) => new URL(u));
  assert.equal(urls.length, 3, "comps, auctions, one typo (cheap band off)");
  const au = urls[1];
  assert.equal(au.searchParams.get("sort"), "endingSoonest");
  assert.match(au.searchParams.get("filter"), /buyingOptions:\{AUCTION\}.*itemEndDate:\[\.\.2026-09-29T06:00:00\.000Z\]/);
  const ty = urls[2];
  assert.equal(ty.searchParams.get("q"), "Vailant fan"); assert.equal(ty.searchParams.get("auto_correct"), null);
  assert.match(ty.searchParams.get("filter"), /buyingOptions:\{FIXED_PRICE\|AUCTION\}/);
  assert.equal(urls[0].searchParams.get("auto_correct"), "KEYWORD", "the main search still auto-corrects");
});
