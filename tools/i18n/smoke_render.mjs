#!/usr/bin/env node
/**
 * Render smoke test: server-side renders real components in every language and fails if
 *   - a raw translation key ("result.kicker", "form.submit"...) leaks onto the page,
 *   - a non-English render lacks its own script (untranslated page), or
 *   - a render throws (e.g. an identifier lost during a refactor).
 * It cannot judge visual layout; that still needs a look in a browser.
 *
 *   node tools/i18n/smoke_render.mjs      (needs `npm install` in frontend/)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FE = path.join(ROOT, "frontend");
const require = createRequire(path.join(FE, "package.json"));
const esbuild = require("esbuild");
const SRC = path.join(FE, "src");
const fixture = path.join(ROOT, "tools", "i18n", "fixtures", "forecast.json");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-i18n-"));
const stub = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };
const mapStub = stub("map.jsx", "export default function RouteMap(){ return null; }\nexport const MapContainer=()=>null,TileLayer=()=>null,Marker=()=>null,Popup=()=>null,Tooltip=()=>null,CircleMarker=()=>null,Polyline=()=>null,useMap=()=>({});");
const leafletStub = stub("leaflet.js", "export default {}; export const divIcon=()=>({}), icon=()=>({});");

const entry = path.join(tmp, "entry.jsx");
fs.writeFileSync(entry, `
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import i18n, { LANGUAGES } from "${SRC}/i18n/index.js";
import ResultCards from "${SRC}/components/ResultCards.jsx";
import ForecastForm from "${SRC}/components/ForecastForm.jsx";
import Navbar from "${SRC}/components/Navbar.jsx";
import Predict from "${SRC}/pages/Predict.jsx";
import { AuthProvider } from "${SRC}/context/AuthContext.jsx";
import fixture from "${fixture}";

const out = {};
for (const { code } of LANGUAGES) {
  await i18n.changeLanguage(code);
  const wrap = (el) => renderToString(<MemoryRouter><AuthProvider>{el}</AuthProvider></MemoryRouter>);
  out[code] = {
    result: wrap(<ResultCards result={fixture} />),
    form: wrap(<ForecastForm onResult={() => {}} />),
    nav: wrap(<Navbar />),
    predict: wrap(<Predict />),
  };
}
export default out;
`);

// Deliberately NOT defining window/document: libraries then take their server-rendering paths.
// React warns that layout effects do nothing on the server; irrelevant here.
const origError = console.error;
console.error = (...a) => { if (!String(a[0]).includes("useLayoutEffect")) origError(...a); };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const outfile = path.join(tmp, "bundle.mjs");
await esbuild.build({
  entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", jsx: "automatic", loader: { ".js": "jsx", ".json": "json" },
  define: { "import.meta.env.VITE_API_URL": "undefined", "import.meta.env.DEV": "false", "import.meta.env.PROD": "false", "import.meta.env": "{}" },
  alias: { leaflet: leafletStub },
  plugins: [{
    name: "stub-map", setup(b) {
      b.onResolve({ filter: /RouteMap\.jsx$|react-leaflet$/ }, () => ({ path: mapStub }));
      b.onResolve({ filter: /^leaflet\/dist\/leaflet\.css$|\.css$/ }, () => ({ path: stub("empty.css", ""), }));
    },
  }],
  nodePaths: [path.join(FE, "node_modules")], logLevel: "error", banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const results = (await import(pathToFileURL(outfile).href)).default;

const SCRIPT = { bn: /[\u0980-\u09ff]/, or: /[\u0b00-\u0b7f]/, te: /[\u0c00-\u0c7f]/, ta: /[\u0b80-\u0bff]/ };
const KEYLIKE = /\b(?:nav|form|result|predict|notice|banners|brief|trend|footer|common|radar|labels)\.[A-Za-z][A-Za-z0-9_.]*\b/g;
const problems = [];
let checks = 0;
for (const [lang, pages] of Object.entries(results)) {
  for (const [name, html] of Object.entries(pages)) {
    checks++;
    const text = html.replace(/<[^>]+>/g, " ");
    const leaked = [...new Set(text.match(KEYLIKE) || [])].filter((k) => !/^\d/.test(k));
    if (leaked.length) problems.push(`${lang}/${name}: raw keys on page: ${leaked.slice(0, 5).join(", ")}`);
    if (lang !== "en" && !SCRIPT[lang].test(text)) problems.push(`${lang}/${name}: no ${lang} script rendered`);
  }
}
// spot checks that specific data really is localised
const has = (lang, page, needle) => results[lang][page].includes(needle) || problems.push(`${lang}/${page}: expected "${needle}"`);
has("bn", "form", "চালানের বিবরণ");
has("ta", "result", "சந்தை இடர்");
has("te", "nav", "అంచనా");
has("or", "predict", "ଏକ ଚାଲାଣ ଯୋଜନା କରନ୍ତୁ");
has("bn", "result", "পারাদ্বীপ"); // port names in the route line come from the label catalog
fs.rmSync(tmp, { recursive: true, force: true });

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`render smoke OK: ${checks} page renders across ${Object.keys(results).length} languages.`);
