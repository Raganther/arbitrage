#!/usr/bin/env node
/*
 * lots.mjs — job lots & bundles.
 *
 * The plain scan asks "is this one item cheap next to its peers?". A lot is a different bet: someone sells
 * several things as one listing, buyers can't be bothered, and the pieces are worth more apart. This script:
 *
 *   1. searches eBay for lot-style listings in each niche ("guitar pedals job lot", "boiler spares bundle" …),
 *   2. reads each listing's title + description,
 *   3. finds every item we already have a price for (data/market.json — verified sold prices first, otherwise
 *      the tracker's estimate, otherwise 60% of the median asking, which is what used gear actually sells for),
 *   4. adds them up, and flags the lot when the landed price is well under the sum of the parts we recognise.
 *
 * Only recognised items count. A lot of ten pedals where we know two is valued on those two — the rest is upside,
 * not a reason to buy. Prices are estimates until you check the sold listings; the reasoning says what was counted.
 *
 * Run:  node lots.mjs --config configs/music-gear.json --config configs/trade-parts.json
 *       node lots.mjs --config configs/music-gear.json --max-lots 20 --no-detail   # titles only, fewer calls
 * Out:  data/lot-results.json (Scout discovery docs; publish.mjs picks them up) and data/lot-review.json (every lot seen).
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, parseArgs } from "./env.mjs";
import { clientFromEnv } from "./ebay.mjs";
import { loadMarket, dataPath } from "./store.mjs";
import { existsSync } from "node:fs";
import { matchesQuery, withAssumedPostage, relevant, median, resolveConfig, DEFAULT_CONFIG } from "./scan.mjs";

export const LOT_DEFAULTS = {
  // Title words that say "several things in one listing".
  lotWords: ["job lot", "joblot", "bundle", "lot of", "collection", "clearance", "spares lot", "mixed lot", "pedals lot", "parts lot", "x2", "x3", "x4", "x5", "x6", "2x", "3x", "4x", "5x", "6x", "pair of", "set of"],
  // Fallback searches when a niche config has no lotSearches.
  lotSearches: (niche) => [niche.replace(/-/g, " ") + " job lot", niche.replace(/-/g, " ") + " bundle"],
  perSearch: 50,          // listings per lot search (1 call each)
  maxLots: 60,            // listings whose description we fetch per niche (1 call each); titles naming a priced item go first
  detail: true,           // fetch descriptions (titles rarely list the contents)
  askToSold: 0.6,         // asking → sold ratio for items with no verified/tracked price (calibrated Sep 2026)
  valueFraction: 0.6,     // lot must cost ≤ 60% of the recognised contents — fees ~15%, postage out, your time
  minMarginEur: 25,
  minKnownItems: 1,       // recognised items needed before a lot can be a candidate
  maxQty: 10,             // "x50" is a wholesaler, not a lot for you
  priceListDays: 7,       // re-price the extra catalogue (lotCatalogue in a config) this often — 1 call per item
  // "Shure SM58 pouch", "diverter valve motor adaptor": the item's name followed by one of these is an accessory, not the item.
  accessoryWords: DEFAULT_CONFIG.accessoryWords.concat(["pouch", "pouches", "motor", "actuator", "head", "housing", "kit for", "fits", "for use with", "software", "plugin", "plug-in", "licence", "license"]),
  excludeWords: ["for parts", "not working", "faulty", "spares or repair", "spares/repair", "untested", "broken", "empty", "box only", "case only", "manual only"],
};

/**
 * Build the price list: { item → { est, basis } } from market.json (verified sold > tracked > 60% of asking) plus
 * pricelist.json (items priced just for lots: 60% of asking). Skips anything with no price at all.
 */
export function catalogue(market, askToSold = LOT_DEFAULTS.askToSold, pricelist = {}) {
  const out = {};
  for (const [q, p] of Object.entries(pricelist || {})) if (p && p.medianAsk) out[q] = { est: Math.round(p.medianAsk * askToSold), basis: "asking×" + askToSold };
  for (const [q, m] of Object.entries(market || {})) {
    if (!m) continue;
    if (m.estSold) out[q] = { est: Math.round(m.estSold), basis: m.basis === "verified" ? "verified" : "tracked" };
    else if (m.medianAsk) out[q] = { est: Math.round(m.medianAsk * askToSold), basis: "asking×" + askToSold };
  }
  return out;
}

/**
 * Price extra items for the catalogue (a config's lotCatalogue): one search each, median landed asking of the
 * real-product comps, cached in data/pricelist.json for priceListDays. Returns the number of items (re)priced.
 */
export async function priceList(client, names, cfg, cache, { now = Date.now(), log = console.log } = {}) {
  let n = 0;
  for (const name of names) {
    const c = cache[name];
    if (c && now - c.at < (cfg.priceListDays || 7) * 86_400_000) continue;
    try {
      const { items } = await client.search({ q: name, limit: 40, filter: { buyingOptions: ["FIXED_PRICE"], conditions: ["USED"], deliveryCountry: cfg.deliveryCountry || undefined } });
      const comps = relevant(items, name, cfg);
      cache[name] = comps.length >= (cfg.minComps || 5) ? { medianAsk: Math.round(median(comps.map((l) => l.landed))), n: comps.length, at: now } : { medianAsk: null, n: comps.length, at: now };
      n++;
    } catch (e) { log("  ! price " + name + ": " + e.message); }
  }
  return n;
}

export function stripHtml(html) {
  return String(html || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

const words = (q) => String(q).toLowerCase().split(/\s+/).filter(Boolean);
const hasPartNo = (q) => /\b\d{5,}\b/.test(String(q));

/** The query as a loose phrase — its words in order, up to 30 characters apart on one line — so we can see what sits
 *  right before the first word / after the last ("2x Boss DS-1", "Boss DS-1 x2"). */
function phraseRegex(q) {
  const body = words(q).map((w) => {
    const parts = w.match(/[a-z]+|[0-9]+/g) || [];
    return (/^[0-9]/.test(w) ? "(?:^|[^0-9])" : "(?:^|[^a-z0-9])") + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9]?") + (/[0-9]$/.test(w) ? "(?![0-9])" : "");
  }).join("[^\n]{0,30}?");
  return new RegExp(body, "g");
}

/** How many of this item does the text claim? "2x Boss DS-1", "Boss DS-1 x2", "two Boss DS-1"; 1 when unstated; 0 when absent. */
export function quantityNear(text, q, maxQty = LOT_DEFAULTS.maxQty) {
  const t = String(text).toLowerCase();
  if (!matchesQuery(t, q)) return 0;
  const re = phraseRegex(q);
  let best = 1, m;
  const numWord = { two: 2, three: 3, four: 4, five: 5, six: 6, pair: 2 };
  while ((m = re.exec(t))) {
    const lead = /^[a-z0-9]/.test(m[0]) ? 0 : 1;
    const start = m.index + lead, end = re.lastIndex;
    const before = t.slice(Math.max(0, start - 12), start), after = t.slice(end, end + 12);
    let n = 1;
    const b = before.match(/(\d{1,2})\s*(?:x|×|\*)\s*$/) || before.match(/\b(two|three|four|five|six|pair(?: of)?)\s+$/);
    const a = after.match(/^\s*(?:x|×|\*)\s*(\d{1,2})\b/) || after.match(/^\s*\(\s*(\d{1,2})\s*\)/);
    if (b) n = numWord[b[1].replace(" of", "")] || Number(b[1]);
    else if (a) n = Number(a[1]);
    if (n > best) best = n;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return Math.min(best, maxQty);
}

/**
 * Is every mention of this item followed by an accessory word? In the title (first line) look 60 characters on;
 * in the description 30, stopping at a line break or comma. "6 x Shure SM58 … mic pouch" → true.
 */
export function accessoryOnly(text, q, accWords = LOT_DEFAULTS.accessoryWords) {
  const t = String(text).toLowerCase();
  const firstLineEnd = t.indexOf("\n") < 0 ? t.length : t.indexOf("\n");
  const re = phraseRegex(q);
  let m, hits = 0, acc = 0;
  while ((m = re.exec(t))) {
    hits++;
    const end = re.lastIndex;
    const inTitle = m.index < firstLineEnd;
    let after = t.slice(end, end + (inTitle ? 60 : 30));
    if (!inTitle) after = after.split(/[\n,]/)[0];
    after = " " + after.replace(/[^a-z0-9]+/g, " ") + " ";
    if (accWords.some((w) => after.includes(" " + w + " "))) acc++;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return hits > 0 && acc === hits;
}

/**
 * Which priced items does this lot contain, and how many of each? Pure; tested.
 * Drops an entry when a more specific one also matched: "Focusrite Scarlett 2i2" gives way to "… 2i2 3rd Gen",
 * "Vaillant ecoTEC PCB" to "Vaillant 0010028086" — otherwise one board is counted twice.
 */
export function parseContents(text, cat, maxQty = LOT_DEFAULTS.maxQty, accWords = LOT_DEFAULTS.accessoryWords) {
  const found = [];
  for (const [q, p] of Object.entries(cat)) {
    if (!matchesQuery(text, q) || accessoryOnly(text, q, accWords)) continue;
    const qty = quantityNear(text, q, maxQty);
    if (qty) found.push({ q, qty, est: p.est, basis: p.basis, words: words(q) });
  }
  return found.filter((a) => !found.some((b) => b !== a && (
    (b.words.length > a.words.length && a.words.every((w) => b.words.includes(w))) ||          // b is a superset of a
    (b.words[0] === a.words[0] && hasPartNo(b.q) && !hasPartNo(a.q)) ||                          // same brand, b has the part number
    (b.words[0] === a.words[0] && b.est === a.est && b.basis === a.basis && found.indexOf(b) < found.indexOf(a))  // twins ("ecoTEC PCB" / "ecoTEC board")
  ))).map(({ words: _w, ...rest }) => rest);
}

/** Value a lot from its recognised contents. Returns null unless it clears the bar. */
export function valueLot(lot, cat, cfg = LOT_DEFAULTS, now = Date.now()) {
  const text = [lot.title, lot.description || ""].join("\n");
  const tl = text.toLowerCase();
  if ((cfg.excludeWords || []).some((w) => tl.includes(w)) || String(lot.conditionId) === "7000") return null;
  const items = parseContents(text, cat, cfg.maxQty, cfg.accessoryWords);
  // "4 x Joblot <thing>" / "Job lot of 3 <thing>": the count belongs to the one item we recognised.
  const lead = String(lot.title).toLowerCase().match(/^(?:job\s*lot\s+of\s+|lot\s+of\s+)?(\d{1,2})\s*(?:x|×)\b/) || String(lot.title).toLowerCase().match(/^(?:job\s*lot|lot)\s+of\s+(\d{1,2})\b/);
  if (lead && items.length === 1 && items[0].qty === 1) items[0].qty = Math.min(Number(lead[1]), cfg.maxQty || 10);
  const value = items.reduce((s, it) => s + it.qty * it.est, 0);
  const landed = lot.landed;
  const known = items.reduce((s, it) => s + it.qty, 0);
  const review = { id: lot.legacyItemId ? "ebay-" + lot.legacyItemId : lot.itemId, title: lot.title, landed, value: Math.round(value), items, url: lot.url, auction: (lot.buyingOptions || []).includes("AUCTION") };
  if (items.length < (cfg.minKnownItems || 1) || !isFinite(landed) || landed <= 0) return { ...review, candidate: null };
  const ok = landed <= value * cfg.valueFraction && value - landed >= cfg.minMarginEur;
  if (!ok) return { ...review, candidate: null };
  const auction = review.auction && !(lot.buyingOptions || []).includes("FIXED_PRICE");
  const parts = items.map((it) => it.qty + "× " + it.q + " (~€" + it.est + (it.basis === "verified" ? " verified" : it.basis === "tracked" ? " tracked" : " est.") + ")").join(", ");
  const shipNote = lot.assumedShipping != null ? "postage not stated, ~€" + lot.assumedShipping + " assumed" : lot.shipping == null ? "postage unknown" : lot.shipping === 0 ? "free postage" : "incl. €" + lot.shipping.toFixed(2) + " postage";
  const best = items.slice().sort((a, b) => b.qty * b.est - a.qty * a.est)[0];
  return { ...review, candidate: {
    id: review.id, title: lot.title, price: Math.round(landed * 100) / 100, estResale: Math.round(value), estBasis: "lot-contents", lot: true,
    cond: lot.cond, soldQuery: best.q, category: cfg.niche, source: "eBay", url: lot.url, image: lot.image || "", itemId: lot.itemId || "", endsAt: lot.endsAt || "",
    reasoning: (auction ? "Auction, current bid €" + Math.round(lot.price) + (lot.endsAt ? ", ends " + lot.endsAt.slice(0, 10) : "") : "Job lot listed at €" + Math.round(lot.price)) +
      " (" + shipNote + "). Recognised inside: " + parts + " = ~€" + Math.round(value) + " sold separately, " + known + " known item(s)" +
      (lot.location ? ", ships from " + lot.location : "") + ". Anything else in the lot is not counted. Check each item's sold prices and that all are working before bidding.",
    foundAt: now, status: "new",
  } };
}

export function isLotTitle(title, lotWords = LOT_DEFAULTS.lotWords) {
  const t = " " + String(title).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  return lotWords.some((w) => t.includes(" " + w + " "));
}

/** Run the lot search for one niche config with an injected client. */
export async function runLots(client, cfg, cat, { log = console.log, now = () => Date.now() } = {}) {
  const searches = cfg.lotSearches && cfg.lotSearches.length ? cfg.lotSearches : LOT_DEFAULTS.lotSearches(cfg.niche);
  const seen = new Map();
  const stats = { searches: 0, listings: 0, lots: 0, detailed: 0, candidates: 0, errors: 0 };
  for (const q of searches) {
    stats.searches++;
    try {
      const { items } = await client.search({ q, limit: cfg.perSearch, filter: { buyingOptions: ["FIXED_PRICE", "AUCTION"], deliveryCountry: cfg.deliveryCountry || undefined } });
      stats.listings += items.length;
      for (const it of items) {
        const k = it.itemId || it.url;
        if (seen.has(k) || !isFinite(it.price) || it.price <= 0) continue;
        // A lot by its title, or a title that already names two priced items.
        const named = parseContents(it.title, cat, cfg.maxQty, cfg.accessoryWords).length;
        if (isLotTitle(it.title, cfg.lotWords) || named >= 2) seen.set(k, { ...withAssumedPostage(it, cfg), named });
      }
      log("• " + q + ": " + items.length + " listings, " + seen.size + " lot(s) so far");
    } catch (e) { stats.errors++; log("  ! " + q + ": " + e.message); }
  }
  const tl = (t) => String(t).toLowerCase();
  const lots = Array.from(seen.values()).filter((l) => !(cfg.excludeWords || []).some((w) => tl(l.title).includes(w)))
    .sort((a, b) => b.named - a.named).slice(0, cfg.maxLots);   // titles naming priced items get their description read first
  stats.lots = lots.length;
  const results = [], review = [];
  for (const lot of lots) {
    let description = "";
    if (cfg.detail !== false) {
      try { const full = await client.getItem(lot.itemId); description = stripHtml((full.shortDescription || "") + "\n" + (full.description || "")); stats.detailed++; }
      catch (e) { stats.errors++; log("  ! detail " + lot.itemId + ": " + e.message); }
    }
    const v = valueLot({ ...lot, description }, cat, cfg, now());
    if (!v) continue;
    review.push({ ...v, candidate: !!v.candidate });
    if (v.candidate) { results.push(v.candidate); stats.candidates++; }
  }
  review.sort((a, b) => (b.value - b.landed) - (a.value - a.landed));
  results.sort((a, b) => (b.estResale - b.price) - (a.estResale - a.price));
  return { results, review, stats };
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.sandbox) process.env.EBAY_ENV = "sandbox";
  const dir = args.data ? String(args.data) : undefined;
  const out = args.out ? String(args.out) : dataPath("lot-results.json", dir);
  const configFiles = args.config ? [].concat(args.config).map(String) : [null];
  const market = loadMarket(dir);
  const plPath = dataPath("pricelist.json", dir);
  const pricelist = existsSync(plPath) ? JSON.parse(readFileSync(plPath, "utf8")) : {};
  let client;
  try { client = clientFromEnv(process.env, { log: (m) => console.log("  · " + m) }); }
  catch (e) { console.error(e.message); process.exit(1); }
  const all = [], reviews = [];
  const totals = { listings: 0, lots: 0, candidates: 0, errors: 0 };
  for (const f of configFiles) {
    const base = resolveConfig({ ...args, config: f || undefined });
    const file = f ? JSON.parse(readFileSync(f, "utf8")) : {};
    const { minMarginEur: _m, excludeWords: _e, ...scanCfg } = base;   // lot thresholds are their own; scan's exclude list is per-item, not per-lot
    const cfg = { ...scanCfg, ...LOT_DEFAULTS, ...(file.lots || {}), lotSearches: file.lotSearches || null, excludeWords: LOT_DEFAULTS.excludeWords.concat(file.lotExcludeWords || []) };
    if (args["max-lots"]) cfg.maxLots = Number(args["max-lots"]);
    if (args["no-detail"]) cfg.detail = false;
    client.marketplace = cfg.marketplace;
    // Items priced only so lots can be valued (cheap: 1 call each, refreshed weekly).
    const extra = file.lotCatalogue || [];
    const priced = await priceList(client, extra, base, pricelist, { log: console.log });
    if (extra.length) { writeFileSync(plPath, JSON.stringify(pricelist, null, 2)); console.log(`\n${extra.length} extra catalogue item(s) for "${cfg.niche}", ${priced} (re)priced today`); }
    const cat = catalogue(market, cfg.askToSold, pricelist);
    if (!Object.keys(cat).length) { console.error("No prices yet — run scan.mjs + track.mjs first, or add a lotCatalogue to the config."); process.exit(1); }
    console.log(`\nLots in "${cfg.niche}" on ${cfg.marketplace} (${client.env}) — ${Object.keys(cat).length} priced items to look for, lot must be ≤${Math.round(cfg.valueFraction * 100)}% of contents, ≥€${cfg.minMarginEur} gap`);
    const r = await runLots(client, cfg, cat);
    all.push(...r.results); reviews.push(...r.review.map((x) => ({ niche: cfg.niche, ...x })));
    for (const k of Object.keys(totals)) totals[k] += r.stats[k];
    console.log(`  ${r.stats.lots} lot(s) read (${r.stats.detailed} with description), ${r.stats.candidates} candidate(s)`);
    for (const x of r.review.slice(0, 8)) console.log(`  ${x.candidate ? "★" : "·"} €${Math.round(x.landed)} → ~€${x.value} (${x.items.map((i) => i.qty + "× " + i.q).join(", ") || "nothing recognised"})  ${x.title.slice(0, 70)}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(all, null, 2));
  writeFileSync(dataPath("lot-review.json", dir), JSON.stringify(reviews, null, 2));
  console.log(`\n${totals.listings} listings sampled · ${totals.lots} lots read · ${totals.candidates} candidate(s) · ${totals.errors} errors · ${client.calls.api} API calls\nWrote ${out} (publish.mjs includes it) and data/lot-review.json (every lot, valued).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.message || e); process.exit(1); });
