# Niche research — measured on ebay.ie, 11 Sep 2026

Where should the scanner look next? Two inputs: what resellers report as
profitable (the trade blogs), and what ebay.ie **actually shows right now** for
52 specific searches across 13 domains, pulled through the Browse API
(`scanner/radar.mjs --used --file niches.txt`, used + fixed-price + ships to
Ireland). Raw numbers: [`scanner/data/niche-radar-2026-09-11.json`](./scanner/data/niche-radar-2026-09-11.json).

## What the columns mean

| Column | Reads as |
|---|---|
| **active** | Listings for sale now → competition. Tens of thousands = commodity. Under ~500 = thin, specialist market. |
| **median** | Typical asking price → price room. Under ~€60 the fees and postage eat the margin. |
| **p25–p75, spread** | Where the middle half of prices sit. A wide spread (×2–3) means sellers disagree on value → bargains exist. Very wide (×5+) usually means parts/accessories are polluting the search, not that bargains are that big. |
| **IE / GB / EU** | Share of listings shipping from Ireland / Britain / rest of EU. |

**Why the origin share matters more than it looks.** Since Brexit, an Irish
buyer purchasing from a GB seller pays import VAT and often customs handling,
waits longer, and can't return easily. So where most of the supply is GB (vices,
planes, Le Creuset, Barbour, Bugaboo), an **Irish-located seller has almost no
competition for Irish buyers** — and those goods are heavy, so nobody ships
them from Asia either. That is a structural edge you can't get in cameras or
pedals, which arrive cheaply from Japan and the EU.

## The measurements

| Domain | Search | Active | Median | p25–p75 | Spread | IE / GB / EU |
|---|---|---|---|---|---|---|
| music-gear | Boss DS-1 | 1,806 | €104 | €83–€159 | ×1.91 | 0% / 4% / 7% |
| music-gear | Shure SM58 | 137 | €179 | €115–€258 | ×2.25 | 0% / 6% / 28% |
| music-gear | Fender Stratocaster Mexico | 2,057 | €545 | €413–€675 | ×1.64 | 0% / 3% / 15% |
| music-gear | Yamaha P-45 | 11 | €405 | €400–€455 | ×1.14 | 0% / 25% / 50% |
| hifi | Marantz amplifier | 3,452 | €297 | €213–€534 | ×2.51 | 0% / 9% / 71% |
| hifi | NAD 3020 | 37 | €83 | €36–€300 | ×8.22 | 0% / 40% / 35% |
| hifi | Technics SL-1200 | 1,760 | €567 | €215–€928 | ×4.32 | 3% / 3% / 13% |
| hifi | Rega Planar 3 | 41 | €103 | €36–€761 | ×20.85 | 0% / 64% / 0% |
| hifi | Bowers Wilkins speakers | 2,201 | €329 | €219–€778 | ×3.55 | 0% / 54% / 15% |
| cameras | Canon AE-1 | 7,327 | €169 | €135–€201 | ×1.49 | 1% / 3% / 20% |
| cameras | Pentax K1000 | 1,103 | €178 | €129–€219 | ×1.7 | 0% / 15% / 17% |
| cameras | Olympus OM-1 | 2,435 | €173 | €155–€201 | ×1.3 | 0% / 4% / 13% |
| cameras | Canon Powershot | 18,310 | €198 | €158–€246 | ×1.55 | 9% / 0% / 22% |
| cameras | Nikon Coolpix | 22,563 | €139 | €99–€180 | ×1.82 | 3% / 1% / 51% |
| retro-games | Game Boy Advance SP | 7,747 | €136 | €113–€178 | ×1.57 | 1% / 8% / 63% |
| retro-games | Nintendo DS Lite | 60,984 | €84 | €56–€111 | ×1.97 | 2% / 9% / 19% |
| retro-games | PlayStation 2 console | 21,622 | €113 | €85–€155 | ×1.84 | 16% / 5% / 43% |
| retro-games | Nintendo 64 console | 13,376 | €139 | €115–€199 | ×1.74 | 3% / 4% / 26% |
| retro-games | Pokemon Emerald | 1,382 | €155 | €68–€228 | ×3.35 | 2% / 15% / 12% |
| vintage-computing | ThinkPad X220 | 485 | €44 | €12–€189 | ×15.15 | 0% / 21% / 50% |
| vintage-computing | Amiga 500 | 1,577 | €75 | €50–€178 | ×3.56 | 2% / 51% / 44% |
| vintage-computing | iPod Classic | 1,240 | €166 | €131–€208 | ×1.59 | 4% / 16% / 62% |
| tools | Makita drill 18V | 961 | €85 | €64–€109 | ×1.7 | 0% / 36% / 0% |
| tools | DeWalt DCD796 | 67 | €83 | €68–€115 | ×1.7 | 0% / 43% / 5% |
| tools | Stanley No 4 plane | 2,616 | €82 | €62–€120 | ×1.94 | 0% / 48% / 0% |
| tools | Festool sander | 70 | €301 | €210–€420 | ×2 | 0% / 24% / 24% |
| tools | Record vice | 2,256 | €113 | €65–€148 | ×2.27 | 0% / 95% / 0% |
| kitchen | Le Creuset casserole | 3,522 | €115 | €79–€163 | ×2.07 | 0% / 52% / 2% |
| kitchen | Gaggia Classic | 58 | €117 | €54–€331 | ×6.09 | 3% / 19% / 29% |
| kitchen | KitchenAid mixer | 5,979 | €190 | €183–€228 | ×1.24 | 0% / 0% / 0% |
| kitchen | Dualit toaster | 170 | €119 | €76–€167 | ×2.21 | 0% / 59% / 4% |
| kitchen | Rancilio Silvia | 28 | €125 | €55–€201 | ×3.64 | 0% / 23% / 0% |
| clothing | Barbour Bedale | 1,240 | €178 | €137–€202 | ×1.48 | 0% / 60% / 3% |
| clothing | Dr Martens 1460 | 20,184 | €99 | €83–€125 | ×1.51 | 0% / 19% / 12% |
| clothing | Levis 501 vintage | 45,143 | €72 | €53–€87 | ×1.62 | 0% / 10% / 22% |
| clothing | Carhartt jacket | 61,029 | €111 | €83–€143 | ×1.73 | 0% / 13% / 4% |
| clothing | Patagonia fleece | 93,708 | €78 | €67–€111 | ×1.66 | 0% / 10% / 3% |
| trade-parts | Vaillant PCB | 435 | €72 | €52–€141 | ×2.69 | 0% / 76% / 24% |
| trade-parts | Worcester Bosch PCB | 77 | €61 | €54–€85 | ×1.57 | 0% / 100% / 0% |
| trade-parts | Grundfos pump | 3,194 | €139 | €99–€206 | ×2.08 | 0% / 21% / 73% |
| watches | Seiko 5 automatic | 27,810 | €159 | €127–€198 | ×1.56 | 0% / 7% / 10% |
| watches | Casio G-Shock | 130,695 | €165 | €130–€193 | ×1.49 | 0% / 3% / 0% |
| watches | Tissot | 23,297 | €214 | €152–€293 | ×1.93 | 2% / 4% / 63% |
| collectibles | Lego Technic | 40,238 | €62 | €20–€114 | ×5.64 | 2% / 2% / 79% |
| collectibles | Warhammer 40k | 245,950 | €53 | €17–€79 | ×4.71 | 1% / 8% / 42% |
| sport | Ireland rugby jersey | 1,733 | €62 | €53–€88 | ×1.66 | 4% / 8% / 4% |
| sport | GAA jersey vintage | 125 | €92 | €63–€135 | ×2.15 | 7% / 3% / 10% |
| sport | Brooks saddle | 1,009 | €96 | €71–€135 | ×1.89 | 1% / 40% / 26% |
| sport | Shimano 105 groupset | 96 | €318 | €198–€467 | ×2.36 | 0% / 13% / 28% |
| garden | Stihl chainsaw | 24,382 | €102 | €66–€248 | ×3.76 | 0% / 18% / 3% |
| garden | Honda lawnmower | 3,796 | €59 | €49–€140 | ×2.86 | 2% / 11% / 0% |
| baby | Bugaboo pram | 335 | €277 | €64–€355 | ×5.52 | 6% / 94% / 0% |

## What it says

**Tier 1 — start here (structural edge for an Irish seller)**

1. **Trade parts: boiler PCBs and pumps.** Vaillant PCB: 435 active, €72
   median, spread ×2.7, 76% shipped from GB. Worcester Bosch PCB: 77 active,
   100% GB. Grundfos pumps: €139 median. Few sellers, buyers who need the exact
   part *today* (cold house), and nobody imports these from abroad. Source:
   plumbers and heating engineers who swap boards and bin the old ones, boiler
   decommissions, DoneDeal. Needs: learning part numbers. This is exactly the
   "obsolete boiler PCB" example Demand Radar ships with — the data backs it.
2. **Premium kitchen: Le Creuset, Dualit, Gaggia Classic, KitchenAid.**
   €115–€190 medians, 52–59% GB, cast iron and steel that costs €25 to post.
   Charity shops and house clearances in Ireland turn these up for a few euro;
   a Gaggia Classic bought "not heating" and descaled is a well-known flip
   (58 active, spread ×6 — half of that is parts, the rest real disagreement).
3. **Hand and power tools: Record vices, Stanley planes, Makita/DeWalt, Festool.**
   Record vice: 2,256 active but **95% GB**, €113 median. Stanley No 4: €82,
   48% GB. Festool sander: 70 active, €301 median. Car boots, farm auctions,
   retiring tradesmen. Tools rarely get returned and don't go out of fashion.
4. **Baby gear: Bugaboo.** 335 active, €277 median, 94% GB, only 6% Irish.
   Parents buy locally (Adverts, DoneDeal) at steep discounts and the eBay
   supply for Irish buyers is thin. Bulky, high-ticket, low competition.

**Tier 2 — good money, needs know-how**

- **Hi-fi separates** (Marantz €297, Technics SL-1200 €567, B&W speakers €329,
  54% GB). Wide spreads, high tickets, real buyers — but you need to test gear
  and know models; the ×4–×20 spreads are half parts listings (belts, lids).
- **Bikes** (Shimano 105 groupset €318, 96 active; Brooks saddles €96, 40% GB).
- **Heritage clothing** (Barbour Bedale €178, 60% GB, tight spread ×1.5 —
  efficiently priced on eBay, so the profit is in charity-shop sourcing, not
  eBay-to-eBay).

**Tier 3 — crowded commodity markets, skip as a starting point**

- **Cameras** (Canon AE-1 7,327 active, spread ×1.5), **retro consoles**
  (DS Lite 61k, PS2 22k), **watches** (G-Shock 131k, Seiko 28k), **mainstream
  clothing** (Patagonia 94k, Carhartt 61k), **Warhammer / Lego** (246k / 40k).
  Tight spreads and global supply from JP/EU mean the market is efficient;
  margins exist only for specialists who can grade condition or spot rare sets.
- **Music gear**, our current niche, sits between tiers: DS-1 has 1,806 active
  at a tight ×1.9 spread with 0% Irish supply — a fair market, fine for
  off-eBay sourcing with known values, weak for eBay-to-eBay flips.

## What the API still can't tell you

Sell-through (how many actually sell per month). The blogs claim high rates for
tools, parts and vintage audio; the API can't confirm it. Two ways to get it:
Seller Hub → Product Research on ebay.ie (free, manual), or let the tracker run
— `scanner/configs/` has a ready scan config per Tier 1 niche; switch one on and
in two weeks `npm run market` shows its measured sell-through.

## Sources (opinion side)

- [Flippedit — most profitable items to flip, ranked by margin](https://flippedit.com.au/blog/most-profitable-items-to-flip-on-ebay)
- [Underpriced AI — thrift finds that flip in 2026](https://underpricedai.com/blog/best-thrift-store-finds-to-sell-on-ebay-in-2026-profitable-flipping-guide)
- [OneScan — 12 categories with real prices](https://onescanmobile.com/blog/best-products-to-flip-2026/)
- [Closo — the boring problem-solver beats the trendy item](https://closo.co/blogs/data-driven-insights-market-analytics/the-best-item-to-resell-in-2026-it-s-not-what-you-think)
- [Dashvue — best-selling items on eBay UK](https://dashvue.co.uk/blog/best-selling-items-ebay-uk)
- [Slayva — best sell-through categories, incl. Business & Industrial](https://slayva.com/what-to-sell-on-ebay-2026/)
- [ZIK Analytics — best things to resell](https://www.zikanalytics.com/blog/best-things-to-resell-on-ebay/)
