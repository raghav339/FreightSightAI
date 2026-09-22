// Language support for the FreightSight frontend (English + Bengali, Odia, Telugu, Tamil).
//
// * Catalogs live in ./locales/<code>.json (one nested JSON per language, {{placeholders}}).
// * The choice is remembered in localStorage and sent to the backend as `X-Lang`
//   (see api/client.js) so server-built decision text (analyst read, charter window,
//   vessel rationale...) arrives in the same language.
// * Missing keys fall back to English; in dev they are also logged so gaps are visible.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import bn from "./locales/bn.json";
import or from "./locales/or.json";
import te from "./locales/te.json";
import ta from "./locales/ta.json";

export const LANGUAGES = [
  { code: "en", native: "English", name: "English" },
  { code: "bn", native: "বাংলা", name: "Bengali" },
  { code: "or", native: "ଓଡ଼ିଆ", name: "Odia" },
  { code: "te", native: "తెలుగు", name: "Telugu" },
  { code: "ta", native: "தமிழ்", name: "Tamil" },
];
export const SUPPORTED = LANGUAGES.map((l) => l.code);
export const STORAGE_KEY = "freightsight.lang";

const ALIASES = { od: "or", odia: "or", oriya: "or" };

export function normalizeLang(raw) {
  if (!raw || typeof raw !== "string") return "en";
  const primary = raw.split(/[-_]/)[0].toLowerCase();
  const code = ALIASES[primary] || primary;
  return SUPPORTED.includes(code) ? code : "en";
}

function detectLanguage() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  const prefs = (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || [];
  for (const p of prefs) {
    const code = normalizeLang(p);
    if (code !== "en" || /^en/i.test(p || "")) return code;
  }
  return "en";
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    bn: { translation: bn },
    or: { translation: or },
    te: { translation: te },
    ta: { translation: ta },
  },
  lng: detectLanguage(),
  fallbackLng: "en",
  supportedLngs: SUPPORTED,
  nsSeparator: false, // port and commodity names may contain ':' or '&'
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
  saveMissing: false,
  missingKeyHandler: undefined,
  parseMissingKeyHandler: (key) => {
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key: ${key}`);
    return key;
  },
});

function applyLanguage(lng) {
  if (typeof document !== "undefined") document.documentElement.lang = lng;
  try {
    window.localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* ignore */
  }
}
applyLanguage(i18n.language);
i18n.on("languageChanged", applyLanguage);

export default i18n;
