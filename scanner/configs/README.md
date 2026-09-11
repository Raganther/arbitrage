# Scan configs — one per niche

Run one with `node scan.mjs --config configs/trade-parts.json` (from `scanner/`).
Each sets the niche label Scout uses, the model-level searches, and postage
assumptions for when a listing doesn't state postage (heavier goods, higher
assumptions). Everything else comes from `DEFAULT_CONFIG` in `scan.mjs`.
The niche shortlist behind these is in [`../../NICHES.md`](../../NICHES.md).
