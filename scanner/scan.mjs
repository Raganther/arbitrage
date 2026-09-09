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

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv, parseArgs } from "./env.mjs";
import { clientFromEnv } from "./ebay.mjs";

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
  discount: 0.30,        // flag listings >= 30% below the median landed price
  minMarginEur: 15,      // and at least this many EUR below it
  maxPerQuery: 3,        // keep at most this many candidates per query
  excludeWords: ["parts", "spares", "repair", "faulty", "broken", "not working", "for parts", "case only", "box only", "manual only"],
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

/** Turn one query's listings into discovery docs (pure; unit-tested). */
export function findCandidates(q, listings, cfg = DEFAULT_CONFIG, now = Date.now()) {
  const clean = listings.filter((l) => isFinite(l.landed) && l.landed > 0 && !looksBroken(l.title, cfg.excludeWords || []));
  if (clean.length < (cfg.minComps || 5)) return [];
  const mid = median(clean.map((l) => l.landed));
  const threshold = mid * (1 - cfg.discount);
  return clean
    .filter((l) => l.landed <= threshold && (mid - l.landed) >= cfg.minMarginEur)
    .sort((a, b) => (mid - b.landed) - (mid - a.landed))
    .slice(0, cfg.maxPerQuery)
    .map((l) => {
      const under = Math.round((1 - l.landed / mid) * 100);
      const shipNote = l.shipping == null ? "postage unknown" : l.shipping === 0 ? "free postage" : "incl. €" + l.shipping.toFixed(2) + " postage";
      return {
        id: l.legacyItemId ? "ebay-" + l.legacyItemId : undefined,
        title: l.title,
        price: Math.round(l.landed * 100) / 100,   // landed = item + postage to you
        estResale: Math.round(mid),                // proxy: median landed asking — VERIFY vs sold comps
        cond: l.cond,
        soldQuery: q,
        category: cfg.niche,
        source: "eBay",
        url: l.url,
        image: l.image || "",
        itemId: l.itemId || "",
        endsAt: l.endsAt || "",
        reasoning: "Listed at €" + Math.round(l.price) + " (" + shipNote + "), ~" + under + "% under the €" +
          Math.round(mid) + " median for \"" + q + "\" (" + clean.length + " comps" + (l.location ? ", ships from " + l.location : "") +
          "). Confirm real value in sold listings.",
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
  if (args.config) cfg = { ...cfg, ...JSON.parse(readFileSync(String(args.config), "utf8")) };
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
export async function runScan(client, cfg, { log = console.log, now = () => Date.now() } = {}) {
  const results = [];
  const stats = { queries: 0, listings: 0, candidates: 0, errors: 0 };
  for (const q of cfg.queries) {
    stats.queries++;
    try {
      const { total, items } = await client.searchAll({
        q,
        limit: Math.min(cfg.compsPerQuery, 200),
        sort: "price",  // cheapest first — the deals are at this end
        filter: {
          buyingOptions: ["FIXED_PRICE"],
          conditions: cfg.conditions && cfg.conditions.length ? cfg.conditions : undefined,
          deliveryCountry: cfg.deliveryCountry || undefined,
        },
      }, cfg.compsPerQuery);
      stats.listings += items.length;
      const found = findCandidates(q, items, cfg, now());
      stats.candidates += found.length;
      log("• " + q + ": " + items.length + " of " + total + " listings sampled, " + found.length + " candidate(s)");
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
  const out = args.out ? String(args.out) : "scan-results.json";
  const cfg = resolveConfig(args);

  let results;
  if (args["dry-run"]) {
    console.log("[dry-run] no API calls; writing a sample result.");
    results = sampleResults();
  } else {
    let client;
    try { client = clientFromEnv(process.env, { marketplace: cfg.marketplace, log: (m) => console.log("  · " + m) }); }
    catch (e) { console.error(e.message + "\n  Copy .env.example to .env and fill it in, or run with --dry-run."); process.exit(1); }
    console.log(`Scanning "${cfg.niche}" on ${cfg.marketplace} (${client.env}) — ${cfg.queries.length} queries, ≥${Math.round(cfg.discount * 100)}% under median, ≥€${cfg.minMarginEur} gap`);
    const r = await runScan(client, cfg);
    results = r.results;
    console.log(`\n${r.stats.listings} listings sampled · ${r.stats.candidates} candidates · ${r.stats.errors} errors · ${client.calls.api} API calls (of ~5,000/day)`);
    if (r.stats.errors === r.stats.queries && r.stats.queries) process.exit(1);
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log("Wrote " + out + " — " + results.length + " candidate(s). Import it into Scout's Discover tab.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
