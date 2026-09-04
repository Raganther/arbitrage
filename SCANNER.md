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

## What the scanner does, each run

1. For each **saved search** in the chosen niche, find current active listings
   (via the eBay Browse API if access is granted, or a third-party listings feed
   — see `BUILD_PLAN.md` for the access reality).
2. For each promising hit, estimate a used resale value (from sold comps) and
   keep only those whose margin clears fees + postage.
3. Write each keeper into Scout's `db` at `discoveries/<id>`.
4. Optionally prune old `new` discoveries so the collection stays small.

The scanner is a scheduled Claude session (a Routine). It writes to Scout's store
with the artifact database tools — no credentials live in the page.

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

## Honest limits

- **Active-listing access is approval-gated** (eBay) or **paid** (third-party).
  The seam above doesn't care which — swap the source, keep the schema.
- **Final sold prices stay closed**, so `estResale` is a sold-comp estimate to be
  verified, never a guarantee — exactly what the Learning tab then grades.
- Keep the collection modest (prune regularly); an artifact db holds at most
  5,000 documents.
