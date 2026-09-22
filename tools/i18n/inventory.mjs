#!/usr/bin/env node
/**
 * i18n Phase 0: inventory every user-visible string in FreightSightAI.
 *
 *   node tools/i18n/inventory.mjs           regenerate docs/i18n_inventory.{md,json}
 *   node tools/i18n/inventory.mjs --check   exit 1 if new strings appeared since the last run
 *
 * Sources scanned
 *   frontend/src            JSX text, JSX attributes, messages/labels in JS      (AST, @babel/parser)
 *   frontend/index.html     <title>, meta description, <noscript>
 *   backend/src             API errors, PDF / decision-brief copy, messages      (AST, @babel/parser)
 *   ml-service              f-strings, API errors, exceptions, enum values       (tools/i18n/py_extract.py)
 *   data values             ports, commodities, vessel classes, modes            (ml-service data files)
 *
 * The scan is deliberately over-inclusive. Every entry gets a confidence level and an
 * audience; a human then marks each one done / keep-english. Statuses and translation keys
 * you record in docs/i18n_inventory.json survive regeneration.
 *
 * Requires: node 18+, python3, and `npm install` in frontend/ (for @babel/parser).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_MD = path.join(ROOT, "docs", "i18n_inventory.md");
const OUT_JSON = path.join(ROOT, "docs", "i18n_inventory.json");
const CHECK = process.argv.includes("--check");

// ---------------------------------------------------------------- parser
const requireFromFrontend = createRequire(path.join(ROOT, "frontend", "package.json"));
let babel;
try {
  babel = requireFromFrontend("@babel/parser");
} catch {
  console.error("Cannot find @babel/parser. Run `npm install` in frontend/ first.");
  process.exit(2);
}

function parse(code, jsx) {
  return babel.parse(code, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: jsx ? ["jsx"] : [],
  });
}

// ---------------------------------------------------------------- helpers
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function walkDir(dir, exts, skipDirs = new Set()) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkDir(p, exts, skipDirs));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out.sort();
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const hasLetters = (s) => /\p{L}{2,}/u.test(s);
const alphaWords = (s) => (s.replace(/\{[^}]*\}/g, " ").match(/[A-Za-z][A-Za-z'\-]+/g) || []).filter((w) => w.length >= 2);
const isPathOrUrl = (s) => /^(\/|https?:|wss?:|data:|\.{1,2}\/|#|mailto:)/.test(s.trim());

// "text-xs flex items-center hover:bg-x" style strings are Tailwind classes, not copy.
function classy(s) {
  const toks = s.trim().split(/\s+/);
  if (toks.length < 2) return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(s);
  const hits = toks.filter((t) => /^[a-z0-9!\-:\/\[\]\.%_#()@,'"=&>+*]+$/.test(t) && /[-:\[\/]/.test(t)).length;
  return hits / toks.length >= 0.5;
}

// HTTP header names, MIME types, PDF built-in font names and download file names: not copy.
const TECHNICAL = /^([A-Z][a-z]+(-[A-Z][a-z]+)+|application\/[\w.+-]+|text\/[\w.+-]+|(Helvetica|Times|Courier)(-\w+)?|attachment; filename=.*|Bearer\s.*|[A-Z][a-z]+(-[A-Za-z]+)*: )$/;
const SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH|FROM|SET|REPLACE)\b/i;

function looksLikeSentence(s) {
  const t = s.trim();
  if (!t || isPathOrUrl(t) || SQL.test(t) || classy(t)) return false;
  if (!/\s/.test(t)) return false;
  const words = alphaWords(t);
  if (words.length < 2) return false;
  return /^[A-Z{]/.test(t) || /[.,;:!?—–()]/.test(t) || words.length >= 4;
}

function placeholderName(e) {
  if (!e) return "value";
  switch (e.type) {
    case "Identifier": return e.name;
    case "MemberExpression":
    case "OptionalMemberExpression":
      return e.computed && e.property.type === "StringLiteral" ? e.property.value : e.property.name || "value";
    case "CallExpression":
    case "OptionalCallExpression":
      if (e.callee.type.includes("Member") && e.callee.object) return placeholderName(e.callee.object);
      return e.arguments[0] ? placeholderName(e.arguments[0]) : "value";
    case "ConditionalExpression": return placeholderName(e.consequent);
    case "LogicalExpression": return placeholderName(e.left);
    default: return "value";
  }
}

function templateText(node) {
  let out = "";
  node.quasis.forEach((q, i) => {
    out += q.value.cooked ?? q.value.raw;
    if (i < node.expressions.length) out += `{${placeholderName(node.expressions[i])}}`;
  });
  return out;
}

/** Text leaves reachable through ?:, &&, ||, ??, (..) and template literals. */
function leaves(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case "StringLiteral": out.push({ node, text: node.value }); break;
    case "TemplateLiteral": out.push({ node, text: templateText(node) }); break;
    case "ConditionalExpression": leaves(node.consequent, out); leaves(node.alternate, out); break;
    case "LogicalExpression": leaves(node.left, out); leaves(node.right, out); break;
    case "ParenthesizedExpression": leaves(node.expression, out); break;
    case "BinaryExpression": if (node.operator === "+") { leaves(node.left, out); leaves(node.right, out); } break;
    default: break;
  }
  return out;
}

function markAll(node, handled) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (n.type === "StringLiteral" || n.type === "TemplateLiteral" || n.type === "JSXText") handled.add(n);
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => x && typeof x === "object" && stack.push(x));
      else if (v && typeof v === "object" && v.type) stack.push(v);
    }
  }
}

// ---------------------------------------------------------------- JS extractor
const ATTR_TEXT = new Set([
  "placeholder", "title", "alt", "aria-label", "aria-description", "aria-placeholder", "label", "hint",
  "description", "caption", "tooltip", "helperText", "error", "summary", "content", "heading", "subtitle",
  "message", "text", "body", "cta", "emptyText", "okText", "kicker", "eyebrow",
]);
const KEY_TEXT = new Set([
  "title", "label", "body", "description", "message", "text", "hint", "error", "summary", "heading", "subtitle",
  "caption", "tagline", "cta", "placeholder", "tooltip", "note", "reason", "detail", "warning", "helper",
  "question", "answer", "sub", "eyebrow", "kicker", "recommendation", "rationale", "explanation", "msg",
  "subject", "disclaimer", "footnote", "headline", "model", "status_text", "statusText",
]);
const CLASS_CALLS = new Set(["cn", "clsx", "twMerge", "classNames", "cva"]);
const MESSAGE_SETTERS = /^(set(Error|Message|Notice|Warning|Status|Info|Toast|Feedback)\w*|alert|toast\w*|notify\w*)$/;
const BACKEND_ERROR_CALLS = /^(send\w*Error|sendError|fail|badRequest|notFound|unauthorized|forbidden|httpError)$/;
const DOC_CALLS = new Set(["text", "textWithLinks", "list", "cell", "label", "heading", "title", "paragraph", "line", "kv", "row"]);

function extractJs(file, area) {
  const code = fs.readFileSync(file, "utf8");
  const isBackend = area === "backend";
  const rf = rel(file);
  const isDocFile = isBackend && /(pdf|brief|copy)/i.test(path.basename(file));
  let ast;
  try {
    ast = parse(code, !isBackend || file.endsWith(".jsx"));
  } catch (e) {
    console.error(`warning: could not parse ${rf}: ${e.message}`);
    return [];
  }
  const found = [];
  const handled = new WeakSet();
  const fnStack = [];

  const add = (node, text, kind, confidence) => {
    const t = norm(text);
    if (!t || handled.has(node)) return;
    // Letters outside {placeholders}: "{d} {value} {d}" is a format template, not copy;
    // a bare "d" is not text, but "{days} d" is a unit label worth translating.
    const bare = t.replace(/\{[^}]*\}/g, "");
    const letters = (bare.match(/\p{L}/gu) || []).length;
    if (letters === 0 || (letters === 1 && bare === t)) return;
    if (TECHNICAL.test(t)) return;
    handled.add(node);
    found.push({ area, file: rf, line: node.loc?.start.line ?? 0, kind, confidence, text: t, context: fnStack.join(".") || "<module>" });
  };

  function visit(node, parent, ancestors) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, parent, ancestors)); return; }
    if (!node.type) return;

    const enterFn =
      node.type === "FunctionDeclaration" ? node.id?.name :
      node.type === "VariableDeclarator" && node.init && /Function/.test(node.init.type) ? node.id?.name :
      node.type === "ClassMethod" ? node.key?.name : null;
    if (enterFn) fnStack.push(enterFn);

    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        markAll(node, handled); break;
      case "ExportNamedDeclaration":
        if (node.source) markAll(node, handled); break;

      case "JSXText": {
        const t = norm(node.value);
        if (t && hasLetters(t)) add(node, t, "jsx-text", "high");
        break;
      }
      case "JSXAttribute": {
        const name = node.name?.name ?? "";
        const value = node.value;
        if (value) {
          const ls = value.type === "JSXExpressionContainer" ? leaves(value.expression) : leaves(value);
          if (ATTR_TEXT.has(name)) ls.forEach((l) => add(l.node, l.text, "jsx-attr", "high"));
          else if (!/^(className|class|style|key|id|type|name|to|href|src|d|viewBox|fill|stroke|xmlns|rel|target|role|htmlFor|value|defaultValue|variant|size|as|direction|position|mode|dir|lang|min|max|step|pattern|accept|autoComplete|inputMode|sandbox|loading)$/.test(name))
            ls.forEach((l) => { if (looksLikeSentence(l.text)) add(l.node, l.text, "jsx-attr", "medium"); });
          markAll(value, handled);
        }
        break;
      }
      case "JSXExpressionContainer": {
        if (parent && (parent.type === "JSXElement" || parent.type === "JSXFragment")) {
          leaves(node.expression).forEach((l) => { if (!classy(l.text)) add(l.node, l.text, "jsx-expr", "high"); });
        }
        break;
      }
      case "CallExpression":
      case "OptionalCallExpression": {
        const c = node.callee;
        const name = c.type === "Identifier" ? c.name : c.type.includes("Member") ? c.property?.name : "";
        const obj = c.type.includes("Member") && c.object?.type === "Identifier" ? c.object.name : "";
        if (CLASS_CALLS.has(name) || name === "require" || obj === "console" || obj === "localStorage" || obj === "sessionStorage" ||
            /^(get|post|put|patch|delete|head)$/.test(name) && /^(api|axios|http|client|router|app)$/.test(obj)) {
          if (!(isBackend && /^(get|post|put|patch|delete|head)$/.test(name) && /^(router|app)$/.test(obj))) { markAll(node.arguments?.[0] ?? node, handled); }
          if (CLASS_CALLS.has(name) || obj === "console") markAll(node, handled);
        }
        // Date/number formatting call sites (Phase 5): they follow the browser locale unless told otherwise.
        if (/^toLocale(Date|Time)?String$/.test(name)) {
          const src = code.slice(node.start, Math.min(node.end, node.start + 80)).split("\n")[0];
          add(node, `${name}() call: ${src.length > 70 ? src.slice(0, 70) + "..." : src}`, "format-call", "high");
        }
        if (MESSAGE_SETTERS.test(name)) node.arguments.forEach((a) => leaves(a).forEach((l) => add(l.node, l.text, "js-message", "high")));
        else if (isBackend && BACKEND_ERROR_CALLS.test(name)) node.arguments.forEach((a) => leaves(a).forEach((l) => looksLikeSentence(l.text) && add(l.node, l.text, "api-message", "high")));
        else if (isDocFile && DOC_CALLS.has(name)) node.arguments.forEach((a) => leaves(a).forEach((l) => add(l.node, l.text, "document-text", "high")));
        else if (isBackend && obj === "res" && /^(send|json|status)$/.test(name)) node.arguments.forEach((a) => leaves(a).forEach((l) => looksLikeSentence(l.text) && add(l.node, l.text, "api-message", "high")));
        break;
      }
      case "NewExpression": {
        if (node.callee.type === "MemberExpression" && node.callee.object?.name === "Intl") {
          const src = code.slice(node.start, Math.min(node.end, node.start + 80)).split("\n")[0];
          add(node, `Intl.${node.callee.property.name} usage: ${src}`, "format-call", "high");
        }
        if (node.callee.type === "Identifier" && /Error$/.test(node.callee.name))
          node.arguments.forEach((a) => leaves(a).forEach((l) => add(l.node, l.text, isBackend ? "error-message" : "js-message", "medium")));
        break;
      }
      case "AssignmentExpression": {
        const l = node.left;
        if (l.type === "MemberExpression" && l.object?.name === "document" && l.property?.name === "title")
          leaves(node.right).forEach((x) => add(x.node, x.text, "document-title", "high"));
        break;
      }
      case "ObjectProperty": {
        const key = node.key?.name ?? node.key?.value;
        if (key && !node.computed) {
          if (KEY_TEXT.has(key)) {
            const kind = isDocFile ? "document-text" : isBackend ? "api-message" : "js-data";
            leaves(node.value).forEach((l) => add(l.node, l.text, kind, isDocFile || isBackend ? "high" : "medium"));
          } else {
            // Label maps such as STATUS_LABEL = { underway: "Underway" } (single capitalised words)
            const decl = ancestors.findLast?.((a) => a.type === "VariableDeclarator");
            const vname = decl?.id?.name || "";
            leaves(node.value).forEach((l) => {
              if (/(LABEL|TEXT|COPY|NAMES?|TITLE|STATUS|STYLE)/i.test(vname) && /^[A-Z][a-z]+([ /][A-Za-z]+)*$/.test(l.text)) add(l.node, l.text, "js-label", "low");
            });
          }
        }
        break;
      }
      case "StringLiteral":
      case "TemplateLiteral": {
        if (handled.has(node)) break;
        const text = node.type === "StringLiteral" ? node.value : templateText(node);
        const p = parent?.type;
        if (p === "BinaryExpression" || p === "SwitchCase" || p === "ImportDeclaration" || (p === "MemberExpression" && parent.computed)) break;
        if (p === "ObjectProperty" && parent.key === node) break;
        if (isDocFile && !isPathOrUrl(text) && hasLetters(text) && /[A-Za-z]{3}/.test(text) && !SQL.test(text) && !classy(text) && !/^[a-z_\-.]+$/.test(text)) { add(node, text, "document-text", "medium"); break; }
        if (looksLikeSentence(text)) add(node, text, "js-string", "low");
        break;
      }
      default: break;
    }

    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments" || k === "extra") continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => x && x.type && visit(x, node, [...ancestors, node]));
      else if (v && typeof v === "object" && v.type) visit(v, node, [...ancestors, node]);
    }
    if (enterFn) fnStack.pop();
  }

  visit(ast.program, null, []);
  return found;
}

// ---------------------------------------------------------------- other sources
function extractHtml(file) {
  const html = fs.readFileSync(file, "utf8");
  const rf = rel(file);
  const out = [];
  const lineOf = (idx) => html.slice(0, idx).split("\n").length;
  for (const m of html.matchAll(/<title>([\s\S]*?)<\/title>/gi))
    out.push({ area: "frontend", file: rf, line: lineOf(m.index), kind: "html-title", confidence: "high", text: norm(m[1]), context: "<head>" });
  for (const m of html.matchAll(/<meta[^>]+name=["'](description|apple-mobile-web-app-title)["'][^>]+content=["']([^"']+)["']/gi))
    out.push({ area: "frontend", file: rf, line: lineOf(m.index), kind: "html-meta", confidence: "high", text: norm(m[2]), context: `meta:${m[1]}` });
  for (const m of html.matchAll(/<noscript>([\s\S]*?)<\/noscript>/gi)) {
    const t = norm(m[1].replace(/<[^>]+>/g, " "));
    if (t) out.push({ area: "frontend", file: rf, line: lineOf(m.index), kind: "html-noscript", confidence: "high", text: t, context: "<noscript>" });
  }
  return out;
}

function runPython() {
  const r = spawnSync("python3", [path.join(ROOT, "tools", "i18n", "py_extract.py"), ROOT], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error("warning: Python extraction failed; ml-service strings will be missing.\n" + (r.stderr || r.error || ""));
    return [];
  }
  return JSON.parse(r.stdout);
}

function dataValues() {
  const out = {};
  const meta = path.join(ROOT, "ml-service", "models", "metadata.json");
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, "utf8"));
    for (const k of ["commodities", "origins", "destinations", "shipment_modes", "vessel_types"]) if (Array.isArray(m[k])) out[k] = [...m[k]];
  }
  // tracked AIS ports (PORT_COORDS keys in ais_stream.py)
  const ais = path.join(ROOT, "ml-service", "app", "ais_stream.py");
  if (fs.existsSync(ais)) {
    const src = fs.readFileSync(ais, "utf8");
    const block = src.match(/PORT_COORDS[^=]*=\s*\{([\s\S]*?)\n\}/);
    if (block) out.ais_ports = [...block[1].matchAll(/^\s*["']([^"']+)["']\s*:/gm)].map((m) => m[1]);
  }
  const infra = path.join(ROOT, "ml-service", "port_infra.json");
  if (fs.existsSync(infra)) {
    const j = JSON.parse(fs.readFileSync(infra, "utf8"));
    const ports = j.ports || j;
    if (ports && typeof ports === "object") out.port_infra_ports = Object.keys(ports).filter((k) => !k.startsWith("_"));
  }
  const vm = path.join(ROOT, "ml-service", "data", "production", "vessel_class_master.csv");
  if (fs.existsSync(vm)) {
    const [head, ...rows] = fs.readFileSync(vm, "utf8").trim().split(/\r?\n/);
    const cols = head.split(",");
    const idx = cols.findIndex((c) => /vessel_class|class/i.test(c));
    if (idx >= 0) out.vessel_classes_csv = [...new Set(rows.map((r) => r.split(",")[idx]).filter(Boolean))];
  }
  const syn = path.join(ROOT, "ml-service", "data", "synthetic", "route_freight_observations.csv");
  if (fs.existsSync(syn)) {
    const lines = fs.readFileSync(syn, "utf8").split(/\r?\n/);
    const cols = lines[0].split(",");
    const ci = cols.indexOf("commodity");
    if (ci >= 0) out.commodities_in_route_data = [...new Set(lines.slice(1).map((l) => l.split(",")[ci]).filter(Boolean))].sort();
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

// ---------------------------------------------------------------- collect
const operatorFile = /(ais_demo_seed|\/brent\.py|route_freight_model\.py|data_paths\.py|backend\/src\/config\/|backend\/src\/db\/)/;

function collect() {
  let items = [];
  const fe = walkDir(path.join(ROOT, "frontend", "src"), [".js", ".jsx"], new Set(["i18n", "locales", "node_modules"]));
  for (const f of fe) items.push(...extractJs(f, "frontend"));
  items.push(...extractHtml(path.join(ROOT, "frontend", "index.html")));
  const swf = path.join(ROOT, "frontend", "public", "sw.js");
  if (fs.existsSync(swf)) items.push(...extractJs(swf, "frontend"));

  const be = walkDir(path.join(ROOT, "backend", "src"), [".js"], new Set(["db", "node_modules"]));
  for (const f of be) items.push(...extractJs(f, "backend"));

  items.push(...runPython());

  for (const it of items) {
    it.audience =
      operatorFile.test(it.file) || /^FreightSight ml-service FAILED/.test(it.text) || (it.file.endsWith("ais_stream.py") && it.kind === "exception")
        ? "operator"
        : "user";
  }
  return items;
}

function consolidate(items) {
  const byId = new Map();
  for (const it of items) {
    const id = crypto.createHash("sha1").update(`${it.file}|${it.text}`).digest("hex").slice(0, 8);
    const cur = byId.get(id);
    if (cur) {
      if (!cur.lines.includes(it.line)) cur.lines.push(it.line);
      const rank = { high: 3, medium: 2, low: 1 };
      if (rank[it.confidence] > rank[cur.confidence]) { cur.confidence = it.confidence; cur.kind = it.kind; }
    } else {
      byId.set(id, { id, area: it.area, file: it.file, lines: [it.line], kind: it.kind, confidence: it.confidence, audience: it.audience, text: it.text, context: it.context });
    }
  }
  return [...byId.values()].sort((a, b) => a.file.localeCompare(b.file) || a.lines[0] - b.lines[0]);
}

// ---------------------------------------------------------------- previous state
function loadPrevious() {
  if (!fs.existsSync(OUT_JSON)) return null;
  try { return JSON.parse(fs.readFileSync(OUT_JSON, "utf8")); } catch { return null; }
}

const entries = consolidate(collect());
const prev = loadPrevious();
const prevById = new Map((prev?.entries || []).map((e) => [e.id, e]));

if (CHECK) {
  if (!prev) { console.error("No docs/i18n_inventory.json yet. Run without --check first."); process.exit(2); }
  const fresh = entries.filter((e) => !prevById.has(e.id));
  if (fresh.length) {
    console.error(`${fresh.length} new user-visible string(s) not in the inventory:`);
    for (const e of fresh.slice(0, 60)) console.error(`  ${e.file}:${e.lines[0]}  [${e.kind}]  ${e.text.slice(0, 100)}`);
    if (fresh.length > 60) console.error(`  ... and ${fresh.length - 60} more`);
    console.error("Translate them (or mark keep-english), then re-run the inventory.");
    process.exit(1);
  }
  console.log("i18n inventory is up to date.");
  process.exit(0);
}

for (const e of entries) {
  const p = prevById.get(e.id);
  e.status = p?.status ?? (e.audience === "operator" ? "review" : "todo");
  e.key = p?.key ?? null;
  e.notes = p?.notes ?? "";
}
const currentIds = new Set(entries.map((e) => e.id));
// English catalog values -> catalog keys. A string that left the code because it moved into a
// catalog is progress, not a deletion: it is kept as "done" with its key.
function catalogIndex() {
  const idx = new Map();
  const canon = (t) => norm(t.replace(/<\/?\w+>/g, "").replace(/\{\{?\s*(\w+)[^}]*\}\}?/g, "{$1}"));
  const walk = (o, pre, sink) => { for (const [k, v] of Object.entries(o)) { const key = pre ? `${pre}.${k}` : k; if (v && typeof v === "object") walk(v, key, sink); else sink(key, String(v)); } };
  try {
    const fe = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend", "src", "i18n", "locales", "en.json"), "utf8"));
    walk(fe, "", (k, v) => idx.set(canon(v), `frontend:${k}`));
  } catch { /* no frontend catalog yet */ }
  try {
    const ml = JSON.parse(fs.readFileSync(path.join(ROOT, "ml-service", "app", "locales", "en.json"), "utf8"));
    for (const [k, v] of Object.entries(ml)) idx.set(canon(v.replace(/\{(\w+)[^}]*\}/g, "{$1}")), `ml-service:${k}`);
  } catch { /* no ML catalog yet */ }
  return { idx, canon };
}
const { idx: catIdx, canon } = catalogIndex();

// Entries that disappeared from the code are dropped, unless they moved into a catalog ("done"),
// or someone recorded progress on them (a status other than the defaults, a key, or notes).
const stale = [];
for (const e of prev?.entries || []) {
  if (currentIds.has(e.id)) continue;
  const key = catIdx.get(canon(e.text));
  if (key) stale.push({ ...e, status: "done", key: e.key || key, notes: e.notes || "moved to catalog" });
  else if (e.status === "gone" || !["todo", "review"].includes(e.status) || e.key || e.notes) stale.push({ ...e, status: "gone" });
}

const values = dataValues();

// ---------------------------------------------------------------- report
const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
const esc = (s) => s.replace(/\|/g, "\\|").replace(/`/g, "'").slice(0, 180);

function summaryTable() {
  const byArea = count(entries, (e) => e.area);
  const rows = Object.keys(byArea).sort().map((a) => {
    const es = entries.filter((e) => e.area === a);
    const c = count(es, (e) => e.confidence);
    const done = es.filter((e) => e.status === "done" || e.status === "keep-english").length;
    return `| ${a} | ${es.length} | ${c.high || 0} | ${c.medium || 0} | ${c.low || 0} | ${es.filter((e) => e.audience === "operator").length} | ${done} |`;
  });
  return ["| Area | Strings | High | Medium | Low | Operator-only | Done / keep-English |", "|---|---:|---:|---:|---:|---:|---:|", ...rows].join("\n");
}

function kindTable() {
  const c = count(entries, (e) => `${e.area} / ${e.kind}`);
  return ["| Area / kind | Strings |", "|---|---:|", ...Object.entries(c).sort().map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
}

function fileTable() {
  const files = [...new Set(entries.map((e) => e.file))];
  const rows = files.map((f) => {
    const es = entries.filter((e) => e.file === f);
    const done = es.filter((e) => e.status === "done" || e.status === "keep-english").length;
    return `| \`${f}\` | ${es.length} | ${done} | ${es.length - done} |`;
  });
  return ["| File | Strings | Done | Remaining |", "|---|---:|---:|---:|", ...rows].join("\n");
}

function detailSection(area) {
  const es = entries.filter((e) => e.area === area);
  const files = [...new Set(es.map((e) => e.file))];
  return files.map((f) => {
    const fe = es.filter((e) => e.file === f);
    const rows = fe.map((e) => `| \`${e.id}\` | ${e.lines.join(",")} | ${e.kind} | ${e.confidence[0].toUpperCase()}${e.audience === "operator" ? " · op" : ""} | ${esc(e.text)} | ${e.status} |`);
    return `#### \`${f}\` (${fe.length})\n\n| ID | Line | Kind | Conf | Text | Status |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
  }).join("\n");
}

const surfaces = [
  "Landing page (hero, feature cards, live tape, footer)",
  "Navbar, language switcher, footer, page titles (`<title>`, meta description)",
  "Forecast form: labels, hints, placeholders, select options, validation and service messages",
  "Forecast result: metric cards, **analyst read**, charter window and rationale, vessel block, feasibility checks, disclaimers",
  "**Decision support**: what-if panel, decision simulator, port-radar notice, decision brief (modal and PDF)",
  "Compare origins, COA optimizer, idle vessel finder (results, notes, empty states)",
  "Live fleet: banners, stat boxes, map popups/tooltips, vessels-by-port panel, empty-state reasons",
  "Port radar: status labels, evidence text, impact recommendation, confidence text",
  "History table, filters, alerts panel, risk labels",
  "Login / signup / verification flows and their error messages",
  "About page",
  "Connection, waking and offline banners; service-worker offline fallback",
  "API error messages from backend and ML service (shown in toasts/banners)",
  "PDF exports (forecast one-pager and decision brief): text **and** fonts for Bengali, Odia, Telugu, Tamil",
  "Chart axes, legends and tooltips (Recharts) and Leaflet popups",
  "Dates, numbers and units (native date input follows the browser language, not the app)",
  "Data-value labels: ports, commodities, vessel classes, shipment modes, risk/status enums",
  "Accessibility text: `aria-label`, `alt`, `title`",
];

const md = `# i18n inventory (Phase 0)

Generated by \`node tools/i18n/inventory.mjs\` on ${new Date().toISOString().slice(0, 10)}. **Do not edit by hand**: record progress in \`docs/i18n_inventory.json\` (fields \`status\`, \`key\`, \`notes\`); they are preserved when this file is regenerated.

- **Purpose:** the definition of "done" for language support. Every entry must end as \`done\` (translated via a catalog key) or \`keep-english\` (with a reason in \`notes\`).
- **Statuses:** \`todo\`, \`review\` (operator/log text: decide), \`done\`, \`keep-english\`, \`gone\` (no longer in the code).
- **Confidence:** H = certainly shown to users (JSX text, known UI props, API errors, PDF copy); M = probably; L = a sentence-like string in code that may or may not reach the screen. Low-confidence entries need a human look.
- **op:** operator-facing (config errors, training/log text). Usually stays English.
- **Placeholders:** \`{name}\` marks a value inserted at runtime (f-strings / template literals); these become \`{{name}}\` in the catalog.
- **Guard:** \`node tools/i18n/inventory.mjs --check\` fails when a new string appears that is not in the inventory, so new copy cannot slip past translation.

## Summary

${summaryTable()}

${kindTable()}

Moved into catalogs or removed since the first run: ${stale.filter((e) => e.status === "done").length} done, ${stale.filter((e) => e.status === "gone").length} gone.

## Why server-generated text matters

The **analyst read**, charter window/rationale, vessel explanations, port-radar and idle/COA notes are English sentences built in \`ml-service/app/decision_text.py\`, \`port_radar.py\`, \`idle_detector.py\`, \`coa_optimizer.py\`, \`port_utils.py\`, and (for the decision brief and PDFs) \`backend/src/utils/decisionBrief.js\`, \`pdfCopy.js\`, \`decisionBriefPdf.js\`. They are stored in the database in English. A frontend-only translation cannot reach them; they are the bulk of the \`ml-service\` and \`document-text\` rows below (Phase 2 converts them to keys + parameters).

## Surfaces checklist (tick when every string on it is done)

${surfaces.map((s) => `- [ ] ${s}`).join("\n")}

## Coverage by file

${fileTable()}

## Data values that need a display label

These keep their **English value in API calls**; only the shown label is translated. Counts are what the app currently knows about.

${Object.entries(values).map(([k, v]) => `- **${k}** (${v.length}): ${v.join(", ")}`).join("\n")}

## Not extractable from code (manual audit)

- Native \`<input type="date">\` shows the browser's language.
- Leaflet OpenStreetMap tiles show place names in their local language.
- Text baked into images/SVG (if any) and the PDFs' fonts: verify visually per script.
- Numbers and dates: every \`toLocale*String\` / \`Intl\` call site is listed as kind \`format-call\` below; each needs an explicit locale in Phase 5.

## Frontend

${detailSection("frontend")}

## Backend

${detailSection("backend")}

## ML service

${detailSection("ml-service")}
`;

fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.writeFileSync(OUT_MD, md);
fs.writeFileSync(OUT_JSON, JSON.stringify({ generated: new Date().toISOString(), data_values: values, entries: [...entries, ...stale] }, null, 1));

const byArea = count(entries, (e) => e.area);
console.log(`Inventory written: ${entries.length} strings still in code (${Object.entries(byArea).map(([a, n]) => `${a} ${n}`).join(", ")}); ${stale.filter((e) => e.status === "done").length} moved to catalogs.`);
console.log(`  ${rel(OUT_MD)}\n  ${rel(OUT_JSON)}`);
