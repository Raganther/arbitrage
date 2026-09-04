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

## The scanner script — `scanner/scan.mjs`

A runnable first version lives at [`scanner/scan.mjs`](./scanner/scan.mjs). It uses
**only the accessible eBay Browse API** (active listings), so it works the moment
your Production keyset is live — no closed sold-price API needed.

**How it spots deals without sold prices:** for each *specific* item search
("Boss DS-1", not "guitar pedal"), it pulls the current listings, takes the
**median asking price** as a rough market value, and flags listings priced well
below it (default: ≥30% under, and ≥€15 gap). That's a candidate — an underpriced
listing relative to its peers — which you then verify against real **sold** comps
in Scout. `estResale` is the median asking price, a proxy, never a guarantee.

```bash
cd scanner
node scan.mjs --dry-run          # no key needed: writes a sample scan-results.json
EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... node scan.mjs   # the real thing
```

It writes **`scan-results.json`** (the discovery schema below). Runs anywhere with
Node 18+ and network access to `api.ebay.com` — your own machine on a timer
(`cron`/Task Scheduler), or a small cloud runner. It does **not** run inside the
Scout page or a sandbox that blocks eBay.

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

## Why it isn't running yet

Two walls, both real:

1. **This build environment blocks eBay.** The network egress proxy returns
   `EGRESS_BLOCKED` for `ebay.ie`, and web search only surfaces generic category
   pages — no per-listing prices to trust. A scanner scheduled in *this*
   environment cannot reach eBay, so it would have nothing real to write.
2. **Even with network access, listing data is gated** — the eBay Browse API
   needs a developer account (and possibly approval), or a paid third-party feed.

So the scanner needs a home with open egress to eBay **and** API credentials.
Until then, Scout's **Assess** tab is the manual version of the same step: paste a
listing you find while browsing yourself, and it values and boards it. The
Discover tab shows sample candidates so the pipeline is ready the moment a real
scanner starts writing to `discoveries/`.

## Honest limits

- **Active-listing access is approval-gated** (eBay) or **paid** (third-party).
  The seam above doesn't care which — swap the source, keep the schema.
- **Final sold prices stay closed**, so `estResale` is a sold-comp estimate to be
  verified, never a guarantee — exactly what the Learning tab then grades.
- Keep the collection modest (prune regularly); an artifact db holds at most
  5,000 documents.
