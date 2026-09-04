# Scout — Build Plan

A phased, honest roadmap from the manual valuation tool that exists today
([Flip Check](./flip-check.html)) to a system that scans a niche, surfaces
underpriced eBay listings, tracks them to their outcome, and checks its own
estimates against what things actually sell for.

Each phase ships something usable on its own. Nothing here depends on a promise
that might not land.

## The concept — one repeating loop

Every arbitrage setup is the same six-stage cycle:

| # | Stage | What it does | Status |
|---|-------|--------------|--------|
| 01 | **Discover** | Pull in real listings for a chosen niche automatically | Phase 2 |
| 02 | **Identify** | Work out what each item actually is (bad title → good item) | ✅ Built (P0) |
| 03 | **Value** | Estimate resale from sold comps; margin after fees + postage | ✅ Built (P0) |
| 04 | **Track** | Save opportunities to a board you browse and rank | Phase 1 |
| 05 | **Watch outcome** | Follow each item until it ends; record what it sold for | Phase 1 |
| 06 | **Learn** | Compare estimate to actual; find where your instinct is reliable | Phase 1 |

Stage 06 feeds back into stage 03 — the system values better the more outcomes
it has seen.

## Ground truth — the data you can and can't get

The plan is shaped entirely by this. The valuable data is the most locked-down,
so we design around the gaps.

| Data you want | Source | Access | What Scout does |
|---|---|---|---|
| **Active listings** (for sale now) | eBay **Browse API** (Finding API is dead) | Approval-gated | Primary discovery source *if* granted. Built behind a swappable adapter so we're never blocked waiting on it. |
| **Sold prices** (what it actually sold for) | eBay **Marketplace Insights API** | **Closed** to individuals | Resale value comes from your confirmed sold-comp checks and, over time, your own recorded outcomes. |
| **Did it sell?** (live / ended) | Browse API item lookup | Same as Browse | Poll each watched item; when it ends, prompt you for the final price. Reliable for status, not for auto-capturing price. |
| **Local bargains** (Adverts, DoneDeal, Marketplace) | No public API; bot-hostile | Off-limits | Out of scope until much later — human-in-the-loop, not a scraper. |
| **Fallback feed** (listings + ~90-day sold) | Third-party (SoldComps, Apify) | Paid, open signup | If eBay access never comes, drop into the same adapter. ~$2/1,000 results; ToS burden on us. |

## The build — four phases, in dependency order

### Phase 0 — The valuation engine ✅ Shipped
The brain: name an item, rough out resale, decide buy/skip after fees. Built
first because a scanner is worthless until something can judge what it finds.
- **You get:** Flip Check (live), AI identification, Ireland fee/margin maths, BUY/MAYBE/SKIP.
- **Built with:** single-page artifact, `sample` capability, local storage.
- **Effort:** done · **Cost:** €0 · **Data access:** none.

### Phase 1 — Tracking & the learning loop ✅ Shipped ([`scout.html`](./scout.html))
Turn the flat ledger into a real tracker that follows finds to their outcome and
scores your estimates — so you learn, with data, which niches your instinct is
reliable in. No scanning, no scraping, breaks no rules, highest value per hour.
- **You get:** opportunity board (watching/bought/sold), record real sold price,
  estimate-vs-actual accuracy, accuracy per category, running profit & hit-rate.
- **Built with:** evolve Flip Check, `db` capability (durable, cross-device),
  simple accuracy charts.
- **Proves:** the feedback half of the idea — the system checks itself and gets
  measurably better.
- **Effort:** 1–2 sessions · **Cost:** €0 · **Data access:** none.

### Phase 2 — Auto-discovery for one niche 🔧 Built, awaiting the eBay key
The **Discover** tab, saved searches, ROI ranking, the live `db` seam, and a
one-click **Import** are built and working. The **scanner** ([`scanner/scan.mjs`](./scanner/scan.mjs))
is written and runnable (`--dry-run` works today) — it finds underpriced listings
from the eBay Browse API by comparing each to its peers' median asking price
([`SCANNER.md`](./SCANNER.md)). The only thing outstanding is your **eBay
Production keyset** (applied for) plus a machine that can reach eBay to run it on
a timer. Optional later: full automation (scheduled push into `db`, no import).

Wire the top of the loop. On a schedule, pull real active listings for a handful
of saved searches in one niche, run each through the valuation engine, and drop
the underpriced ones onto your board — ranked, with reasoning and a sold-comp link.
- **You get:** saved searches, auto-populated feed, AI triage against your value
  model, only the good ones surface — you still decide every buy.
- **Built with:** data adapter (sample → live), eBay Browse API *or* paid feed,
  scheduled refresh.
- **Proves:** discovery can run itself — the full concept end to end, minus "everywhere".
- **Effort:** 2–4 sessions · **Cost:** €0–low · **Data access:** Browse API or third-party key.

### Phase 4 — Demand Radar (demand-first) ✅ Shipped ([`demand-radar.html`](./demand-radar.html))
The strategic upgrade: stop guessing which niche to work. Radar scores a niche
0–100 from real eBay signals (sell-through, price room, competition, volume,
watchers) with a Strong/Test/Skip verdict, plus an AI qualitative read and the
searches to measure it. Points you at underserved, high-margin corners
(obsolete/trade parts, discontinued gear) instead of crowded commodity flips —
before you spend anything. Feeds the niche choice that Scout's scanner then works.

### Phase 3 — Widen & automate (later)
Only once accuracy data proves you can trust the estimates in a niche do you add
more of them, and tighten the outcome loop. The north star ("any domain,
anywhere") approached one proven niche at a time — never as a starting point.
- **You get:** more niches added on evidence, better final-price capture, alerts,
  optional assisted local sourcing.
- **Effort:** ongoing · **Cost:** scales with use.

## How the pieces run

There's **no always-on server** here — everything is arranged around that.

- **The app** (artifact page) — a single web page, no install; Flip Check growing into Scout.
- **The memory** (`db` capability) — finds, estimates, outcomes stored durably and synced across devices.
- **The judgement** (`sample` capability) — identification/valuation on Claude, from your own usage, on demand — not a constant loop.
- **The scanner** (scheduled trigger) — wakes on a schedule, pulls listings via the adapter, values them, updates the board, sleeps. This is how "automatic" happens without a server.
- **The source** (swappable adapter) — one seam where listing data comes from. Sample today; Browse API or paid feed behind it later, no rebuild.

## Risks worth naming

- **eBay may never grant live API access** → mitigated by the adapter; a paid feed drops into the same slot.
- **Final sold prices can't be captured automatically** → the closed data; Phase 1 handles it honestly (you confirm, the system learns).
- **"Scan everything" fights your only edge** → niche-first is the guardrail; widen only on proven accuracy.
- **Browser-bot scraping as a shortcut** → fragile, blockable, against ToS; kept out on purpose. APIs first, always.

## Decisions the project needs from you

Neither has to be decided now — **Phase 1 needs no data access**, so we can start there while you weigh these.

- **Fork 1 — Data path (recommended: working loop now, live data later).** Build the
  full flow with sample listings behind the adapter, see it work today, slot live
  eBay data in when access is sorted. Alternative: set up a free eBay developer
  account first — higher payoff, gated on eBay's approval timeline.
- **Fork 2 — Niche.** Music gear (strongest edge, values well), books (lowest
  capital, clean ISBN identification), or vintage clothing (good margins, noisier).

**Recommendation:** start Phase 1 now regardless of the forks; decide the forks before Phase 2.

---

*General information, not financial or tax advice. Reselling income can be taxable
in Ireland once it's regular — worth checking as it grows. Data-access notes
reflect the 2026 research in this project; verify current terms before relying on
any source.*
