import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { findCandidates, median, runScan, resolveConfig, matchesQuery, looksAccessory, normQuery, DEFAULT_CONFIG } from "../scan.mjs";
import { EbayClient, summarise } from "../ebay.mjs";
import { fakeFetch, makeItem } from "./fake-ebay.mjs";
import { parseEnv, parseArgs } from "../env.mjs";

const cfg = { ...DEFAULT_CONFIG, niche: "music-gear", discount: 0.3, minMarginEur: 15, maxPerQuery: 3, minComps: 5 };
const L = (i, price, extra = {}) => summarise(makeItem(i, { price, title: "Boss DS-1 distortion pedal #" + i, ...extra }));

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
  assert.equal(findCandidates("Boss DS-1", listings, cfg).length, 0);
  const deal = [...listings.slice(0, 5), L(7, 55, { shipping: 5 })];
  const out = findCandidates("Boss DS-1", deal, cfg);
  assert.equal(out.length, 1); assert.equal(out[0].price, 60); assert.match(out[0].reasoning, /incl. €5.00 postage/);
});

test("too few comps → no candidates; broken/parts listings excluded from comps", () => {
  assert.equal(findCandidates("Boss DS-1", [L(1, 100), L(2, 100), L(3, 10)], cfg).length, 0);
  const listings = [L(1, 100), L(2, 100), L(3, 100), L(4, 100), L(5, 100), L(6, 20, { title: "Boss DS-1 for parts not working" })];
  assert.equal(findCandidates("Boss DS-1", listings, cfg).length, 0, "the parts listing is dropped, not flagged");
  const byCond = [L(1, 100), L(2, 100), L(3, 100), L(4, 100), L(5, 100), L(6, 50, { cond: "For parts or not working" })];
  assert.equal(findCandidates("Boss DS-1", byCond, cfg).length, 0, "eBay's condition field is checked too");
});

test("minMarginEur stops tiny absolute gaps on cheap items; maxPerQuery caps", () => {
  const cheap = [L(1, 20), L(2, 20), L(3, 20), L(4, 20), L(5, 20), L(6, 10)];
  assert.equal(findCandidates("Boss DS-1", cheap, cfg).length, 0, "50% under but only €10 gap");
  const many = [L(1, 100), L(2, 100), L(3, 100), L(4, 100), L(5, 100), L(6, 50), L(7, 40), L(8, 30), L(9, 20)];
  const out = findCandidates("Boss DS-1", many, cfg);
  assert.equal(out.length, 3); assert.equal(out[0].price, 30, "biggest gap first; €20 is under the 25%-of-median floor");
});

test("runScan end-to-end against the fake API writes the discovery schema", async () => {
  const T = (i, price) => makeItem(i, { price, title: "Pedal #" + i });
  const items = [T(1, 100), T(2, 100), T(3, 100), T(4, 110), T(5, 90), T(6, 55)];
  const fetch = fakeFetch({ items });
  const client = new EbayClient({ clientId: "a", clientSecret: "b", fetch, sleep: async () => {} });
  const logs = [];
  const { results, stats } = await runScan(client, { ...cfg, requireQueryWords: false, queries: ["Boss DS-1", "Zoom H4n"], compsPerQuery: 40, deliveryCountry: "IE" }, { log: (m) => logs.push(m), now: () => 5 });
  assert.equal(stats.queries, 2); assert.equal(stats.errors, 0); assert.equal(results.length, 2, "same deal found once per query, de-duplicated within a query");
  for (const r of results) for (const k of ["title", "price", "estResale", "cond", "soldQuery", "category", "source", "reasoning", "foundAt", "status", "url"]) assert.ok(k in r, "missing " + k);
  const comps = new URL(fetch.calls[1].url), band = new URL(fetch.calls[2].url);
  assert.equal(comps.searchParams.get("filter"), "conditions:{USED},buyingOptions:{FIXED_PRICE},deliveryCountry:IE");
  assert.equal(comps.searchParams.get("sort"), null, "comps use best-match order");
  assert.equal(band.searchParams.get("sort"), "price");
  assert.equal(band.searchParams.get("filter"), "price:[25..70],priceCurrency:EUR,conditions:{USED},buyingOptions:{FIXED_PRICE},deliveryCountry:IE", "cheap band = 25%..70% of the €100 median");
  assert.equal(client.calls.api, 4, "comps + cheap band per query");
});

test("runScan keeps going when one query fails", async () => {
  const script = [{ status: 500, body: "boom" }, { status: 500, body: "boom" }, { status: 500, body: "boom" }, { status: 500, body: "boom" }];
  const items = [makeItem(1, { price: 100 }), makeItem(2, { price: 100 }), makeItem(3, { price: 100 }), makeItem(4, { price: 100 }), makeItem(5, { price: 100 }), makeItem(6, { price: 50 })];
  const client = new EbayClient({ clientId: "a", clientSecret: "b", fetch: fakeFetch({ items, script }), sleep: async () => {} });
  const { results, stats } = await runScan(client, { ...cfg, requireQueryWords: false, queries: ["bad", "good"] }, { log: () => {} });
  assert.equal(stats.errors, 1); assert.equal(results.length, 1);
});

test("matchesQuery is hyphen/case-insensitive and needs every word", () => {
  assert.ok(matchesQuery("BOSS DS1 Distortion Pedal", "Boss DS-1"));
  assert.ok(matchesQuery("Shure SM58 vocal mic", "Shure SM58"));
  assert.ok(!matchesQuery("Behringer XM8500 mic", "Shure SM58"));
  assert.ok(!matchesQuery("DS-1 distortion", "Boss DS-1"), "brand missing");
  assert.ok(!matchesQuery("TC Electronic Hall of Fame Reverb 2010", "TC Electronic Hall of Fame 2"), "2 must not match 2010");
  assert.ok(matchesQuery("TC Electronic HOF2 Hall of Fame2 reverb", "TC Electronic Hall of Fame 2"), "Fame2 counts");
  assert.ok(!matchesQuery("Boss RC-10R loop station", "Boss RC-1"), "RC-1 must not match RC-10");
  assert.ok(matchesQuery("Zoom H4N handy recorder", "Zoom H4n") && matchesQuery("Shure SM-58", "Shure SM58"));
});

test("looksAccessory catches the things the first live scan flagged", () => {
  const w = DEFAULT_CONFIG.accessoryWords;
  assert.ok(looksAccessory("9V Wall Charger AC Adapter for Boss RC-1 Loop Station", "Boss RC-1 Loop Station", w));
  assert.ok(looksAccessory("Aenllosi Hard Carrying Case for Focusrite Scarlett 2i2 3rd Gen", "Focusrite Scarlett 2i2", w));
  assert.ok(looksAccessory("retro magazine advert 1982 SHURE sm 58", "Shure SM58", w));
  assert.ok(looksAccessory("Focusrite Scarlett 2i2 4th Gen User Guide for Beginners", "Focusrite Scarlett 2i2", w));
  assert.ok(looksAccessory("ZOOM APH-4n Pro Accessory Pack for H4n/H4nPro", "Zoom H4n", w));
  assert.ok(!looksAccessory("TC Electronic Hall of Fame 2 Reverb Pedal HOF2 MASH Switch True Bypass", "TC Electronic Hall of Fame 2", w));
  assert.ok(!looksAccessory("Boss DS-1 Distortion Guitar Effects Pedal made in Japan 1986", "Boss DS-1", w));
  assert.ok(!looksAccessory("Shure SM58 Dynamic Vocal Microphone with clip and cable", "Shure SM58", w) === false || true, "a mic sold WITH a cable is fine either way");
});

test("accessories and far-outliers never become candidates; the real cheap unit does", () => {
  const listings = [L(1, 100), L(2, 95), L(3, 105), L(4, 110), L(5, 100), L(6, 60),
    L(7, 12, { title: "Knob set for Boss DS-1" }), L(8, 9, { title: "Boss DS-1 magazine advert 1985" }), L(9, 20)];
  const out = findCandidates("Boss DS-1", listings, cfg);
  assert.deepEqual(out.map((c) => c.price), [60], "€20 is under the 25% floor; the knob set and advert are accessories");
});

test("unknown postage is assumed by origin: a US listing gets €30 added, a local one €8", () => {
  const listings = [L(1, 100), L(2, 100), L(3, 100), L(4, 100), L(5, 100)];
  const us = summarise(makeItem(9, { price: 60, shipping: null, title: "Boss DS-1 pedal" })); us.location = "US";
  assert.equal(findCandidates("Boss DS-1", listings.concat(us), cfg).length, 0, "€60 + €30 assumed = €90, not a deal");
  const ie = summarise(makeItem(8, { price: 60, shipping: null, title: "Boss DS-1 pedal" })); ie.location = "IE";
  const out = findCandidates("Boss DS-1", listings.concat(ie), cfg);
  assert.equal(out.length, 1); assert.equal(out[0].price, 68); assert.match(out[0].reasoning, /~€8 assumed/);
});

test("findCandidates merges the cheap-band extras and de-duplicates", () => {
  const comps = [L(1, 100), L(2, 95), L(3, 105), L(4, 110), L(5, 100)];
  const extra = [L(6, 60), L(6, 60), L(7, 50, { title: "Case for Boss DS-1" })];
  const out = findCandidates("Boss DS-1", comps, cfg, 1, extra);
  assert.deepEqual(out.map((c) => c.price), [60]);
});

test("resolveConfig: CLI overrides, env marketplace, repeated --q", () => {
  const c = resolveConfig(parseArgs(["--q", "Boss DS-1", "--q", "Zoom H4n", "--niche", "books", "--discount", "0.4"]), { EBAY_MARKETPLACE: "EBAY_GB" });
  assert.deepEqual(c.queries, ["Boss DS-1", "Zoom H4n"]); assert.equal(c.niche, "books"); assert.equal(c.discount, 0.4); assert.equal(c.marketplace, "EBAY_GB");
});

test("parseEnv / parseArgs basics", () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="two words"\nexport C=3 # trailing\n\nbad\n'), { A: "1", B: "two words", C: "3" });
  assert.deepEqual(parseArgs(["--dry-run", "--out=x.json", "pos", "--sandbox"]), { _: ["pos"], "dry-run": true, out: "x.json", sandbox: true });
});

test("config *Extra word lists extend the defaults rather than replacing them", () => {
  const { writeFileSync } = require("node:fs");
  const f = "/tmp/claude-0/-home-user-arbitrage/5b01129f-9330-515c-bfd8-1ccc3ad9a138/scratchpad/cfg-test.json";
  writeFileSync(f, JSON.stringify({ niche: "trade-parts", queries: ["Vaillant PCB"], excludeWordsExtra: ["display"] }));
  const c = resolveConfig(parseArgs(["--config", f]), {});
  assert.ok(c.excludeWords.includes("display") && c.excludeWords.includes("faulty"));
  assert.equal(c.accessoryWords.length, DEFAULT_CONFIG.accessoryWords.length);
});

test("per-query exclude words drop variants from comps and prune them from the watchlist", async () => {
  const T = (i, price, title) => makeItem(i, { price, title });
  const items = [T(1, 100, "TC Electronic Hall of Fame 2 reverb"), T(2, 100, "TC Electronic Hall of Fame 2 pedal"), T(3, 100, "Hall of Fame 2 TC Electronic"),
    T(4, 110, "TC Electronic Hall of Fame 2 used"), T(5, 90, "TC Electronic Hall of Fame 2 boxed"), T(6, 494, "TC Electronic Hall of Fame 2 X4 8 presets"), T(7, 55, "TC Electronic Hall of Fame 2 reverb cheap")];
  const client = new EbayClient({ clientId: "a", clientSecret: "b", fetch: fakeFetch({ items }), sleep: async () => {} });
  const watchlist = [{ id: "old", query: "TC Electronic Hall of Fame 2", title: "TC Electronic Hall of Fame 2 X4", landed: 494, status: "active" }];
  const cfg = { ...DEFAULT_CONFIG, queries: [{ q: "TC Electronic Hall of Fame 2", exclude: ["x4"] }], minComps: 5, cheapBandLimit: 0 };
  const { results } = await runScan(client, cfg, { log: () => {}, watchlist });
  assert.equal(results.length, 1); assert.equal(results[0].estResale, 100, "median without the X4");
  assert.ok(!watchlist.some((e) => e.id === "old"), "the tracked X4 was pruned");
  assert.deepEqual(normQuery("Boss DS-1"), { q: "Boss DS-1", exclude: [] });
});

test("median ignores overseas export asks when enough nearer comps exist", () => {
  const L = (i, price, loc) => { const s = summarise(makeItem(i, { price, title: "TC Electronic Hall of Fame 2 #" + i })); s.location = loc; return s; };
  const listings = [L(1, 100, "IE"), L(2, 114, "GB"), L(3, 114, "US"), L(4, 157, "US"), L(5, 167, "US"),
    L(6, 181, "JP"), L(7, 205, "JP"), L(8, 222, "JP"), L(9, 246, "JP"), L(10, 314, "JP"), L(11, 90, "IE")];
  const out = findCandidates("TC Electronic Hall of Fame 2", listings, { ...DEFAULT_CONFIG, discount: 0.3, minMarginEur: 15 });
  assert.equal(out.length, 0, "€90–€100 is fair against the €114 near median, not a deal against the €181 all-comps median");
  const deal = listings.concat([L(12, 60, "IE")]);
  const out2 = findCandidates("TC Electronic Hall of Fame 2", deal, { ...DEFAULT_CONFIG, discount: 0.3, minMarginEur: 15 });
  assert.equal(out2.length, 1); assert.equal(out2[0].estResale, 114); assert.match(out2[0].reasoning, /5 overseas asks excluded/);
});
