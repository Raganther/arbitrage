#!/usr/bin/env node
/*
 * track.mjs — turn "live listings only" into your own sold-price history.
 *
 * Every scan records the comparable listings it saw into data/watchlist.json.
 * This script re-checks each one. A fixed-price listing that ends EARLY — before
 * the end date eBay gave it — almost certainly sold at its asking price. One
 * that runs to its end date and stops didn't sell. From those it computes, per
 * search:
 *   - sell-through   sold ÷ (sold + expired)           → Demand Radar's key input
 *   - estSold        median asking price of the ones that sold  → the real value
 *   - targetBuy      half of estSold (fees, postage, mistakes)  → your ceiling
 * and writes data/market.json, which the scanner then uses to flag deals.
 *
 *   node track.mjs                # check every active tracked listing (1 API call each)
 *   node track.mjs --max 150      # cap calls this run
 *   node track.mjs --report       # no API calls; just print the current market table
 */
import { loadEnv, parseArgs } from "./env.mjs";
import { clientFromEnv } from "./ebay.mjs";
import { median } from "./scan.mjs";
import { loadWatchlist, saveWatchlist, saveMarket, loadMarket, loadSold, dataPath } from "./store.mjs";

const DAY = 86_400_000;

/** Classify a fresh status against what we recorded. Pure; tested. */
export function classify(entry, s, now = Date.now()) {
  if (s.status === "active") {
    return { ...entry, status: "active", lastChecked: now, endsAt: s.endsAt || entry.endsAt, price: isFinite(s.price) ? s.price : entry.price };
  }
  if (s.status === "ended") {
    const scheduled = Date.parse(entry.endsAt || "") || 0;
    const endedEarly = scheduled - now > DAY;           // still had >1 day to run → it sold
    return { ...entry, status: endedEarly ? "sold-likely" : "expired", lastChecked: now, closedAt: now, closedPrice: endedEarly ? entry.landed : undefined };
  }
  return { ...entry, status: "removed", lastChecked: now, closedAt: now }; // gone: sold or withdrawn — not counted in prices
}

/** Per-query market read from the watchlist plus any verified sold prices (sold.json). Pure; tested. */
export function computeMarket(watchlist, now = Date.now(), cfg = {}, verified = {}) {
  const buyFraction = cfg.buyFraction == null ? 0.5 : cfg.buyFraction;
  const askToSold = cfg.askToSold == null ? 0.85 : cfg.askToSold;
  const minClosed = cfg.minClosed == null ? 3 : cfg.minClosed;
  const byQ = {};
  for (const e of watchlist) (byQ[e.query] = byQ[e.query] || []).push(e);
  for (const q of Object.keys(verified || {})) byQ[q] = byQ[q] || [];
  const out = {};
  for (const [q, es] of Object.entries(byQ)) {
    // Verified prices (looked up on ebay.ie by a human) outrank inferred ones; use the most recent 10.
    const ver = ((verified || {})[q] || []).map((v) => Number(v.price)).filter((p) => isFinite(p) && p > 0).slice(-10);
    const active = es.filter((e) => e.status === "active");
    const sold = es.filter((e) => e.status === "sold-likely");
    const expired = es.filter((e) => e.status === "expired");
    const removed = es.filter((e) => e.status === "removed");
    const closed = sold.length + expired.length;
    const medianAsk = active.length ? Math.round(median(active.map((e) => e.landed))) : (es.length ? Math.round(median(es.map((e) => e.landed))) : null);
    const inferred = sold.length >= minClosed ? Math.round(median(sold.map((e) => e.closedPrice))) : null;
    const estSold = ver.length >= minClosed ? Math.round(median(ver)) : ver.length && inferred != null ? Math.round(median(ver.concat(sold.map((e) => e.closedPrice)))) : inferred;
    const basis = ver.length >= minClosed ? "verified" : estSold != null ? "sold" : "proxy";
    const value = estSold != null ? estSold : (medianAsk != null ? Math.round(medianAsk * askToSold) : null);
    const oldest = Math.min(...es.map((e) => e.firstSeen || now));
    out[q] = {
      query: q, tracked: es.length, active: active.length, soldLikely: sold.length, expired: expired.length, removed: removed.length,
      daysTracked: Math.round((now - oldest) / DAY),
      sellThrough: closed >= minClosed ? Math.round((sold.length / closed) * 100) : null,
      medianAsk, estSold, basis, verifiedCount: ver.length,
      targetBuy: value != null ? Math.round(value * buyFraction) : null,
      updatedAt: now,
    };
  }
  return out;
}

export function printMarket(market) {
  const rows = Object.values(market).sort((a, b) => (b.sellThrough || 0) - (a.sellThrough || 0));
  const f = (v, suf = "") => (v == null ? "  —" : String(v) + suf);
  console.log("\n" + "query".padEnd(30) + "tracked  active  sold  expired  removed  sell-thru  median-ask  est-sold  target-buy");
  for (const r of rows) {
    console.log(r.query.slice(0, 29).padEnd(30) + String(r.tracked).padStart(7) + String(r.active).padStart(8) + String(r.soldLikely).padStart(6) +
      String(r.expired).padStart(9) + String(r.removed).padStart(9) + f(r.sellThrough, "%").padStart(11) + f(r.medianAsk, "€").padStart(12) +
      (r.estSold == null ? "  proxy" : f(r.estSold, "€") + (r.basis === "verified" ? "✓" : " ")).padStart(10) + f(r.targetBuy, "€").padStart(12));
  }
  console.log("\nest-sold: ✓ = from sold prices you entered (node sold.mjs); otherwise median asking of tracked listings that ended early (sold).\n'proxy' = not enough sales yet; target-buy then uses 85% of median asking.\ntarget-buy = half the estimated sold price: the most you pay, all-in, to keep ~30%+ margin after fees and postage.");
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.sandbox) process.env.EBAY_ENV = "sandbox";
  const dir = args.data ? String(args.data) : undefined;
  const watchlist = loadWatchlist(dir);
  if (args.report) { printMarket(computeMarket(watchlist, Date.now(), {}, loadSold(dir))); return; }
  if (!watchlist.length) { console.log("Nothing tracked yet — run a scan first (node scan.mjs); it records the comps it sees into " + dataPath("watchlist.json", dir)); return; }

  const client = clientFromEnv(process.env, { log: (m) => console.log("  · " + m) });
  const max = args.max ? Number(args.max) : Infinity;
  const now = Date.now();
  // Oldest-checked first, so a capped run still cycles through everything over time.
  const due = watchlist.filter((e) => e.status === "active").sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0)).slice(0, max);
  const changes = { sold: 0, expired: 0, removed: 0, errors: 0 };
  for (const e of due) {
    try {
      const s = await client.itemStatus(e.itemId || e.url || e.id);
      const next = classify(e, s, now);
      if (next.status !== e.status) {
        changes[next.status === "sold-likely" ? "sold" : next.status]++;
        console.log(`${next.status === "sold-likely" ? "SOLD? " : next.status === "expired" ? "UNSOLD" : "GONE  "}  €${e.landed}  ${e.title.slice(0, 60)}  [${e.query}]`);
      }
      Object.assign(e, next);
    } catch (err) { changes.errors++; console.log("  ! " + e.title.slice(0, 50) + ": " + err.message); }
  }
  saveWatchlist(watchlist, dir);
  const market = computeMarket(watchlist, now, {}, loadSold(dir));
  saveMarket(market, dir);
  console.log(`\nChecked ${due.length} of ${watchlist.filter((e) => e.status === "active").length} active · ${changes.sold} likely sold · ${changes.expired} expired · ${changes.removed} removed · ${changes.errors} errors · ${client.calls.api} API calls`);
  printMarket(market);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.message || e); process.exit(1); });
