#!/usr/bin/env node
/*
 * radar.mjs — real eBay numbers for Demand Radar's "competition" side, and for
 * comparing candidate niches against each other.
 *
 *   node radar.mjs "obsolete boiler PCB" "Vaillant ecoTEC PCB"
 *   node radar.mjs --used --file niches.txt        # one query per line: "domain | query"
 *
 * Per search it reports what the Browse API CAN supply: ACTIVE LISTINGS NOW
 * (competition), MEDIAN ASKING (price room), the p25–p75 SPREAD (how mispriced
 * the market is — wide spread = more bargains), and where listings ship from
 * (IE/GB share = cheap postage, and a hint at local sourcing). Sold-per-90-days
 * and watchers are NOT in the Browse API — read those off eBay Product Research
 * (Seller Hub). Writes radar-results.json.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { loadEnv, parseArgs } from "./env.mjs";
import { clientFromEnv } from "./ebay.mjs";
import { median, relevant, DEFAULT_CONFIG } from "./scan.mjs";

loadEnv();
const args = parseArgs(process.argv.slice(2));
if (args.sandbox) process.env.EBAY_ENV = "sandbox";
let targets = args._.map((q) => ({ domain: "", q }));
if (args.file) {
  for (const line of readFileSync(String(args.file), "utf8").split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const [a, b] = t.split("|").map((s) => s.trim());
    targets.push(b ? { domain: a, q: b } : { domain: "", q: a });
  }
}
if (!targets.length) { console.error('Usage: node radar.mjs "niche or search" ["another" ...] [--used] [--file niches.txt] [--sandbox]'); process.exit(1); }

const client = clientFromEnv(process.env, { log: (m) => console.log("  · " + m) });
const cfg = { ...DEFAULT_CONFIG, requireQueryWords: args.loose ? false : true };
const out = [];
for (const { domain, q } of targets) {
  try {
    const { total, items } = await client.searchAll({
      q, limit: 100, filter: { conditions: args.used ? ["USED"] : undefined, buyingOptions: ["FIXED_PRICE"], deliveryCountry: args.anywhere ? undefined : "IE" },
    }, 100);
    const rel = relevant(items, q, cfg);
    const prices = rel.map((i) => i.landed).filter((p) => isFinite(p) && p > 0).sort((a, b) => a - b);
    const n = prices.length;
    const loc = {}; for (const i of rel) { const c = (i.location || "??").toUpperCase(); loc[c] = (loc[c] || 0) + 1; }
    const share = (cs) => n ? Math.round(100 * cs.reduce((s, c) => s + (loc[c] || 0), 0) / n) : 0;
    const p25 = n ? prices[Math.floor(n * 0.25)] : null, p75 = n ? prices[Math.floor(n * 0.75)] : null;
    const row = {
      domain, query: q, active: total, sampled: items.length, relevant: n,
      medianAsk: n ? Math.round(median(prices)) : null, p25: p25 != null ? Math.round(p25) : null, p75: p75 != null ? Math.round(p75) : null,
      spread: p25 ? Math.round((p75 / p25) * 100) / 100 : null,
      shareIE: share(["IE"]), shareGB: share(["GB"]), shareEU: share(DEFAULT_CONFIG.euCountries.filter((c) => c !== "IE" && c !== "GB")),
      marketplace: client.marketplace, at: new Date().toISOString(),
    };
    out.push(row);
    console.log(`${(domain ? domain + " · " : "") + q}\n  active: ${row.active}  median: €${row.medianAsk}  p25–p75: €${row.p25}–€${row.p75} (spread ×${row.spread})  from IE ${row.shareIE}% · GB ${row.shareGB}% · EU ${row.shareEU}%  (${n} relevant of ${items.length})`);
  } catch (e) { console.error(`  ! ${q}: ${e.message}`); }
}
writeFileSync("radar-results.json", JSON.stringify(out, null, 2));
console.log(`\nWrote radar-results.json (${client.calls.api} API calls). "Sold / 90 days" still comes from Seller Hub → Product Research.`);
