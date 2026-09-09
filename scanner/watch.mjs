#!/usr/bin/env node
/*
 * watch.mjs — "did it sell?" for listings you're tracking (Build Plan stage 05).
 *
 *   node watch.mjs https://www.ebay.ie/itm/123456789012 234567890123
 *   node watch.mjs --file scan-results.json      # checks every candidate's url
 *
 * Prints active / ended / gone for each. The Browse API tells you a listing's
 * status, never the final price — record that in Scout yourself.
 */
import { readFileSync } from "node:fs";
import { loadEnv, parseArgs } from "./env.mjs";
import { clientFromEnv } from "./ebay.mjs";

loadEnv();
const args = parseArgs(process.argv.slice(2));
if (args.sandbox) process.env.EBAY_ENV = "sandbox";
let targets = args._.slice();
if (args.file) {
  const arr = JSON.parse(readFileSync(String(args.file), "utf8"));
  targets.push(...arr.map((c) => c.url || c.itemId).filter(Boolean));
}
if (!targets.length) { console.error("Usage: node watch.mjs <ebay item url or id> ... | --file scan-results.json"); process.exit(1); }

const client = clientFromEnv(process.env, { log: (m) => console.log("  · " + m) });
let ended = 0;
for (const t of targets) {
  try {
    const s = await client.itemStatus(t);
    if (!s.live) ended++;
    const tag = s.status === "active" ? "ACTIVE" : s.status === "ended" ? "ENDED " : "GONE  ";
    console.log(`${tag}  ${isFinite(s.price) ? "€" + s.price.toFixed(2) : "     "}  ${s.title ? s.title.slice(0, 55) : t}${s.endsAt ? "  (ends " + s.endsAt.slice(0, 10) + ")" : ""}`);
  } catch (e) { console.log(`ERROR   ${t}: ${e.message}`); }
}
console.log(`\n${targets.length} checked, ${ended} no longer live. Mark those sold/passed in Scout. (${client.calls.api} API calls)`);
