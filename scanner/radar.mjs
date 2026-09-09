#!/usr/bin/env node
/*
 * radar.mjs — real eBay numbers for Demand Radar's "competition" side.
 *
 *   node radar.mjs "obsolete boiler PCB" "Vaillant ecoTEC PCB"
 *   node radar.mjs --used "Boss DS-1"
 *
 * For each niche/search it reports the figures Radar asks for that the Browse
 * API can supply: ACTIVE LISTINGS NOW and the MEDIAN ASKING price (plus the
 * spread). Sold-per-90-days and watchers are NOT in the Browse API — read those
 * off eBay Product Research (Seller Hub) as before. Writes radar-results.json too.
 */
import { writeFileSync } from "node:fs";
import { loadEnv, parseArgs } from "./env.mjs";
import { clientFromEnv } from "./ebay.mjs";
import { median } from "./scan.mjs";

loadEnv();
const args = parseArgs(process.argv.slice(2));
if (args.sandbox) process.env.EBAY_ENV = "sandbox";
const niches = args._;
if (!niches.length) { console.error('Usage: node radar.mjs "niche or search" ["another" ...] [--used] [--sandbox]'); process.exit(1); }

const client = clientFromEnv(process.env, { log: (m) => console.log("  · " + m) });
const out = [];
for (const n of niches) {
  try {
    const { total, items } = await client.searchAll({
      q: n, limit: 100, filter: { conditions: args.used ? ["USED"] : undefined, buyingOptions: ["FIXED_PRICE", "AUCTION", "BEST_OFFER"] },
    }, 100);
    const prices = items.map((i) => i.landed).filter((p) => isFinite(p) && p > 0).sort((a, b) => a - b);
    const row = {
      niche: n, active: total, sampled: prices.length,
      medianAsk: prices.length ? Math.round(median(prices)) : null,
      p25: prices.length ? Math.round(prices[Math.floor(prices.length * 0.25)]) : null,
      p75: prices.length ? Math.round(prices[Math.floor(prices.length * 0.75)]) : null,
      marketplace: client.marketplace, at: new Date().toISOString(),
    };
    out.push(row);
    console.log(`${n}\n  active listings now: ${row.active}   median asking: €${row.medianAsk}   (p25 €${row.p25} · p75 €${row.p75}, ${row.sampled} sampled)`);
  } catch (e) { console.error(`  ! ${n}: ${e.message}`); }
}
writeFileSync("radar-results.json", JSON.stringify(out, null, 2));
console.log(`\nWrote radar-results.json. Paste "Active listings now" and the median into Demand Radar; get "Sold / 90 days" from Seller Hub → Product Research. (${client.calls.api} API calls)`);
