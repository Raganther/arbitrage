# The Scanner — how live opportunities reach Scout

Scout's **Discover** tab shows real opportunities, but the page itself cannot
fetch them: an artifact's runtime blocks all network calls except loading a few
CDN scripts — no `fetch` to eBay, no API calls from the page. So discovery runs
**outside** the page, in a server-side agent that has normal network access, and
the two halves meet in Scout's shared `db` store.

```
┌────────────────────┐     writes      ┌──────────────────┐     reads (live)   ┌───────────────┐
│  Scanner (agent)   │ ──────────────► │  Scout db store  │ ─────────────────► │ Discover tab  │
│  scheduled, server │  discoveries/   │  collection      │  onSnapshot        │ ranks + shows │
└────────────────────┘                 └──────────────────┘                    └───────────────┘
```

## The scanner — `scanner/`

A runnable scanner lives in [`scanner/`](./scanner). It uses **only the eBay Browse
API** (active listings), which is open to every eBay developer account in
Production (no approval step; 5,000 calls/day) — no closed sold-price API needed.

| File | What it does |
|---|---|
| `ebay.mjs` | The eBay client: OAuth Application token (cached, auto-refreshed), sandbox/production switch, `search` + paging, item lookup, retries on 429/5xx, readable errors. Dependency-free. |
| `check.mjs` | `npm run check` — proves your keys work: mints a token, runs one search, prints what came back or *why* it failed. |
| `scan.mjs` | `npm run scan` — the scanner. Writes `scan-results.json` for Scout's Discover import. |
| `radar.mjs` | `npm run radar -- "niche"` — active-listing count + median asking for Demand Radar's competition side. |
| `watch.mjs` | `npm run watch -- <url\|id>` — is a listing still live? (Build Plan stage 05.) |
| `test/` | `npm test` — 24 offline tests against a fake eBay, so the code is verified before you spend a call. |

### Setup — from developer account to first scan

1. **Keys.** At [developer.ebay.com](https://developer.ebay.com) → *My Account* →
   *Application Keys*, create a keyset if you haven't. You get **two**: *Sandbox*
   and *Production*. Copy the **App ID (Client ID)** and **Cert ID (Client
   Secret)** of the one you're using — they are not interchangeable.
2. **Configure.** `cd scanner && cp .env.example .env`, paste the two values in,
   set `EBAY_ENV` (`sandbox` to test the plumbing, `production` for real
   listings) and `EBAY_MARKETPLACE` (`EBAY_IE` — or `EBAY_GB`, `EBAY_US`…).
   `.env` is gitignored; never commit it.
3. **Check.** `npm run check` (or `npm run check:sandbox`). A good run prints the
   token lifetime, the number of matching listings, and five of them. Sandbox
   often returns *zero* results for real product names — that's normal, it's
   fake data; the point is the token + call succeeded.
4. **Scan.** `npm run scan` uses the `CONFIG` block in `scan.mjs`; or pass
   queries straight in: `node scan.mjs --q "Boss DS-1" --q "Zoom H4n" --niche music-gear`;
   or keep a niche in a JSON file: `node scan.mjs --config pedals.json`.
5. **Import.** Scout → Discover → *Import scan results* → pick `scan-results.json`.

Needs Node 18+ and a machine that can reach `api.ebay.com` — your own laptop
on a timer (`cron` / Task Scheduler) or a small cloud runner. It does **not**
run inside the Scout page, and this repo's build sandbox blocks eBay, so it has
never been run against the live API from here: the code path is covered by the
offline tests, and `npm run check` is the live proof.

### How it spots deals without sold prices

For each *specific* item search ("Boss DS-1", not "guitar pedal"), it pulls the
cheapest used, fixed-price listings that ship to your country, computes the
**median landed price** (item + postage) across them, and flags listings priced
well below it (default: ≥30% under and ≥€15 gap). Titles that say *parts /
faulty / box only* are dropped from the comps. Each flag is a candidate — an
underpriced listing relative to its peers — which you then verify against real
**sold** comps in Scout. `estResale` is the median asking price, a proxy, never
a guarantee. Each run costs one API call per query (more if `compsPerQuery`
exceeds 200), so a seven-query scan every hour is ~170 calls/day against the
5,000 budget.

## Getting results into Scout

Two ways the `scan-results.json` reaches your board:

1. **Import (built, works today).** Scout's **Discover** tab has an
   *Import scan results* button — pick the file and the candidates appear as a
   ranked live list you can add to your board. Reliable, manual, one click.
2. **Fully automatic (later).** A scheduled Claude session (Routine) running where
   eBay is reachable pushes each keeper straight into Scout's `db` at
   `discoveries/<id>` via the artifact database tools — no import step, no
   credentials in the page. Needs a runner with open egress to eBay.

## Discovery document schema

Collection: **`discoveries`**, one document per opportunity.

| Field | Type | Notes |
|---|---|---|
| `title` | string | Listing title, as a buyer would search it |
| `price` | number | Source (buy) price in EUR |
| `estResale` | number | Estimated used resale in EUR (from sold comps) |
| `cond` | string | Condition, e.g. `"Used – working"` |
| `soldQuery` | string | Keywords for the eBay sold-comp check |
| `category` | string | `music-gear` \| `books` \| `vintage-clothing` \| `electronics` \| `homeware` \| `other` |
| `source` | string | e.g. `"eBay"` |
| `reasoning` | string | One line on why it's a candidate |
| `foundAt` | number | Epoch ms; Discover sorts newest first |
| `status` | string | `"new"` (default). The page sets `"added"` or `"dismissed"` when you act. |

Scout ranks candidates by ROI itself and applies its own fee/postage assumptions,
so the scanner only needs to supply `price` and `estResale` honestly. When the
`discoveries` collection is empty, Discover shows clearly-marked **sample**
candidates instead, so the flow is usable before the scanner exists.

## Where it runs

Not here. This repo's build sandbox blocks `api.ebay.com` (`EGRESS_BLOCKED`), so
a scanner scheduled in *this* environment would have nothing real to write. Run
it anywhere with normal internet: your laptop (`npm run scan` on a timer) or a
small cloud runner with `.env` set. Until you do, Scout's **Assess** tab is the
manual version of the same step, and Discover shows sample candidates.

## Honest limits

- **Active listings come from the Browse API** — open to all developers in
  Production, 5,000 calls/day. The other Buy APIs (Marketplace Insights, Feed,
  Offer) are approval-gated; the seam above doesn't care — swap the source,
  keep the schema.
- **Final sold prices stay closed**, so `estResale` is a sold-comp estimate to be
  verified, never a guarantee — exactly what the Learning tab then grades.
- Keep the collection modest (prune regularly); an artifact db holds at most
  5,000 documents.
