# Scan configs — one per niche

Run one with `node scan.mjs --config configs/trade-parts.json` (from `scanner/`).
Each sets the niche label Scout uses, the model-level searches, and postage
assumptions for when a listing doesn't state postage (heavier goods, higher
assumptions). Everything else comes from `DEFAULT_CONFIG` in `scan.mjs`.
The niche shortlist behind these is in [`../../NICHES.md`](../../NICHES.md).

**Switched on** (run by `npm run daily` and the morning routine): `music-gear.json`,
`trade-parts.json`. To add one, append `--config configs/<name>.json` to the
`daily` script in `package.json`.

**Keep each search to one part type.** "Vaillant PCB" returns €100 main boards
and €20 display boards together; the median of that mix means nothing. Use
`excludeWordsExtra` (adds to the default broken/accessory lists) to strip the
sub-parts — `trade-parts.json` drops display, interface, motor, actuator, pump
head, sensor and so on for exactly that reason.
