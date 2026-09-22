import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { subscribeMlWakeup } from "../api/mlWakeup.js";

export default function WakingBanner() {
  const { t } = useTranslation();
  const [state, setState] = useState({ active: false, phase: null });
  useEffect(() => subscribeMlWakeup(setState), []);
  if (!state.active) return null;

  const message = t(`banners.waking.${["retrying", "comparing", "working"].includes(state.phase) ? state.phase : "probing"}`);

  // NOTE: no longer owns its own fixed positioning — StatusBanners (in
  // App.jsx) stacks this alongside ConnectionBanner in one fixed column so
  // an ML cold-start and a dropped connection can both show at once
  // without overlapping each other.
  return (
    <div role="status" aria-live="polite" className="pointer-events-auto flex max-w-[min(92vw,760px)] items-center gap-3 border border-rule/55 bg-parchment/96 px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.15em] text-ink shadow-[0_2px_0_rgb(255_255_255_/_0.45)] backdrop-blur-[2px]">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vermilion opacity-45" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-vermilion/70 bg-paper" />
      </span>
      <span className="text-rule">{t("banners.waking.label")}</span>
      <span className="h-3 w-px bg-rule/40" />
      <span>{message}</span>
      <span className="ml-auto hidden font-mono text-[8px] tracking-[0.14em] text-rule sm:inline">{t("banners.waking.status")}</span>
    </div>
  );
}
