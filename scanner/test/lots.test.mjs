import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogue, parseContents, quantityNear, valueLot, stripHtml, isLotTitle, runLots, accessoryOnly, LOT_DEFAULTS } from "../lots.mjs";
import { EbayClient, summarise } from "../ebay.mjs";
import { fakeFetch, makeItem } from "./fake-ebay.mjs";

const market = {
  "Boss DS-1": { medianAsk: 80, estSold: null, basis: "proxy" },
  "Shure SM58": { medianAsk: 143, estSold: 56, basis: "verified" },
  "Focusrite Scarlett 2i2": { medianAsk: 167, estSold: null, basis: "proxy" },
  "Focusrite Scarlett 2i2 3rd Gen": { medianAsk: 166, estSold: 97, basis: "verified" },
  "Vaillant ecoTEC PCB": { medianAsk: 72, estSold: 42, basis: "verified" },
  "Vaillant ecoTEC board": { medianAsk: 101, estSold: 42, basis: "verified" },
  "Vaillant 0010028086": { medianAsk: null, estSold: 106, basis: "verified" },
  "Vaillant diverter valve": { medianAsk: 54, estSold: null, basis: "proxy" },
  "Empty": { medianAsk: null, estSold: null, basis: "proxy" },
};
const cat = catalogue(market);

test("catalogue: verified/tracked prices as-is, otherwise 60% of asking; unpriced searches dropped", () => {
  assert.deepEqual(cat["Shure SM58"], { est: 56, basis: "verified" });
  assert.deepEqual(cat["Boss DS-1"], { est: 48, basis: "asking×0.6" });
  assert.ok(!("Empty" in cat));
});

test("quantityNear reads 2x / x2 / two, defaults to 1, 0 when absent", () => {
  assert.equal(quantityNear("2x Boss DS-1 pedals", "Boss DS-1"), 2);
  assert.equal(quantityNear("Boss DS1 x3 and more", "Boss DS-1"), 3);
  assert.equal(quantityNear("two Shure SM58 mics", "Shure SM58"), 2);
  assert.equal(quantityNear("Boss DS-1 pedal", "Boss DS-1"), 1);
  assert.equal(quantityNear("Boss DS-2 pedal", "Boss DS-1"), 0);
  assert.equal(quantityNear("50x Shure SM58", "Shure SM58"), LOT_DEFAULTS.maxQty, "capped");
});

test("parseContents counts items and prefers the specific entry over its generic twin", () => {
  const got = parseContents("Job lot: 2x Boss DS-1, Shure SM58, Focusrite Scarlett 2i2 3rd Gen", cat);
  const by = Object.fromEntries(got.map((g) => [g.q, g.qty]));
  assert.deepEqual(by, { "Boss DS-1": 2, "Shure SM58": 1, "Focusrite Scarlett 2i2 3rd Gen": 1 }, "generic 2i2 dropped in favour of 3rd Gen");
  const boards = parseContents("Vaillant ecoTEC PCB board 0010028086 plus spares", cat);
  assert.deepEqual(boards.map((b) => b.q), ["Vaillant 0010028086"], "part number beats the generic PCB/board twins");
  const twins = parseContents("Vaillant ecoTEC PCB board, working", cat);
  assert.equal(twins.length, 1, "PCB and board are the same thing — counted once");
});

test("an item named only as an accessory does not count", () => {
  assert.ok(accessoryOnly("Job Lot of 6 x SHURE SM58 Wharfedale Pro & Various HANDHELD MIC POUCH / CASE", "Shure SM58"));
  assert.ok(accessoryOnly("4 X Joblot Vaillant 3-Way Diverter Valve Motor Adaptor", "Vaillant diverter valve"));
  assert.ok(!accessoryOnly("Pedal lot\nBoss DS-1 with case\nShure SM58, boxed", "Shure SM58"));
  assert.ok(!accessoryOnly("Pedal lot\nBoss DS-1 with case\nShure SM58 pouch\nanother Shure SM58 working", "Shure SM58"), "one real mention is enough");
  assert.deepEqual(parseContents("Job Lot of 6 x SHURE SM58 mic pouches", cat), []);
  const v = valueLot({ title: "4 X Joblot Vaillant 3-Way Diverter Valve Motor Adaptor", description: "", price: 60, landed: 62, legacyItemId: "9", itemId: "v1|9|0" }, cat, { ...LOT_DEFAULTS, niche: "trade-parts" });
  assert.equal(v.candidate, null); assert.equal(v.value, 0);
});

test("valueLot flags a lot priced well under its recognised contents, and only those", () => {
  const lot = { title: "Pedal job lot", description: "Includes 2x Boss DS-1, a Shure SM58 and a mystery fuzz", price: 60, shipping: 10, landed: 70, url: "u", legacyItemId: "1", itemId: "v1|1|0", buyingOptions: ["FIXED_PRICE"], location: "IE" };
  const v = valueLot(lot, cat, { ...LOT_DEFAULTS, niche: "music-gear" }, 5);
  assert.equal(v.value, 2 * 48 + 56);
  assert.ok(v.candidate); const c = v.candidate;
  assert.equal(c.id, "ebay-1"); assert.equal(c.price, 70); assert.equal(c.estResale, 152); assert.equal(c.lot, true); assert.equal(c.estBasis, "lot-contents");
  assert.equal(c.soldQuery, "Boss DS-1", "the biggest slice of the value");
  assert.match(c.reasoning, /2× Boss DS-1 \(~€48 est\.\), 1× Shure SM58 \(~€56 verified\)/); assert.match(c.reasoning, /not counted/);
  // 70 > 60% of 100 → no
  assert.equal(valueLot({ ...lot, description: "Includes Boss DS-1 and Shure SM58" }, cat, LOT_DEFAULTS).candidate, null);
  // nothing recognised → no, but still reviewable
  const r = valueLot({ ...lot, description: "mystery pedals" }, cat, LOT_DEFAULTS);
  assert.equal(r.candidate, null); assert.equal(r.value, 0);
  // parts lots are skipped entirely
  assert.equal(valueLot({ ...lot, title: "Pedal job lot spares or repair" }, cat, LOT_DEFAULTS), null);
});

test("auction lots say so", () => {
  const lot = { title: "Boss DS-1 x2 Shure SM58 bundle", description: "", price: 20, shipping: 5, landed: 25, legacyItemId: "2", itemId: "v1|2|0", buyingOptions: ["AUCTION"], endsAt: "2026-09-20T10:00:00Z" };
  assert.match(valueLot(lot, cat, LOT_DEFAULTS).candidate.reasoning, /Auction, current bid €20, ends 2026-09-20/);
});

test("stripHtml and isLotTitle", () => {
  assert.equal(stripHtml("<p>2x <b>Boss</b> DS-1</p><br>Shure&nbsp;SM58"), "2x Boss DS-1\nShure SM58");
  assert.ok(isLotTitle("Guitar pedal JOB LOT")); assert.ok(isLotTitle("Boss pedals x3")); assert.ok(!isLotTitle("Boss DS-1 distortion"));
});

test("runLots: searches, keeps lot-looking titles, reads descriptions, values them", async () => {
  const items = [
    { ...makeItem(1, { price: 60, shipping: 10, title: "Guitar pedal job lot" }), description: "<ul><li>2x Boss DS-1</li><li>Shure SM58</li></ul>" },
    makeItem(2, { price: 60, title: "Boss DS-1 distortion pedal" }),                              // not a lot
    { ...makeItem(3, { price: 200, title: "Pedal bundle" }), description: "Boss DS-1 and a tuner" }, // too dear
  ];
  const client = new EbayClient({ clientId: "a", clientSecret: "b", fetch: fakeFetch({ items }) });
  const { results, review, stats } = await runLots(client, { ...LOT_DEFAULTS, niche: "music-gear", lotSearches: ["pedal job lot"], marketplace: "EBAY_IE" }, cat, { log: () => {}, now: () => 9 });
  assert.equal(stats.lots, 2); assert.equal(stats.detailed, 2);
  assert.equal(results.length, 1); assert.equal(results[0].id, "ebay-100000000001"); assert.equal(results[0].estResale, 152); assert.equal(results[0].foundAt, 9);
  assert.equal(review.length, 2);
});
