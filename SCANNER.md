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
| `watch.mjs` | `npm run watch -- <url\|id>` — is one listing still live? (Build Plan stage 05.) |
| `track.mjs` | `npm run track` — re-checks every listing a scan recorded; builds your own sold-price history and `data/market.json` (sell-through, est. sold, target buy per search). `npm run market` prints it without API calls. |
| `sold.mjs` | `npm run sold -- "Boss DS-1" 65 70 62` — enter real sold prices you read off ebay.ie ("Sold items" filter). Verified prices outrank the tracker's inferences. |
| `store.mjs` | The scanner's memory: `data/watchlist.json` + `data/market.json`, committed so a scheduled run continues where the last stopped. |
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
on a timer (`cron` / Task Scheduler), a small cloud runner, or a Claude Code
environment with `api.ebay.com` on its network allowlist. It does **not** run
inside the Scout page. It has
been run live from a Claude Code session with eBay hosts allow-listed: with a
Production keyset it returns real ebay.ie listings. `npm run check` is the
proof on any new machine.

### How it spots deals without sold prices

For each *specific* item search ("Boss DS-1", not "guitar pedal"), it makes two
calls. First it samples used, fixed-price listings that ship to your country in
eBay's **best-match** order, keeps only titles that contain every query word and
aren't accessories or ephemera (cases, adapters, manuals, magazine adverts,
clones…) or broken (by title *and* by eBay's condition field), and takes the
**median landed price** (item + postage; when postage isn't stated it assumes
€8 from Ireland, €15 from Europe, €30 from further away). Then it searches the
**cheap band** — 25% to 70% of that median, cheapest first — and flags what's
there (default: ≥30% under the median and ≥€15 gap). Each flag is a candidate —
an underpriced listing relative to its peers — which you then verify against real
**sold** comps in Scout. `estResale` is the median asking price, a proxy, never
a guarantee. Two API calls per query, so a seven-query scan every hour is ~340
calls/day against the 5,000 budget.

The first live runs shaped these rules: cheapest-first sampling alone returned
power adapters, carry cases and 1982 magazine adverts as "deals". With the gate
and the two-phase search, a run over seven music-gear queries returned real
units — a Hall of Fame 2 at €100 against a €218 median, Boss DS-1s from Japan at
€62 against €102 — with nothing spurious.

### Sold prices without the sold-price API — tracking

Every scan records the comparable listings it saw (up to 30 per search) in
`data/watchlist.json`. `npm run track` re-checks each one (1 API call each). A
fixed-price listing that ends **early** — with more than a day left on the end
date eBay gave it — almost certainly sold at its asking price; one that runs
to its end date and stops didn't sell; one that returns 404 was removed (sold
or withdrawn — not counted). From these, per search, `data/market.json` holds:

| Field | Meaning |
|---|---|
| `sellThrough` | sold ÷ (sold + expired), once 3+ have closed — Demand Radar's key input |
| `estSold` | median asking of the ones that sold — the real value (null until 3 sales; then the scanner's `estResale` switches to it) |
| `targetBuy` | half of `estSold` (or of 85% of median asking while it's still a proxy) — the most to pay all-in |

**Or tell it directly.** Sold prices are free to read on ebay.ie (search the
model, tick *Sold items*). `npm run sold -- "Boss DS-1" 65 70 62` records what
buyers actually paid; with 3+ entered, `estSold` comes from those (marked ✓ in
the market table) and the tracker's inferences only fill in for searches you
haven't looked up. That's the fastest way to make the numbers real on day one.

The scanner reads `market.json` on its next run: anything at or under
`targetBuy` is flagged, and each candidate's reasoning quotes the tracked
numbers. The longer it runs, the less it leans on asking prices. Budget: ~30
calls per search per track run, so 7 searches ≈ 210 calls/day plus 14 for the
scan, well inside 5,000. `npm run daily` does both.

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

Anywhere that can reach `api.ebay.com`: your laptop (`npm run scan` on a timer),
a small cloud runner with `.env` set, or a Claude Code cloud environment whose
network allowlist includes `api.ebay.com` and `api.sandbox.ebay.com` (set there
in the environment's settings; the keys go in its *API credentials* section, not
in chat or in the repo). A scheduled Routine in such an environment can run the
scan and hand you the results.

**Production keyset gotcha:** a new Production keyset shows *"Your keyset is
currently disabled"* and returns `invalid_client` until you handle eBay's
Marketplace Account Deletion rule. On the keyset's *Notifications* page, turn on
*Exempted from Marketplace Account Deletion*, choose *I do not persist eBay
data*, and submit. It activates immediately.

## Honest limits

- **Active listings come from the Browse API** — open to all developers in
  Production, 5,000 calls/day. The other Buy APIs (Marketplace Insights, Feed,
  Offer) are approval-gated; the seam above doesn't care — swap the source,
  keep the schema.
- **Final sold prices stay closed**, so `estResale` is a sold-comp estimate to be
  verified, never a guarantee — exactly what the Learning tab then grades.
- Keep the collection modest (prune regularly); an artifact db holds at most
  5,000 documents.
