#!/usr/bin/env node
/*
 * sold.mjs — feed the robot real sold prices you looked up on ebay.ie.
 *
 *   node sold.mjs "Boss DS-1" 65 70 62 58        # four recent sold prices, in EUR, incl. postage if shown
 *   node sold.mjs --list                         # what's been entered
 *
 * How to get them: ebay.ie → search the model → filters → tick "Sold items" →
 * read the last handful of prices. Enter what buyers actually paid.
 * Verified prices outrank the tracker's "ended early = sold" guesses: once a
 * search has 3+, estSold comes from them and targetBuy follows.
 */
import { parseArgs } from "./env.mjs";
import { loadSold, saveSold, loadWatchlist, saveMarket, dataPath } from "./store.mjs";
import { computeMarket, printMarket } from "./track.mjs";

const args = parseArgs(process.argv.slice(2));
const dir = args.data ? String(args.data) : undefined;
const sold = loadSold(dir);

if (args.list || !args._.length) {
  if (!Object.keys(sold).length) console.log('No verified sold prices yet. Usage: node sold.mjs "Boss DS-1" 65 70 62');
  for (const [q, arr] of Object.entries(sold)) console.log(q.padEnd(30) + arr.map((s) => "€" + s.price).join("  ") + "   (" + arr.length + ")");
  process.exit(0);
}

const [q, ...nums] = args._;
const prices = nums.map(Number).filter((n) => isFinite(n) && n > 0);
if (!prices.length) { console.error('Give the search then prices: node sold.mjs "Boss DS-1" 65 70 62'); process.exit(1); }
const now = Date.now();
sold[q] = (sold[q] || []).concat(prices.map((price) => ({ price, at: now })));
saveSold(sold, dir);
const market = computeMarket(loadWatchlist(dir), now, {}, sold);
saveMarket(market, dir);
console.log(`Recorded ${prices.length} sold price(s) for "${q}" → ${dataPath("sold.json", dir)}`);
if (market[q]) console.log(`"${q}": est. sold €${market[q].estSold} (${market[q].basis}) · target buy ≤€${market[q].targetBuy}`);
else console.log(`"${q}" isn't in the watchlist yet — add it to the scan queries so listings get tracked too.`);
