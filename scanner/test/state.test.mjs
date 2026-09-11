import { test } from "node:test";
import assert from "node:assert/strict";
import { toDocs, fromDocs, slug } from "../state.mjs";

test("state round-trips through per-query documents", () => {
  const wl = [{ id: "1", query: "Boss DS-1", landed: 50, status: "active" }, { id: "2", query: "Boss DS-1", landed: 60, status: "sold-likely" }, { id: "3", query: "Vaillant ecoTEC PCB", landed: 40, status: "active" }];
  const market = { "Boss DS-1": { targetBuy: 30 } }, sold = { "Boss DS-1": [{ price: 65 }] };
  const docs = toDocs(wl, market, sold, 5);
  assert.deepEqual(Object.keys(docs).sort(), ["index", "market", "sold", "watch-boss-ds-1", "watch-vaillant-ecotec-pcb"]);
  assert.equal(docs["watch-boss-ds-1"].entries.length, 2);
  const back = fromDocs(Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, { data: v }])));
  assert.equal(back.watchlist.length, 3); assert.deepEqual(back.market, market); assert.deepEqual(back.sold, sold);
});

test("slug is safe and two queries can't collide silently", () => {
  assert.equal(slug("TC Electronic Hall of Fame 2"), "tc-electronic-hall-of-fame-2");
  const docs = toDocs([{ id: "a", query: "Boss DS-1" }, { id: "b", query: "Boss DS 1" }], null, null);
  assert.ok(docs["watch-boss-ds-1"] && docs["watch-boss-ds-1-2"]);
});

test("fromDocs on an empty dump yields nothing", () => {
  assert.deepEqual(fromDocs({}), { watchlist: [], market: null, sold: {} });
});
