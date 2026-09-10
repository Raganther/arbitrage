/* store.mjs — the scanner's memory: JSON files in scanner/data/ (committed, so a scheduled run picks up where the last left off). */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

export function dataPath(name, dir) { return join(dir || DEFAULT_DIR, name); }

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function loadWatchlist(dir) { return readJson(dataPath("watchlist.json", dir), []); }
export function saveWatchlist(list, dir) { writeJson(dataPath("watchlist.json", dir), list); }
export function loadMarket(dir) { return existsSync(dataPath("market.json", dir)) ? readJson(dataPath("market.json", dir), null) : null; }
export function saveMarket(m, dir) { writeJson(dataPath("market.json", dir), m); }

/** Add newly-seen comps to the watchlist (no duplicates); refresh lastSeen on known ones. Returns count added. */
export function rememberComps(watchlist, q, comps, { now = Date.now(), perQuery = 30 } = {}) {
  const known = new Map(watchlist.map((e) => [e.id, e]));
  const activeForQ = watchlist.filter((e) => e.query === q && e.status === "active").length;
  let room = Math.max(0, perQuery - activeForQ), added = 0;
  for (const c of comps) {
    const id = c.legacyItemId || c.itemId; if (!id) continue;
    const e = known.get(id);
    if (e) { e.lastSeen = now; continue; }
    if (room <= 0) continue;
    watchlist.push({ id, itemId: c.itemId, query: q, title: c.title, price: c.price, shipping: c.shipping, landed: Math.round(c.landed * 100) / 100,
      cond: c.cond, url: c.url, location: c.location, endsAt: c.endsAt, firstSeen: now, lastSeen: now, lastChecked: 0, status: "active" });
    known.set(id, watchlist[watchlist.length - 1]); room--; added++;
  }
  return added;
}
