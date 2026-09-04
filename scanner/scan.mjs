#!/usr/bin/env node
/*
 * Scout scanner — finds candidate arbitrage listings on eBay for a niche.
 *
 * How it works (honestly):
 *   The eBay Browse API gives ACTIVE listings only (never final sold prices).
 *   So this scanner spots deals relative to the crowd: for each specific item,
 *   it pulls current listings, takes the MEDIAN asking price as a rough market
 *   value, and flags listings priced well below it. That is a candidate, not a
 *   guarantee — you confirm the real resale value (eBay SOLD comps) in Scout.
 *
 * It writes scan-results.json — a list of discovery objects matching the schema
 * in ../SCANNER.md — which you then import into Scout's Discover tab.
 *
 * Requirements:
 *   - Node 18+ (uses built-in fetch). No npm install needed.
 *   - Env vars EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (your Production keyset).
 *   - Network access to api.ebay.com (won't run inside the Scout page or a
 *     sandbox that blocks eBay — run it on your own machine or a small server).
 *
 * Run:  EBAY_CLIENT_ID=xxx EBAY_CLIENT_SECRET=yyy node scan.mjs
 *       node scan.mjs --dry-run     # no API calls; emits a sample file to test the flow
 */

import { writeFileSync } from "node:fs";

// ---------- config: edit these ----------
const CONFIG = {
  niche: "music-gear",
  marketplace: "EBAY_IE",          // EBAY_GB, EBAY_US, ... for other regions
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
  compsPerQuery: 40,     // listings to sample when computing the median
  discount: 0.30,        // flag listings >= 30% below the median asking price
  minMarginEur: 15,      // and at least this many EUR below it
  maxPerQuery: 3,        // keep at most this many candidates per query
};
// ----------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

async function getToken() {
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) {
    console.error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET. Set them, or run with --dry-run.");
    process.exit(1);
  }
  const basic = Buffer.from(id + ":" + secret).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + basic },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error("Auth failed (" + res.status + "): " + (await res.text()).slice(0, 300));
  return (await res.json()).access_token;
}

async function search(token, q) {
  const url = SEARCH_URL + "?q=" + encodeURIComponent(q) + "&limit=" + CONFIG.compsPerQuery +
    "&filter=" + encodeURIComponent("buyingOptions:{FIXED_PRICE}");
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token, "X-EBAY-C-MARKETPLACE-ID": CONFIG.marketplace },
  });
  if (!res.ok) throw new Error("Search '" + q + "' failed (" + res.status + "): " + (await res.text()).slice(0, 200));
  const data = await res.json();
  return (data.itemSummaries || []).map((it) => ({
    title: it.title,
    price: it.price ? Number(it.price.value) : NaN,
    cond: it.condition || "",
    url: it.itemWebUrl || "",
  })).filter((x) => isFinite(x.price) && x.price > 0);
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function findCandidates(q, listings) {
  if (listings.length < 5) return []; // too few comps to trust a median
  const mid = median(listings.map((l) => l.price));
  const threshold = mid * (1 - CONFIG.discount);
  return listings
    .filter((l) => l.price <= threshold && (mid - l.price) >= CONFIG.minMarginEur)
    .sort((a, b) => (mid - b.price) - (mid - a.price))
    .slice(0, CONFIG.maxPerQuery)
    .map((l) => {
      const under = Math.round((1 - l.price / mid) * 100);
      return {
        title: l.title,
        price: Math.round(l.price * 100) / 100,
        estResale: Math.round(mid),           // proxy: median asking — VERIFY vs sold comps
        cond: l.cond,
        soldQuery: q,
        category: CONFIG.niche,
        source: "eBay",
        url: l.url,
        reasoning: "Listed at €" + Math.round(l.price) + ", ~" + under + "% under the €" +
          Math.round(mid) + " median asking for \"" + q + "\" (" + listings.length + " comps). Confirm real value in sold listings.",
        foundAt: Date.now(),
        status: "new",
      };
    });
}

function sampleResults() {
  return [{
    title: "Boss DS-1 distortion pedal (sample)", price: 22, estResale: 52, cond: "Used",
    soldQuery: "Boss DS-1", category: "music-gear", source: "eBay", url: "",
    reasoning: "SAMPLE — --dry-run produced this so you can test the import flow without an API key.",
    foundAt: Date.now(), status: "new",
  }];
}

async function main() {
  let results;
  if (DRY_RUN) {
    console.log("[dry-run] no API calls; writing a sample result.");
    results = sampleResults();
  } else {
    const token = await getToken();
    results = [];
    for (const q of CONFIG.queries) {
      try {
        const listings = await search(token, q);
        const found = findCandidates(q, listings);
        console.log("• " + q + ": " + listings.length + " listings, " + found.length + " candidate(s)");
        results.push(...found);
      } catch (e) {
        console.error("  ! " + e.message);
      }
    }
    results.sort((a, b) => (b.estResale - b.price) - (a.estResale - a.price));
  }
  writeFileSync("scan-results.json", JSON.stringify(results, null, 2));
  console.log("\nWrote scan-results.json — " + results.length + " candidate(s). Import it into Scout's Discover tab.");
}

main().catch((e) => { console.error(e); process.exit(1); });
