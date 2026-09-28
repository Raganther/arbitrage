#!/usr/bin/env node
/*
 * Scout scanner — finds candidate arbitrage listings on eBay for a niche.
 *
 * How it works (honestly):
 *   The eBay Browse API gives ACTIVE listings only (never final sold prices).
 *   So this scanner spots deals relative to the crowd: for each specific item,
 *   it pulls current listings and takes the MEDIAN landed price (item + postage).
 *   Used items SELL for ~60% of that median asking (verified Sep 2026), so the
 *   value is verified sold prices when we have them, else 0.6 × median asking.
 *   A listing is a candidate only if buying it (landed, plus Irish import VAT
 *   for non-EU sellers) and reselling it at that value clears a minimum NET
 *   profit and ROI after selling fees, postage and packaging. It also looks at
 *   auctions ending soon (with a max bid) and misspelled titles, where the real
 *   mispricing on eBay tends to be. Still a candidate, not a guarantee — you
 *   confirm the real resale value (eBay SOLD comps) in Scout.
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
  // Calibrated on verified sold prices (Sep 2026: SM58, Scarlett 2i2, Ideal Logic fan, Vaillant boards):
  // used items SELL for roughly 45–70% of the median ASKING price. With no verified or tracked sales for a
  // search, the resale value is askToSold × the median asking.
  askToSold: 0.6,
  // Reselling costs (eBay.ie defaults — check whether private-seller fees still apply to you).
  sellFeePct: 0.13,
  sellFixedFee: 0.35,
  sellPostage: null,     // postage you pay when you sell; null → assumedPostage.home
  packaging: 1,
  // A candidate must clear BOTH, after buy cost, import VAT, selling fees, postage and packaging.
  minProfitEur: 15,
  minRoi: 0.3,
  // Irish VAT on goods from outside the EU — GB since Brexit (Northern Ireland, BT postcodes, excepted).
  // eBay adds it at checkout, so the listed price doesn't show it. Customs duty over €150 isn't modelled.
  importVat: 0.23,
  discount: 0.50,        // the cheap-band search looks at listings up to this far under the median asking
  maxPerQuery: 3,        // keep at most this many candidates per query
  // Auctions ending soon: the current bid is not the final price, so these come with a max bid.
  auctions: true,
  auctionHours: 24,
  auctionLimit: 50,
  // Misspelled titles get fewer buyers. Each word here is swapped for each typo to make extra searches
  // (eBay's auto-correct is off for these). Per-niche maps live in the config files.
  typos: {},
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
  euCountries: ["IE", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
  nearCountries: ["GB"],    // not EU (import VAT applies) but postage is priced like the EU tier
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
  const tier = loc === (cfg.homeCountry || "IE") ? "home" : (cfg.euCountries || []).includes(loc) || (cfg.nearCountries || []).includes(loc) ? "eu" : "other";
  const est = Number(cfg.assumedPostage[tier]);
  if (!isFinite(est)) return l;
  return { ...l, landed: l.price + est, assumedShipping: est };
}

/** Keep only listings that look like the actual product in sellable condition. */
export function relevant(listings, q, cfg) {
  return listings.map((l) => withAssumedPostage(l, cfg)).filter((l) => isFinite(l.landed) && l.landed > 0 &&
    !looksBroken(l.title, cfg.excludeWords || []) &&
    !looksBroken(l.cond || "", ["parts", "not working", "defective", "faulty"]) && String(l.conditionId) !== "7000" &&
    !looksAccessory(l.title, l.matchQuery || q, cfg.accessoryWords || []) &&
    (cfg.requireQueryWords === false || matchesQuery(l.title, l.matchQuery || q)));
}

export const isAuction = (l) => (l.buyingOptions || []).includes("AUCTION") && !(l.buyingOptions || []).includes("FIXED_PRICE");

/** Irish import VAT owed on a listing's landed price: 0 from the EU (and Northern Ireland) or an unknown origin. */
export function importTax(l, cfg) {
  const rate = Number(cfg.importVat) || 0;
  const loc = (l.location || "").toUpperCase();
  if (!rate || !loc || !isFinite(l.landed) || (cfg.euCountries || []).includes(loc)) return 0;
  if (loc === "GB" && /^BT/i.test(l.postcode || "")) return 0;
  return l.landed * rate;
}

/**
 * Flip economics for a resale value: what you net after selling fees, postage and packaging, and the most you
 * can pay all-in (landed + import VAT) and still clear minProfitEur and minRoi. Pure; tested.
 */
export function flipEconomics(value, cfg) {
  const post = cfg.sellPostage != null ? cfg.sellPostage : (cfg.assumedPostage && cfg.assumedPostage.home != null ? cfg.assumedPostage.home : 8);
  const fees = value * (cfg.sellFeePct ?? 0.13) + (cfg.sellFixedFee ?? 0.35);
  const proceeds = value - fees - post - (cfg.packaging ?? 1);
  const maxCost = Math.min(proceeds - (cfg.minProfitEur ?? 15), proceeds / (1 + (cfg.minRoi ?? 0.3)));
  return { proceeds, maxCost, fees, postage: post };
}

/** Typo variants of a query from a { word: [typos] } map — one search each. */
export function typoQueries(q, typos = {}) {
  const out = [];
  for (const [word, list] of Object.entries(typos || {})) {
    const re = new RegExp("(^|\\s)" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$)", "i");
    if (re.test(q)) for (const t of [].concat(list)) out.push(q.replace(re, "$1" + t));
  }
  return out;
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
  const askToSold = cfg.askToSold == null ? 0.6 : cfg.askToSold;
  const tracked = !!(mk && mk.estSold);
  const value = tracked ? mk.estSold : Math.round(mid * askToSold);
  const basis = !tracked ? "asking-x" + askToSold : mk.basis === "verified" ? "verified-sales" : "tracked-sales";
  const econ = flipEconomics(value, cfg);
  // The stricter of the profit ceiling and the market's targetBuy.
  const maxCost = mk ? Math.min(econ.maxCost, mk.targetBuy) : econ.maxCost;
  if (!(maxCost > 0)) return [];
  const floor = mid * (cfg.minFraction == null ? 0.25 : cfg.minFraction);
  const seen = new Set();
  const pool = clean.concat(relevant(extra, q, cfg)).filter((l) => { const k = l.itemId || l.url || l.title; if (seen.has(k)) return false; seen.add(k); return true; });
  const eur = (n) => "€" + Math.round(n);
  return pool
    .map((l) => { const vat = importTax(l, cfg); return { l, vat, cost: l.landed + vat, auction: isAuction(l) }; })
    // An auction's low current bid is expected, so the too-cheap-to-be-real floor applies to fixed prices only.
    .filter((x) => x.cost <= maxCost && (x.auction || x.l.landed >= floor))
    .map((x) => ({ ...x, net: econ.proceeds - x.cost }))
    .sort((a, b) => b.net - a.net)
    .slice(0, cfg.maxPerQuery)
    .map(({ l, vat, cost, auction, net }) => {
      const shipNote = l.assumedShipping != null ? "postage not stated, ~€" + l.assumedShipping + " assumed" :
        l.shipping == null ? "postage unknown" : l.shipping === 0 ? "free postage" : "incl. €" + l.shipping.toFixed(2) + " postage";
      const ship = l.assumedShipping != null ? l.assumedShipping : l.shipping || 0;
      const maxBid = auction ? Math.floor(maxCost / (1 + (vat ? cfg.importVat : 0)) - ship) : undefined;
      const roi = Math.round((net / cost) * 100);
      const lead = (l.matchQuery && l.matchQuery !== q ? "Misspelled title (\"" + l.matchQuery + "\") — fewer buyers find it. " : "") +
        (auction ? "Auction, " + (l.bidCount || 0) + " bid" + (l.bidCount === 1 ? "" : "s") + (l.endsAt ? ", ends " + l.endsAt.slice(0, 16).replace("T", " ") + " UTC" : "") +
          ": current bid €" + Math.round(l.price) + " (" + shipNote + "). Bid up to €" + maxBid + ". " :
          "Listed at €" + Math.round(l.price) + " (" + shipNote + "). ");
      return {
        id: l.legacyItemId ? "ebay-" + l.legacyItemId : undefined,
        title: l.title,
        price: Math.round(cost * 100) / 100,   // all-in: item + postage to you + import VAT
        estResale: value,
        estBasis: basis,
        targetBuy: Math.floor(maxCost),
        netProfit: Math.round(net),
        roi,
        ...(auction ? { auction: true, maxBid, bidCount: l.bidCount || 0 } : {}),
        ...(l.matchQuery && l.matchQuery !== q ? { typo: l.matchQuery } : {}),
        cond: l.cond,
        soldQuery: q,
        category: cfg.niche,
        source: "eBay",
        url: l.url,
        image: l.image || "",
        itemId: l.itemId || "",
        endsAt: l.endsAt || "",
        reasoning: lead + (vat ? "+" + eur(vat) + " import VAT (ships from " + l.location + "). " : "") +
          "Worth ~" + eur(value) + " (" + (tracked ? (mk.basis === "verified" ? "verified sold prices" : "tracked sales, capped") : Math.round(askToSold * 100) + "% of the " + eur(mid) + " median asking") +
          "); after " + eur(econ.fees) + " fees and " + eur(econ.postage) + " postage it nets ~" + eur(econ.proceeds) + ", so ~" + eur(net) + " profit (" + roi + "% ROI) on " + eur(cost) +
          " all-in. Ceiling " + eur(maxCost) + ". Median asking " + eur(mid) + " across " + comps.length + " comps" + (useNear ? " (" + (clean.length - near.length) + " overseas asks excluded)" : "") +
          (l.location && !vat ? ", ships from " + l.location : "") + ". Confirm in sold listings.",
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

const au_n = (xs) => xs.filter(isAuction).length;
const typo_n = (xs) => xs.filter((l) => l.matchQuery).length;
export const byProfit = (a, b) => (b.netProfit ?? b.estResale - b.price) - (a.netProfit ?? a.estResale - a.price);

export async function runScan(client, cfg0, { log = console.log, now = () => Date.now(), watchlist = null, market = null } = {}) {
  const results = [];
  const stats = { queries: 0, listings: 0, candidates: 0, errors: 0, tracked: 0, auctions: 0, typos: 0 };
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
      // 3) Auctions ending soon — valued against the fixed-price comps above, never part of them.
      if (comps.length >= (cfg.minComps || 5) && cfg.auctions) {
        const until = new Date(now() + (cfg.auctionHours || 24) * 3600_000).toISOString();
        const au = await client.search({ q, limit: cfg.auctionLimit || 50, sort: "endingSoonest",
          filter: { ...filter, buyingOptions: ["AUCTION"], raw: "itemEndDate:[.." + until + "]" } });
        const auctions = au.items.filter(isAuction);
        stats.listings += auctions.length; stats.auctions += auctions.length;
        extra = extra.concat(auctions);
      }
      // 4) Misspelled titles: auto-correct off, matched against the typo, valued against the real product.
      if (comps.length >= (cfg.minComps || 5)) {
        for (const tq of typoQueries(q, cfg.typos)) {
          const ty = await client.search({ q: tq, limit: 50, autoCorrect: false, filter: { ...filter, buyingOptions: ["FIXED_PRICE", "AUCTION"] } });
          const hits = ty.items.filter((l) => !matchesQuery(l.title, q)).map((l) => ({ ...l, matchQuery: tq }));
          stats.listings += hits.length; stats.typos += hits.length;
          extra = extra.concat(hits);
        }
      }
      const found = findCandidates(q, items, cfg, now(), extra, market);
      stats.candidates += found.length;
      let added = 0;
      if (watchlist) { added = rememberComps(watchlist, q, comps, { now: now(), perQuery: cfg.watchPerQuery || 30 }); stats.tracked += added; }
      log("• " + q + ": " + comps.length + " comps from " + items.length + " sampled (" + total + " total), " + extra.length + " in the cheap band, " + (cfg.auctions ? au_n(extra) + " auctions, " : "") + typo_n(extra) + " misspelled, " + found.length + " candidate(s)" + (watchlist ? ", +" + added + " tracked" : ""));
      results.push(...found);
    } catch (e) {
      stats.errors++;
      log("  ! " + q + ": " + e.message);
    }
  }
  results.sort(byProfit);
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
    const totals = { listings: 0, candidates: 0, tracked: 0, errors: 0, auctions: 0, typos: 0 };
    for (const c of cfgs) {
      client.marketplace = c.marketplace;
      console.log(`\nScanning "${c.niche}" on ${c.marketplace} (${client.env}) — ${c.queries.length} queries, ≥€${c.minProfitEur} net profit and ≥${Math.round(c.minRoi * 100)}% ROI after fees, postage and import VAT${c.auctions ? ", auctions ending within " + c.auctionHours + "h" : ""}`);
      const r = await runScan(client, c, { watchlist, market });
      results.push(...r.results);
      for (const k of Object.keys(totals)) totals[k] += r.stats[k];
    }
    // One entry per listing: when two searches flag the same item, keep the more conservative estimate.
    const byId = new Map();
    for (const r of results) { const k = r.id || r.url || r.title; const prev = byId.get(k); if (!prev || r.estResale < prev.estResale) byId.set(k, r); }
    results = Array.from(byId.values());
    results.sort(byProfit);
    saveWatchlist(watchlist, dir);
    console.log(`\n${totals.listings} listings sampled (${totals.auctions} auctions, ${totals.typos} misspelled) · ${totals.candidates} candidates · ${totals.tracked} new listings tracked (${watchlist.filter((e) => e.status === "active").length} active) · ${totals.errors} errors · ${client.calls.api} API calls (of ~5,000/day)`);
    if (!market) console.log("No tracked sales yet — run `node track.mjs` daily; after a couple of weeks estResale switches from median-asking to tracked sales.");
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log("Wrote " + out + " — " + results.length + " candidate(s). Import it into Scout's Discover tab.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
