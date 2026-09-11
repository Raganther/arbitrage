#!/usr/bin/env node
/*
 * state.mjs — keep the scanner's memory (watchlist, market, sold prices) in
 * Scout's shared database, so a scheduled run that can't push to git still
 * carries tracking forward from one day to the next.
 *
 * Collection "scanner":
 *   index            { queries: [slug…], savedAt }
 *   market           the market.json object
 *   sold             the sold.json object
 *   watch-<slug>     { query, entries: [watchlist entries for that query] }   (≤ ~40 entries, well under the 256 KiB doc cap)
 *
 *   node state.mjs export                # data/* → data/state-out/manifest.json (write_db batches) + docs
 *   node state.mjs import <dumpDir>      # a read_db --out_dir dump of "scanner" → data/watchlist.json, market.json, sold.json
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadWatchlist, saveWatchlist, loadMarket, saveMarket, loadSold, saveSold, dataPath } from "./store.mjs";

export const COLLECTION = "scanner";
export const slug = (q) => String(q).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "q";

/** Split state into documents. Pure; tested. */
export function toDocs(watchlist, market, sold, now = Date.now()) {
  const byQ = {};
  for (const e of watchlist) (byQ[e.query] = byQ[e.query] || []).push(e);
  const docs = {};
  const slugs = [];
  for (const [q, entries] of Object.entries(byQ)) {
    let s = slug(q), n = 1; while (docs["watch-" + s]) s = slug(q) + "-" + (++n);
    slugs.push(s);
    docs["watch-" + s] = { query: q, entries, savedAt: now };
  }
  docs.index = { queries: slugs, savedAt: now, tracked: watchlist.length };
  docs.market = { savedAt: now, market: market || {} };
  docs.sold = { savedAt: now, sold: sold || {} };
  return docs;
}

/** Rebuild state from a dump ({ id → doc or {data} }). Pure; tested. */
export function fromDocs(dump) {
  const get = (id) => { const d = dump[id]; return d && (d.data || d); };
  const idx = get("index");
  const watchlist = [];
  const ids = idx && Array.isArray(idx.queries) ? idx.queries.map((s) => "watch-" + s) : Object.keys(dump).filter((k) => k.startsWith("watch-"));
  for (const id of ids) { const d = get(id); if (d && Array.isArray(d.entries)) watchlist.push(...d.entries); }
  const m = get("market"), s = get("sold");
  return { watchlist, market: m && m.market ? m.market : null, sold: s && s.sold ? s.sold : {} };
}

function loadDump(dir) {
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

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "export") {
    const docs = toDocs(loadWatchlist(), loadMarket(), loadSold());
    const outDir = dataPath("state-out"), docsDir = join(outDir, "docs");
    rmSync(outDir, { recursive: true, force: true }); mkdirSync(docsDir, { recursive: true });
    const writes = [];
    for (const [id, doc] of Object.entries(docs)) {
      const fp = join(docsDir, id + ".json"); writeFileSync(fp, JSON.stringify(doc));
      writes.push({ op: "set", collection: COLLECTION, doc_id: id, file_path: fp });
    }
    const batches = []; for (let i = 0; i < writes.length; i += 50) batches.push(writes.slice(i, i + 50));
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ collection: COLLECTION, docs: writes.length, batches }, null, 2));
    console.log(`Exported ${writes.length} state doc(s) (${docs.index.tracked} tracked listings) → ${join(outDir, "manifest.json")}`);
  } else if (cmd === "import") {
    const dump = loadDump(arg);
    const { watchlist, market, sold } = fromDocs(dump);
    if (!watchlist.length && !market && !Object.keys(sold).length) { console.log("No saved state in " + (arg || "(none)") + " — keeping data/ as it is."); return; }
    // Merge: saved state wins for tracked entries; anything local-only (e.g. from a git checkout) is kept too.
    const local = loadWatchlist(); const seen = new Set(watchlist.map((e) => e.id));
    for (const e of local) if (!seen.has(e.id)) watchlist.push(e);
    saveWatchlist(watchlist); if (market) saveMarket(market); saveSold(Object.assign({}, loadSold(), sold));
    console.log(`Imported ${watchlist.length} tracked listings, market for ${market ? Object.keys(market).length : 0} searches, sold prices for ${Object.keys(sold).length} searches.`);
  } else {
    console.error("Usage: node state.mjs export | import <dumpDir>"); process.exit(1);
  }
}
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
