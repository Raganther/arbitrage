import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, computeMarket } from "../track.mjs";
import { rememberComps } from "../store.mjs";
import { findCandidates, DEFAULT_CONFIG } from "../scan.mjs";
import { summarise } from "../ebay.mjs";
import { makeItem } from "./fake-ebay.mjs";

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const entry = (over = {}) => ({ id: "1", itemId: "v1|1|0", query: "Boss DS-1", title: "Boss DS-1", price: 60, landed: 68, endsAt: new Date(T0 + 20 * DAY).toISOString(), firstSeen: T0, status: "active", ...over });

test("classify: ended with >1 day left = sold-likely at asking; ended on schedule = expired; 404 = removed", () => {
  const sold = classify(entry(), { status: "ended", endsAt: "" }, T0 + 5 * DAY);
  assert.equal(sold.status, "sold-likely"); assert.equal(sold.closedPrice, 68);
  const exp = classify(entry(), { status: "ended" }, T0 + 20 * DAY + 3600_000);
  assert.equal(exp.status, "expired"); assert.equal(exp.closedPrice, undefined);
  const gone = classify(entry(), { status: "gone" }, T0 + 5 * DAY);
  assert.equal(gone.status, "removed");
  const renewed = classify(entry(), { status: "active", endsAt: new Date(T0 + 50 * DAY).toISOString(), price: 60 }, T0 + 5 * DAY);
  assert.equal(renewed.status, "active"); assert.match(renewed.endsAt, /2026-10-21/);
});

test("computeMarket: proxy until 3 sales, then tracked; sell-through and targetBuy", () => {
  const wl = [entry({ id: "a" }), entry({ id: "b", landed: 100 }), entry({ id: "c", landed: 120 })];
  let m = computeMarket(wl, T0 + 10 * DAY);
  assert.equal(m["Boss DS-1"].basis, "proxy"); assert.equal(m["Boss DS-1"].estSold, null);
  assert.equal(m["Boss DS-1"].medianAsk, 100); assert.equal(m["Boss DS-1"].targetBuy, 43, "100 × 0.85 × 0.5");
  assert.equal(m["Boss DS-1"].sellThrough, null);
  wl.push(entry({ id: "d", status: "sold-likely", closedPrice: 80 }), entry({ id: "e", status: "sold-likely", closedPrice: 90 }),
    entry({ id: "f", status: "sold-likely", closedPrice: 100 }), entry({ id: "g", status: "expired" }));
  m = computeMarket(wl, T0 + 10 * DAY);
  const r = m["Boss DS-1"];
  assert.equal(r.basis, "sold"); assert.equal(r.estSold, 90); assert.equal(r.targetBuy, 45);
  assert.equal(r.sellThrough, 75, "3 sold of 4 closed"); assert.equal(r.daysTracked, 10);
});

test("rememberComps: de-duplicates, caps per query, refreshes lastSeen", () => {
  const wl = [];
  const comps = [1, 2, 3].map((i) => summarise(makeItem(i, { price: 50, title: "Boss DS-1 #" + i })));
  assert.equal(rememberComps(wl, "Boss DS-1", comps, { now: 1, perQuery: 2 }), 2);
  assert.equal(rememberComps(wl, "Boss DS-1", comps, { now: 2, perQuery: 2 }), 0, "cap reached, nothing new");
  assert.equal(wl[0].lastSeen, 2);
  wl[0].status = "sold-likely";
  assert.equal(rememberComps(wl, "Boss DS-1", comps, { now: 3, perQuery: 2 }), 1, "a closed one frees a slot");
});

test("findCandidates uses the market's targetBuy and tracked estSold when present", () => {
  const L = (i, price) => summarise(makeItem(i, { price, title: "Boss DS-1 pedal #" + i }));
  const listings = [L(1, 100), L(2, 100), L(3, 100), L(4, 100), L(5, 100), L(6, 75)];
  const cfg = { ...DEFAULT_CONFIG, discount: 0.3, minMarginEur: 15 };
  assert.equal(findCandidates("Boss DS-1", listings, cfg).length, 0, "€75 is only 25% under, not a candidate by the default rule");
  const market = { "Boss DS-1": { targetBuy: 80, estSold: 160, sellThrough: 70 } };
  const out = findCandidates("Boss DS-1", listings, cfg, 1, [], market);
  assert.equal(out.length, 1); assert.equal(out[0].estResale, 160); assert.equal(out[0].estBasis, "tracked-sales");
  assert.match(out[0].reasoning, /Tracked sales say ~€160 \(70% sell-through\); target buy ≤€80/);
});
