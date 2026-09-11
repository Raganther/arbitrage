#!/usr/bin/env node
/*
 * publish.mjs — prepare Scout database writes from a scan, so candidates land
 * in the Discover tab with no file import.
 *
 * Scout (the published artifact) keeps its finds in a shared database,
 * collection "discoveries". A Claude session writes there with the Artifact
 * tool's write_db (batches of ≤50). This script does the thinking; the session
 * does the writing:
 *
 *   node publish.mjs [--existing <dir>] [--max-age-days 14]
 *
 *   --existing <dir>   a dump of the current discoveries collection (one JSON
 *                      file per doc, as read_db --out_dir produces). Docs already
 *                      present are skipped so your added/dismissed choices
 *                      survive; docs still marked "new" that aren't in today's
 *                      scan and are older than --max-age-days (default 1) are
 *                      queued for deletion — Discover shows today's list.
 *
 * Output: data/publish/manifest.json — { batches: [ [ {op, collection, doc_id, file_path} … ] … ] }
 * with one JSON file per document under data/publish/docs/. Each batch ≤ 50.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./env.mjs";
import { dataPath } from "./store.mjs";

const DAY = 86_400_000;

/** Turn a scan result into a Scout discovery document (the schema in SCANNER.md). */
export function toDoc(c, now = Date.now()) {
  const id = c.id || ("scan-" + (c.foundAt || now) + "-" + Math.random().toString(36).slice(2, 8));
  return { id, doc: {
    title: String(c.title), price: Number(c.price), estResale: Number(c.estResale), cond: c.cond || "",
    soldQuery: c.soldQuery || c.title, category: c.category || "other", source: c.source || "eBay",
    url: c.url || "", reasoning: c.reasoning || "", foundAt: Number(c.foundAt) || now, status: "new",
    ...(c.image ? { image: c.image } : {}), ...(c.targetBuy ? { targetBuy: c.targetBuy } : {}), ...(c.estBasis ? { estBasis: c.estBasis } : {}),
  } };
}

/** Read a read_db --out_dir dump: { id → doc }. Tolerates nested "discoveries/<id>.json" layout. */
export function loadExisting(dir) {
  const out = {};
  if (!dir || !existsSync(dir)) return out;
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith(".json")) { try { out[f.name.replace(/\.json$/, "")] = JSON.parse(readFileSync(p, "utf8")); } catch {} }
  } };
  walk(dir);
  return out;
}

/** Decide the writes. Pure; tested. */
export function planWrites(results, existing = {}, { now = Date.now(), maxAgeDays = 1 } = {}) {
  const sets = [], deletes = [], updates = [];
  const seen = new Set();
  for (const c of results) {
    const { id, doc } = toDoc(c, now);
    if (seen.has(id)) continue; seen.add(id);
    const ex = existing[id] && (existing[id].data || existing[id]);
    if (ex) {
      // Already there — keep the user's status, but refresh the numbers if the estimate moved.
      const patch = {};
      for (const k of ["price", "estResale", "reasoning", "targetBuy", "estBasis"]) if (doc[k] !== undefined && doc[k] !== ex[k]) patch[k] = doc[k];
      if (Object.keys(patch).length) updates.push({ op: "update", doc_id: id, data: patch });
      continue;
    }
    sets.push({ op: "set", doc_id: id, data: doc });
  }
  for (const [id, doc] of Object.entries(existing)) {
    const d = doc && (doc.data || doc);               // dumps may wrap the fields
    if (!d) continue;
    const stale = d.status === "new" && Number(d.foundAt) && now - Number(d.foundAt) > maxAgeDays * DAY && !seen.has(id);
    if (stale) deletes.push({ op: "delete", doc_id: id });
  }
  return { sets, deletes, updates };
}

export function chunk(arr, n = 50) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.data ? String(args.data) : undefined;
  const results = JSON.parse(readFileSync(args.in ? String(args.in) : dataPath("scan-results.json", dir), "utf8"));
  const existing = loadExisting(args.existing ? String(args.existing) : null);
  const { sets, deletes, updates } = planWrites(results, existing, { maxAgeDays: args["max-age-days"] != null ? Number(args["max-age-days"]) : 1 });
  const outDir = dataPath("publish", dir), docsDir = join(outDir, "docs");
  rmSync(outDir, { recursive: true, force: true }); mkdirSync(docsDir, { recursive: true });
  const writes = [];
  for (const s of sets) {
    const fp = join(docsDir, s.doc_id + ".json");
    writeFileSync(fp, JSON.stringify(s.data, null, 2));
    writes.push({ op: "set", collection: "discoveries", doc_id: s.doc_id, file_path: fp });
  }
  for (const u of updates) {
    const fp = join(docsDir, u.doc_id + ".patch.json");
    writeFileSync(fp, JSON.stringify(u.data, null, 2));
    writes.push({ op: "update", collection: "discoveries", doc_id: u.doc_id, file_path: fp });
  }
  for (const d of deletes) writes.push({ op: "delete", collection: "discoveries", doc_id: d.doc_id });
  const batches = chunk(writes, 50);
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ collection: "discoveries", sets: sets.length, updates: updates.length, deletes: deletes.length, batches }, null, 2));
  const dupes = results.length - new Set(results.map((c) => toDoc(c).id)).size;
  console.log(`${sets.length} new to write, ${updates.length} to refresh, ${deletes.length} stale to delete, ${results.length - sets.length - dupes - updates.length} unchanged, ${dupes} duplicate(s) in the scan → ${batches.length} batch(es) in ${join(outDir, "manifest.json")}`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
