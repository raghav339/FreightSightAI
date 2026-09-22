#!/usr/bin/env node
/**
 * Frontend catalog checks (run in CI: `node tools/i18n/check_catalogs.mjs`).
 *   1. Every language has exactly the English keys.
 *   2. Every {{placeholder}} and <tag> in English appears in each translation.
 *   3. Latin digits only, and each translation contains its own script.
 *   4. Every t("key") used in frontend/src exists in English.
 *   5. Reports English keys nothing uses (dead entries) as a warning.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(ROOT, "frontend", "src", "i18n", "locales");
const LANGS = ["bn", "or", "te", "ta"];
const SCRIPT = { bn: /[\u0980-\u09ff]/, or: /[\u0b00-\u0b7f]/, te: /[\u0c00-\u0c7f]/, ta: /[\u0b80-\u0bff]/ };
const NATIVE_DIGITS = /[\u09e6-\u09ef\u0b66-\u0b6f\u0c66-\u0c6f\u0be6-\u0bef]/;
// Values that legitimately stay Latin in every language (units, acronyms, brand names).
const MAY_STAY_LATIN = /^(labels\.(ports|vessels)\.|nav\.(coa)$|radar\.status\.)/;

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}
const load = (c) => flatten(JSON.parse(fs.readFileSync(path.join(DIR, `${c}.json`), "utf8")));
const tokens = (s) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}|<\/?(\w+)>/g)].map((m) => m[0].replace(/\s/g, "")).sort().join("|");

const en = load("en");
const errors = [];
const warnings = [];

for (const lang of LANGS) {
  const cat = load(lang);
  for (const k of Object.keys(en)) if (!(k in cat)) errors.push(`${lang}: missing ${k}`);
  for (const k of Object.keys(cat)) if (!(k in en)) errors.push(`${lang}: extra key ${k}`);
  for (const [k, v] of Object.entries(cat)) {
    if (!(k in en)) continue;
    if (tokens(v) !== tokens(en[k])) errors.push(`${lang}:${k} placeholders/tags differ (en: ${tokens(en[k]) || "none"}, ${lang}: ${tokens(v) || "none"})`);
    if (NATIVE_DIGITS.test(v)) errors.push(`${lang}:${k} uses non-Latin digits`);
    if (!SCRIPT[lang].test(v) && !MAY_STAY_LATIN.test(k) && /[A-Za-z]{4,}/.test(en[k]) && v === en[k]) warnings.push(`${lang}:${k} looks untranslated`);
  }
}

// keys used in code
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "locales") walk(p); }
    else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(p);
  }
})(path.join(ROOT, "frontend", "src"));

const used = new Set();
const dynamicPrefixes = new Set();
const literalStrings = new Set();
for (const f of files) {
  const code = fs.readFileSync(f, "utf8");
  for (const m of code.matchAll(/\b(?:t|i18n\.t)\(\s*(["'`])([^"'`]+?)\1/g)) {
    if (m[1] === "`" && m[2].includes("${")) dynamicPrefixes.add(m[2].split("${")[0]);
    else used.add(m[2]);
  }
  // template literals with an expression, e.g. t(`result.confidence.${level}`): record the static prefix
  for (const m of code.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) dynamicPrefixes.add(m[1]);
  // a full key stored as a string and translated later, e.g. setError("form.errors.routeOptions")
  for (const m of code.matchAll(/["']((?:[a-z][A-Za-z0-9]*\.)+[A-Za-z0-9_]+)["']/g)) literalStrings.add(m[1]);
  for (const m of code.matchAll(/i18nKey=["']([^"']+)["']/g)) used.add(m[1]);
  for (const m of code.matchAll(/(?:labelKey|titleKey|descKey):\s*["']([^"']+)["']/g)) used.add(m[1]);
}
for (const k of used) if (!(k in en)) errors.push(`code uses missing key: ${k}`);
for (const k of Object.keys(en)) {
  if (used.has(k) || literalStrings.has(k) || k.startsWith("labels.")) continue;
  if ([...dynamicPrefixes].some((p) => k.startsWith(p))) continue;
  warnings.push(`unused key: ${k}`);
}

if (warnings.length) console.warn(`warnings (${warnings.length}):\n  ` + warnings.slice(0, 40).join("\n  ") + (warnings.length > 40 ? `\n  ... ${warnings.length - 40} more` : ""));
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n  ` + errors.slice(0, 80).join("\n  "));
  process.exit(1);
}
console.log(`i18n catalogs OK: ${Object.keys(en).length} keys x ${LANGS.length + 1} languages.`);
