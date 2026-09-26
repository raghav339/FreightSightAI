import { useEffect, useState } from "react";
import { subscribeMlWakeup } from "../api/mlWakeup.js";

export default function WakingBanner() {
  const [state, setState] = useState({ active: false, phase: null });
  useEffect(() => subscribeMlWakeup(setState), []);
  if (!state.active) return null;

  const message = state.phase === "retrying"
    ? "still waking up — retrying automatically"
    : state.phase === "comparing"
    ? "comparing loading ports and vessel signals — stand by"
    : state.phase === "working"
    ? "forecasting service is processing the sheet"
    : "forecasting service is waking from an idle instance";

  // Positioning is owned by StatusBanners (in App.jsx), which stacks this
  // alongside ConnectionBanner in one fixed column so an ML cold-start and
  // a dropped connection can both show at once without overlapping.
  return (
    <div role="status" aria-live="polite" className="pointer-events-auto flex max-w-[min(92vw,760px)] items-center gap-3 border border-rule/55 bg-parchment/96 px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.15em] text-ink shadow-[0_2px_0_rgb(255_255_255_/_0.45)] backdrop-blur-[2px]">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vermilion opacity-45" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-vermilion/70 bg-paper" />
      </span>
      <span className="text-rule">ml service</span>
      <span className="h-3 w-px bg-rule/40" />
      <span>{message}</span>
      <span className="ml-auto hidden font-mono text-[8px] tracking-[0.14em] text-rule sm:inline">status</span>
    </div>
  );
}
