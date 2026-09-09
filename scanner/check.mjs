#!/usr/bin/env node
/*
 * check.mjs — prove the eBay keys work before you rely on them.
 *
 *   node check.mjs                 # uses scanner/.env (or exported env vars)
 *   node check.mjs --sandbox       # force the sandbox host
 *   node check.mjs --q "Boss DS-1" # search something specific
 *
 * It mints an Application token, runs one Browse search on your marketplace,
 * and prints what came back — or a plain-English reason why it didn't.
 */
import { loadEnv, parseArgs } from "./env.mjs";
import { clientFromEnv, EbayError } from "./ebay.mjs";

loadEnv();
const args = parseArgs(process.argv.slice(2));
if (args.sandbox) process.env.EBAY_ENV = "sandbox";
if (args.production) process.env.EBAY_ENV = "production";
if (args.marketplace) process.env.EBAY_MARKETPLACE = String(args.marketplace);

let client;
try { client = clientFromEnv(process.env, { log: (m) => console.log("  · " + m) }); }
catch (e) { console.error("✗ " + e.message + "\n  Copy scanner/.env.example to scanner/.env and fill in your keyset."); process.exit(1); }

const q = args.q ? String(args.q) : "Shure SM58";
console.log(`eBay check — ${client.env} · ${client.marketplace} · q="${q}"`);

try {
  const t0 = Date.now();
  await client.getToken();
  console.log(`✓ token minted (${Date.now() - t0} ms), valid ~${Math.round((client.token.expiresAt - Date.now()) / 60000)} min`);
  const r = await client.search({ q, limit: 5, filter: { buyingOptions: ["FIXED_PRICE"] } });
  console.log(`✓ search ok — ${r.total} matching listings on ${client.marketplace}; first ${r.items.length}:`);
  for (const it of r.items) {
    const ship = it.shipping == null ? "ship ?" : it.shipping === 0 ? "free ship" : "+" + it.shipping.toFixed(2) + " ship";
    console.log(`   ${it.price.toFixed(2)} ${it.currency} (${ship})  ${it.cond.padEnd(10).slice(0, 10)}  ${it.title.slice(0, 60)}`);
  }
  if (client.env === "sandbox" && r.total === 0) console.log("  (sandbox often returns nothing for real product names — that's normal; the plumbing works. Switch to production for real data.)");
  console.log(`\nCalls used: ${client.calls.api} API + ${client.calls.token} token. You're good — run: node scan.mjs`);
} catch (e) {
  console.error("✗ " + e.message);
  if (e instanceof EbayError && e.status === 403 && client.env === "production") {
    console.error("  If your Production keyset was created just now it can take a few minutes to activate.\n  Try --sandbox with your Sandbox keyset to confirm the code path meanwhile.");
  }
  process.exit(1);
}
