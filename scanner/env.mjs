/*
 * env.mjs — load scanner/.env into process.env (no dependencies).
 * Existing environment variables win; the file only fills gaps.
 * Lines: KEY=value, KEY="quoted value", # comments. Nothing fancy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else { const hash = val.indexOf(" #"); if (hash >= 0) val = val.slice(0, hash).trim(); }
    out[key] = val;
  }
  return out;
}

export function loadEnv(file) {
  const path = file || join(dirname(fileURLToPath(import.meta.url)), ".env");
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return {}; }
  const vars = parseEnv(text);
  for (const [k, v] of Object.entries(vars)) if (process.env[k] == null) process.env[k] = v;
  return vars;
}

/** Tiny argv parser: --flag, --key value, --key=value. Repeated keys become arrays. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    let k = a.slice(2), v;
    const eq = k.indexOf("=");
    if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) v = argv[++i];
    else v = true;
    if (out[k] === undefined) out[k] = v;
    else out[k] = [].concat(out[k], v);
  }
  return out;
}
