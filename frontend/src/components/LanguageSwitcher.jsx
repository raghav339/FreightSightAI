import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "../i18n/index.js";

// Compact language picker for the navbar. Uses a native <select> so it works with
// keyboards, screen readers and mobile pickers without extra code.
export default function LanguageSwitcher({ className = "" }) {
  const { i18n, t } = useTranslation();
  const current = LANGUAGES.some((l) => l.code === i18n.language) ? i18n.language : "en";
  return (
    <label className={`inline-flex items-center gap-1.5 border border-rule/60 px-2 py-1.5 text-inksoft hover:text-ink ${className}`}>
      <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t("nav.language")}</span>
      <select
        value={current}
        onChange={(e) => i18n.changeLanguage(e.target.value)}
        className="lang-switcher bg-transparent text-[12px] text-ink outline-none"
        aria-label={t("nav.language")}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>{l.native}</option>
        ))}
      </select>
    </label>
  );
}
