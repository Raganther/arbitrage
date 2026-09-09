# Arbitrage — online reselling toolkit

A small, practical toolkit for buying underpriced secondhand items and reselling
them (eBay, Reverb, Vinted, Adverts.ie, DoneDeal) — built for a low-capital,
few-hours-a-week, ROI-driven start in Ireland.

## Demand Radar — pick the niche first (Phase 4)

**[`demand-radar.html`](./demand-radar.html)** — score whether a niche is worth
entering *before* you spend anything.

The demand-first move: instead of finding a cheap thing and hoping it sells, find
out what's genuinely underserved and go source *that*. Radar scores a niche 0–100
from real eBay numbers — **sell-through, price room, competition, volume,
watchers** — and gives a Strong / Test / Skip verdict with a component breakdown.
An AI "demand read" (via `sample`) gives a qualitative first take and the exact
searches to measure. Opens with example niches that show the lesson: obsolete
boiler PCBs score high on tiny volume (few desperate buyers, high price, no
competition) while generic phone cases score low despite huge volume. Saved
niches sync via `db`.

## Scout — the main app (Phase 1)

**[`scout.html`](./scout.html)** — the full tool: assess, track, and learn.

Four tabs:

- **Assess** — paste a listing, let Scout identify it and rough out a resale
  range, run the Ireland fee/margin maths for a BUY/MAYBE/SKIP verdict, then add
  the good ones to your board.
- **Discover** — auto-sourced opportunities for a chosen niche, ranked by ROI,
  each with a verdict, reasoning and eBay sold/live links; add the good ones
  straight to the board or dismiss them. A page can't call eBay directly, so the
  **scanner** in [`scanner/`](./scanner) does it: a dependency-free Node client
  for the **eBay Browse API** (`npm run check` to verify your developer keys,
  `npm run scan` to find underpriced listings, `npm run radar` for Demand Radar's
  competition numbers) whose `scan-results.json` you import into Discover. See
  [`SCANNER.md`](./SCANNER.md) for the setup walkthrough. Ships with sample
  candidates so the flow works before the scanner is wired.
- **Board** — every find as a card you move through its lifecycle: watching →
  bought → listed → sold (or passed). When you mark something sold, you record
  what it actually went for.
- **Learning** — the feedback loop. Once you've logged real sale prices it shows
  your realized profit, hit rate, and an **estimate-calibration** chart (where
  you pegged the resale vs what it sold for), plus a per-category breakdown of
  **where your instinct is reliable** — the whole point of the exercise.

Storage uses the artifact `db` capability, so your finds sync across devices
(phone in the shop, laptop at home); it falls back to browser-local storage when
`db` isn't available. Opens with clearly-marked example finds that vanish once
you add your own.

## Flip Check — the lite calculator (Phase 0)

**[`flip-check.html`](./flip-check.html)** — a buy/skip decision tool.

Paste a seller's listing, let it name the item and rough out a resale range,
then run the numbers to see whether the flip survives eBay fees and postage.

- **Identify & value** — reads the seller's title/description (and an optional
  photo) and returns the likely brand/model, a rough used-resale range, a
  confidence level, red flags (fakes, missing parts, awkward-to-post, saturated
  market) and the exact keywords to check on eBay *sold* listings. Runs on
  Claude via the artifact's `sample` capability; degrades to manual entry when
  that isn't available.
- **Margin maths (Ireland)** — buy price, resale, postage, packaging, and a
  configurable selling fee (default ~13% + €0.35). Live verdict: **BUY /
  MAYBE / SKIP** with net profit, ROI and margin.
- **Finds ledger** — saves each assessment (in your browser) so you learn your
  real hit rate and margins over time. Opens with clearly-marked examples.

> Resale figures are only ever a starting guess. Always confirm against real
> **eBay sold listings** (free in Seller Hub → Product Research) or **Reverb**
> price guides before you buy.

## The plan behind it

Start with what you already know and can source cheaply. The edge in reselling
is *knowing what a thing is actually worth* when a generalist seller doesn't —
so specialise:

- **Music gear** — used pedals, interfaces, mics, method books. Mispriced kit on
  Adverts.ie / Marketplace flips well on Reverb or eBay.
- **Books** — lowest capital barrier; textbooks, niche non-fiction, out-of-print.
- **Vintage / retail** — knowing what sells and what it's worth.

First month, under €200:

1. Sell 5–10 things you already own to learn listing, shipping and fees.
2. Take ~€100 to charity shops / Adverts.ie, hunting mispriced gear and books.
3. Reinvest; don't add capital until you've turned that €100 over 2–3 times.
4. Log every buy/sell in Flip Check to learn your real margin after fees.

Filter: *would this profit survive €5–8 postage and ~13% fees?* If not, skip it.

## Sourcing sold-price data (2026 notes)

- **Free & best starting point:** eBay **Product Research** (formerly Terapeak) —
  3 years of real sold data, free for any seller account. The eBay app's
  **barcode scanner** gives instant sold history in-store.
- **Official API is effectively closed:** the Marketplace Insights API is a
  limited release; individual developers are routinely denied. Don't build a
  plan around getting approved.
- **Scraping got harder:** since mid-2026 eBay sold listings require a signed-in
  session, and only ~90 days of history is exposed (store what you pull).
- **Third-party APIs** (SoldComps, Apify actors) fill the gap for automation
  later — a legal grey area, ToS burden on you. Only once the economics are
  proven.

Build order: prove it manually → semi-automated valuation (this tool) → paid
sold-data API + your own database, only if you outgrow it.

---

*Not financial or tax advice. Reselling income can be taxable in Ireland once
it's regular — worth checking as it grows.*
