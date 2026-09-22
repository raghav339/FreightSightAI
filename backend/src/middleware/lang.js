// backend/src/middleware/lang.js
//
// Carries the user's interface language through a request so that any call the
// backend makes to the ML service can forward it (X-Lang header) without every route
// having to pass it along. The ML service then builds its decision text (analyst
// read, charter window, vessel rationale, COA notes...) in that language.
//
// Language comes from the `X-Lang` request header (sent by the frontend), falling
// back to the first tag of `Accept-Language`, then English.
const { AsyncLocalStorage } = require("node:async_hooks");

const SUPPORTED = ["en", "bn", "or", "te", "ta"];
const DEFAULT_LANG = "en";
const ALIASES = { od: "or", odia: "or", oriya: "or" };

const storage = new AsyncLocalStorage();

function normalizeLang(raw) {
  if (!raw || typeof raw !== "string") return DEFAULT_LANG;
  const first = raw.split(",")[0].split(";")[0].trim().toLowerCase().replace("_", "-");
  const primary = ALIASES[first.split("-")[0]] || first.split("-")[0];
  return SUPPORTED.includes(primary) ? primary : DEFAULT_LANG;
}

function langMiddleware(req, res, next) {
  const lang = normalizeLang(req.get("x-lang") || req.get("accept-language"));
  req.lang = lang;
  storage.run({ lang }, next);
}

/** Language of the request currently being handled (undefined outside a request). */
function currentLang() {
  return storage.getStore()?.lang;
}

module.exports = { SUPPORTED, DEFAULT_LANG, normalizeLang, langMiddleware, currentLang };
