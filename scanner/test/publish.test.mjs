import { test } from "node:test";
import assert from "node:assert/strict";
import { toDoc, planWrites, chunk } from "../publish.mjs";

const DAY = 86_400_000;
const c = (id, over = {}) => ({ id, title: "Boss DS-1", price: 40, estResale: 90, cond: "Used", soldQuery: "Boss DS-1", category: "music-gear", source: "eBay", url: "u", reasoning: "r", foundAt: 1000, status: "new", ...over });

test("toDoc maps a scan result to the Scout discovery schema", () => {
  const { id, doc } = toDoc(c("ebay-1", { image: "img", targetBuy: 45, estBasis: "tracked-sales" }));
  assert.equal(id, "ebay-1");
  assert.deepEqual(Object.keys(doc).sort(), ["category", "cond", "estBasis", "estResale", "foundAt", "image", "price", "reasoning", "soldQuery", "source", "status", "targetBuy", "title", "url"].sort());
  assert.equal(doc.status, "new");
});

test("planWrites skips docs already present, de-duplicates, deletes stale untouched ones", () => {
  const now = 100 * DAY;
  const results = [c("a"), c("b"), c("b"), c("c")];
  const existing = { b: { status: "added", foundAt: now - 20 * DAY }, old: { status: "new", foundAt: now - 20 * DAY }, kept: { status: "dismissed", foundAt: now - 20 * DAY }, fresh: { status: "new", foundAt: now - 2 * DAY }, today: { status: "new", foundAt: now - 3600_000 } };
  const { sets, deletes, updates } = planWrites(results, existing, { now });
  assert.deepEqual(sets.map((s) => s.doc_id), ["a", "c"]);
  assert.deepEqual(updates.map((u) => u.doc_id), ["b"], "b exists with different numbers → refreshed, status untouched");
  assert.ok(!("status" in updates[0].data) && updates[0].data.estResale === 90);
  assert.deepEqual(deletes.map((d) => d.doc_id).sort(), ["fresh", "old"], "still 'new', not in today's scan, older than a day");
});

test("chunk splits into batches of 50", () => {
  assert.equal(chunk(Array(120).fill(0)).length, 3);
  assert.equal(chunk([]).length, 0);
});
