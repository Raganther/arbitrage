#!/usr/bin/env node
/*
 * Scout scanner — finds candidate arbitrage listings on eBay for a niche.
 *
 * How it works (honestly):
 *   The eBay Browse API gives ACTIVE listings only (never final sold prices).
 *   So this scanner spots deals relative to the crowd: for each specific item,
 *   it pulls current listings, takes the MEDIAN landed price (item + postage)
 *   as a rough market value, and flags listings priced well below it. That is a
 *   candidate, not a guarantee — you confirm the real resale value (eBay SOLD
 *   comps) in Scout.
 *
 * It writes scan-results.json — a list of discovery objects matching the schema
 * in ../SCANNER.md — which you then import into Scout's Discover tab.
 *
 * Setup:  cp .env.example .env   (fill in your keyset)   then   node check.mjs
 * Run:    node scan.mjs                        # CONFIG below, production
 *         node scan.mjs --sandbox              # sandbox keyset/host
 *         node scan.mjs --q "Boss DS-1" --q "Zoom H4n" --niche music-gear
 *         node scan.mjs --config my-niche.json # { niche, marketplace, queries, ... }
 *         node scan.mjs --dry-run              # no API calls; sample file
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, parseArgs } from "./env.mjs";
import { clientFromEnv } from "./ebay.mjs";
import { loadWatchlist, saveWatchlist, rememberComps, loadMarket, dataPath } from "./store.mjs";

// ---------- config: edit these, or override with --config file.json ----------
export const DEFAULT_CONFIG = {
  niche: "music-gear",
  marketplace: "EBAY_IE",          // EBAY_GB, EBAY_US, ... for other regions
  deliveryCountry: "IE",           // only listings that ship here (set "" to disable)
  // Use SPECIFIC, model-level searches. Broad terms ("guitar pedal") make the
  // median meaningless; "Boss DS-1" gives a tight, comparable set.
  queries: [
    "Boss DS-1",
    "Shure SM58",
    "Focusrite Scarlett 2i2",
    "Boss RC-1 Loop Station",
    "Korg Volca Beats",
    "TC Electronic Hall of Fame 2",
    "Zoom H4n",
  ],
  conditions: ["USED"],  // USED | NEW | UNSPECIFIED — comps must be like-for-like
  compsPerQuery: 40,     // listings to sample when computing the median (1 API call ≤ 200)
  minComps: 5,           // fewer than this and the median isn't trusted
  // Calibrated on verified sold prices (Sep 2026: SM58, Scarlett 2i2, Ideal Logic fan, Hall of Fame 2):
  // used items SELL for roughly 50–65% of the median ASKING price. So "30% under asking" ≈ the sold
  // price ≈ zero margin. A candidate must be at least 50% under the median asking to be worth a look.
  discount: 0.50,        // flag listings >= 50% below the median landed asking price
  minMarginEur: 15,      // and at least this many EUR below it
  maxPerQuery: 3,        // keep at most this many candidates per query
  excludeWords: ["parts", "spares", "repair", "faulty", "broken", "not working", "for parts", "case only", "box only", "manual only"],
  // Accessories and ephemera that share the product's name but aren't the product.
  accessoryWords: ["case", "bag", "cover", "sleeve", "pouch", "adapter", "adaptor", "charger", "power supply", "psu", "cable", "lead",
    "manual", "guide", "book", "advert", "magazine", "cutting", "brochure", "catalog", "sticker", "decal", "knob", "knobs", "footswitch cap",
    "replacement", "spare", "stand", "clip", "mount", "bracket", "strap", "windscreen", "foam", "grille", "grill", "capsule", "cartridge",
    "battery", "batteries", "screen protector", "skin", "accessory pack", "accessories", "kit for", "compatible with", "fits", "holder",
    "dvd", "tutorial", "dictionary", "clone", "clones", "copy", "replica", "style", "poster", "print", "t-shirt", "tshirt", "mug", "keyring",
    "screw", "screws", "gasket", "gaskets", "seal", "seals", "o-ring", "oring", "washer", "washers", "clip only", "harness only"],
  requireQueryWords: true,  // a candidate's title must contain every word of the query (Boss + DS-1)
  minFraction: 0.25,        // ignore listings under 25% of the median — never the real item
  // Export sellers in these countries list systematically high (and postage/customs make them poor comps for an
  // Irish buyer). When at least minNearComps comps come from elsewhere, the median uses only those.
  farCountries: ["JP", "CN", "HK", "TW", "KR", "SG", "MY", "TH", "VN", "IN"],
  minNearComps: 3,
  cheapBandLimit: 50,       // second, targeted search of the cheap band (1 extra call per query)
  // When a listing doesn't state postage ("calculated"), assume this much by origin so landed prices stay honest.
  homeCountry: "IE",
  euCountries: ["IE", "GB", "DE", "FR", "NL", "BE", "IT", "ES", "AT", "PT", "PL", "CZ", "DK", "SE", "FI", "LU"],
  assumedPostage: { home: 8, eu: 15, other: 30 },
  watchPerQuery: 30,        // comps per query to keep tracking (1 API call each per track run)
};
// -----------------------------------------------------------------------------

export function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function looksBroken(title, words) {
  const t = String(title).toLowerCase();
  return words.some((w) => t.includes(w));
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Does the title contain every word of the query? Hyphen/space-insensitive ("DS-1" matches "DS1", "SM 58"
 * matches "SM58"), but a number must end where the query's number ends: "Hall of Fame 2" doesn't match
 * "Hall of Fame 2010", "RC-1" doesn't match "RC-10".
 */
export function matchesQuery(title, q) {
  const t = String(title).toLowerCase();
  return String(q).toLowerCase().split(/\s+/).filter(Boolean).every((w) => {
    const parts = w.match(/[a-z]+|[0-9]+/g);
    if (!parts) return true;
    const body = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9]?");
    const lead = /^[0-9]/.test(w) ? "(^|[^0-9])" : "(^|[^a-z0-9])";
    const tail = /[0-9]$/.test(w) ? "(?![0-9])" : "";   // a number must end where the query's number ends
    return new RegExp(lead + body + tail).test(t);
  });
}

/** Accessory/ephemera heuristics: "... for Boss RC-1", "case for", "manual", "magazine advert". */
export function looksAccessory(title, q, words) {
  const t = " " + String(title).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  if (words.some((w) => t.includes(" " + w + " "))) return true;
  // "<thing> for <the product>" — the product is the object, not the item for sale.
  const qFirst = String(q).split(/\s+/)[0].toLowerCase();
  if (new RegExp("\\s(for|fits|compatible with|suitable for)\\s+(the\\s+)?" + qFirst.replace(/[^a-z0-9]/g, "") + "\\b").test(t.replace(/[^a-z0-9 ]/g, ""))) return true;
  return false;
}

/** Fill in a postage estimate by origin when the listing doesn't state one; returns a copy. */
export function withAssumedPostage(l, cfg) {
  if (l.shipping != null || !isFinite(l.price) || !cfg.assumedPostage) return l;
  const loc = (l.location || "").toUpperCase();
  const tier = loc === (cfg.homeCountry || "IE") ? "home" : (cfg.euCountries || []).includes(loc) ? "eu" : "other";
  const est = Number(cfg.assumedPostage[tier]);
  if (!isFinite(est)) return l;
  return { ...l, landed: l.price + est, assumedShipping: est };
}

/** Keep only listings that look like the actual product in sellable condition. */
export function relevant(listings, q, cfg) {
  return listings.map((l) => withAssumedPostage(l, cfg)).filter((l) => isFinite(l.landed) && l.landed > 0 &&
    !looksBroken(l.title, cfg.excludeWords || []) &&
    !looksBroken(l.cond || "", ["parts", "not working", "defective", "faulty"]) && String(l.conditionId) !== "7000" &&
    !looksAccessory(l.title, q, cfg.accessoryWords || []) &&
    (cfg.requireQueryWords === false || matchesQuery(l.title, q)));
}

/** Turn one query's listings into discovery docs (pure; unit-tested). */
export function findCandidates(q, listings, cfg = DEFAULT_CONFIG, now = Date.now(), extra = [], market = null) {
  const clean = relevant(listings, q, cfg);
  if (clean.length < (cfg.minComps || 5)) return [];
  const far = new Set(cfg.farCountries || []);
  const near = clean.filter((l) => !far.has((l.location || "").toUpperCase()));
  const useNear = near.length >= (cfg.minNearComps == null ? 3 : cfg.minNearComps) && near.length < clean.length;
  const comps = useNear ? near : clean;
  const mid = median(comps.map((l) => l.landed));
  const mk = market && market[q] && market[q].targetBuy ? market[q] : null;
  // With tracked sales data, the ceiling is the market's targetBuy; otherwise the discount-under-median rule.
  const threshold = mk ? Math.max(mk.targetBuy, mid * (1 - cfg.discount)) : mid * (1 - cfg.discount);
  const floor = mid * (cfg.minFraction == null ? 0.25 : cfg.minFraction);
  const seen = new Set();
  const pool = clean.concat(relevant(extra, q, cfg)).filter((l) => { const k = l.itemId || l.url || l.title; if (seen.has(k)) return false; seen.add(k); return true; });
  return pool
    .filter((l) => l.landed <= threshold && l.landed >= floor && (mid - l.landed) >= cfg.minMarginEur)
    .sort((a, b) => (mid - b.landed) - (mid - a.landed))
    .slice(0, cfg.maxPerQuery)
    .map((l) => {
      const under = Math.round((1 - l.landed / mid) * 100);
      const shipNote = l.assumedShipping != null ? "postage not stated, ~€" + l.assumedShipping + " assumed" :
        l.shipping == null ? "postage unknown" : l.shipping === 0 ? "free postage" : "incl. €" + l.shipping.toFixed(2) + " postage";
      return {
        id: l.legacyItemId ? "ebay-" + l.legacyItemId : undefined,
        title: l.title,
        price: Math.round(l.landed * 100) / 100,   // landed = item + postage to you
        estResale: mk && mk.estSold ? mk.estSold : Math.round(mid),   // tracked sold estimate when we have one, else median asking
        estBasis: mk && mk.estSold ? "tracked-sales" : "median-asking",
        targetBuy: mk ? mk.targetBuy : undefined,
        cond: l.cond,
        soldQuery: q,
        category: cfg.niche,
        source: "eBay",
        url: l.url,
        image: l.image || "",
        itemId: l.itemId || "",
        endsAt: l.endsAt || "",
        reasoning: "Listed at €" + Math.round(l.price) + " (" + shipNote + "), ~" + under + "% under the €" +
          Math.round(mid) + " median for \"" + q + "\" (" + comps.length + " comps" + (useNear ? ", " + (clean.length - near.length) + " overseas asks excluded" : "") +
          (l.location ? ", ships from " + l.location : "") + ")." +
          (mk && mk.estSold ? " Tracked sales say ~€" + mk.estSold + " (" + mk.sellThrough + "% sell-through); target buy ≤€" + mk.targetBuy + "." :
            mk ? " Target buy ≤€" + mk.targetBuy + " (proxy, no sales tracked yet)." : "") + " Confirm in sold listings.",
        foundAt: now,
        status: "new",
      };
    });
}

export function sampleResults(now = Date.now()) {
  return [{
    id: "sample-1", title: "Boss DS-1 distortion pedal (sample)", price: 22, estResale: 52, cond: "Used",
    soldQuery: "Boss DS-1", category: "music-gear", source: "eBay", url: "",
    reasoning: "SAMPLE — --dry-run produced this so you can test the import flow without an API key.",
    foundAt: now, status: "new",
  }];
}

export function resolveConfig(args, env = process.env) {
  let cfg = { ...DEFAULT_CONFIG };
  if (args.config) {
    const file = JSON.parse(readFileSync(String(args.config), "utf8"));
    cfg = { ...cfg, ...file };
    // *Extra lists add to the defaults instead of replacing them.
    if (file.excludeWordsExtra) cfg.excludeWords = DEFAULT_CONFIG.excludeWords.concat(file.excludeWordsExtra);
    if (file.accessoryWordsExtra) cfg.accessoryWords = DEFAULT_CONFIG.accessoryWords.concat(file.accessoryWordsExtra);
  }
  if (args.niche) cfg.niche = String(args.niche);
  if (args.marketplace) cfg.marketplace = String(args.marketplace);
  else if (!args.config && env.EBAY_MARKETPLACE) cfg.marketplace = env.EBAY_MARKETPLACE;
  if (args.q) cfg.queries = [].concat(args.q).map(String);
  if (args.discount) cfg.discount = Number(args.discount);
  if (args.comps) cfg.compsPerQuery = Number(args.comps);
  if (args.deliveryCountry !== undefined) cfg.deliveryCountry = String(args.deliveryCountry);
  return cfg;
}

/** Run a scan with an injected client — the CLI wraps this; tests call it directly. */
/** A query is a string or { q, exclude: [...] } — per-search words to drop (variants like "X4", "mini"). */
export function normQuery(entry) { return typeof entry === "string" ? { q: entry, exclude: [] } : { q: String(entry.q), exclude: entry.exclude || [] }; }

export async function runScan(client, cfg0, { log = console.log, now = () => Date.now(), watchlist = null, market = null } = {}) {
  const results = [];
  const stats = { queries: 0, listings: 0, candidates: 0, errors: 0, tracked: 0 };
  for (const entry of cfg0.queries) {
    const { q, exclude } = normQuery(entry);
    const cfg = exclude.length ? { ...cfg0, excludeWords: (cfg0.excludeWords || []).concat(exclude.map((w) => w.toLowerCase())) } : cfg0;
    if (watchlist) {
      // Entries tracked before an exclusion existed would keep polluting this search's median — drop them.
      for (let i = watchlist.length - 1; i >= 0; i--) if (watchlist[i].query === q && !relevant([watchlist[i]], q, cfg).length) watchlist.splice(i, 1);
    }
    stats.queries++;
    try {
      const filter = {
        buyingOptions: ["FIXED_PRICE"],
        conditions: cfg.conditions && cfg.conditions.length ? cfg.conditions : undefined,
        deliveryCountry: cfg.deliveryCountry || undefined,
      };
      // 1) Comps: eBay's best-match order gives the actual product, not the cheapest accessories.
      const { total, items } = await client.searchAll({ q, limit: Math.min(cfg.compsPerQuery, 200), filter }, cfg.compsPerQuery);
      stats.listings += items.length;
      const comps = relevant(items, q, cfg);
      // 2) Deals: a targeted look at the cheap band under the median, cheapest first.
      let extra = [];
      if (comps.length >= (cfg.minComps || 5) && cfg.cheapBandLimit > 0) {
        const far = new Set(cfg.farCountries || []);
        const near = comps.filter((l) => !far.has((l.location || "").toUpperCase()));
        const mid = median((near.length >= (cfg.minNearComps == null ? 3 : cfg.minNearComps) ? near : comps).map((l) => l.landed));
        const band = await client.search({
          q, limit: cfg.cheapBandLimit, sort: "price",
          filter: { ...filter, priceMin: Math.floor(mid * (cfg.minFraction == null ? 0.25 : cfg.minFraction)), priceMax: Math.ceil(mid * (1 - cfg.discount)), currency: cfg.currency || "EUR" },
        });
        extra = band.items;
        stats.listings += extra.length;
      }
      const found = findCandidates(q, items, cfg, now(), extra, market);
      stats.candidates += found.length;
      let added = 0;
      if (watchlist) { added = rememberComps(watchlist, q, comps, { now: now(), perQuery: cfg.watchPerQuery || 30 }); stats.tracked += added; }
      log("• " + q + ": " + comps.length + " comps from " + items.length + " sampled (" + total + " total), " + extra.length + " in the cheap band, " + found.length + " candidate(s)" + (watchlist ? ", +" + added + " tracked" : ""));
      results.push(...found);
    } catch (e) {
      stats.errors++;
      log("  ! " + q + ": " + e.message);
    }
  }
  results.sort((a, b) => (b.estResale - b.price) - (a.estResale - a.price));
  return { results, stats };
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.sandbox) process.env.EBAY_ENV = "sandbox";
  if (args.production) process.env.EBAY_ENV = "production";
  const dir = args.data ? String(args.data) : undefined;
  const out = args.out ? String(args.out) : dataPath("scan-results.json", dir);

  let results;
  if (args["dry-run"]) {
    console.log("[dry-run] no API calls; writing a sample result.");
    results = sampleResults();
  } else {
    // One config per --config (repeatable); none given → the CONFIG block above (+ any --q/--niche overrides).
    const configFiles = args.config ? [].concat(args.config).map(String) : [null];
    const cfgs = configFiles.map((f) => resolveConfig({ ...args, config: f || undefined }));
    let client;
    try { client = clientFromEnv(process.env, { marketplace: cfgs[0].marketplace, log: (m) => console.log("  · " + m) }); }
    catch (e) { console.error(e.message + "\n  Copy .env.example to .env and fill it in, or run with --dry-run."); process.exit(1); }
    const watchlist = loadWatchlist(dir), market = loadMarket(dir);
    results = [];
    const totals = { listings: 0, candidates: 0, tracked: 0, errors: 0 };
    for (const c of cfgs) {
      client.marketplace = c.marketplace;
      console.log(`\nScanning "${c.niche}" on ${c.marketplace} (${client.env}) — ${c.queries.length} queries, ≥${Math.round(c.discount * 100)}% under median, ≥€${c.minMarginEur} gap`);
      const r = await runScan(client, c, { watchlist, market });
      results.push(...r.results);
      for (const k of Object.keys(totals)) totals[k] += r.stats[k];
    }
    // One entry per listing: when two searches flag the same item, keep the more conservative estimate.
    const byId = new Map();
    for (const r of results) { const k = r.id || r.url || r.title; const prev = byId.get(k); if (!prev || r.estResale < prev.estResale) byId.set(k, r); }
    results = Array.from(byId.values());
    results.sort((a, b) => (b.estResale - b.price) - (a.estResale - a.price));
    saveWatchlist(watchlist, dir);
    console.log(`\n${totals.listings} listings sampled · ${totals.candidates} candidates · ${totals.tracked} new listings tracked (${watchlist.filter((e) => e.status === "active").length} active) · ${totals.errors} errors · ${client.calls.api} API calls (of ~5,000/day)`);
    if (!market) console.log("No tracked sales yet — run `node track.mjs` daily; after a couple of weeks estResale switches from median-asking to tracked sales.");
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log("Wrote " + out + " — " + results.length + " candidate(s). Import it into Scout's Discover tab.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
