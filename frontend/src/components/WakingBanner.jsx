// frontend/src/components/WakingBanner.jsx
// Listens to the mlWakeup bus (see api/client.js + api/mlWakeup.js) and
// shows a small non-blocking banner while a request is probably waiting
// on a Render free-tier cold start, instead of leaving the user staring
// at an unresponsive form with no explanation.
import { useEffect, useState } from "react";
import { subscribeMlWakeup } from "../api/mlWakeup.js";

export default function WakingBanner() {
  const [state, setState] = useState({ active: false, phase: null });

  useEffect(() => subscribeMlWakeup(setState), []);

  if (!state.active) return null;

  const message =
    state.phase === "retrying"
      ? "Still waking up — retrying automatically…"
      : state.phase === "comparing"
      ? "Comparing every loading port with live vessel data — this can take up to 20 seconds…"
      : "Waking up the forecasting service — this can take up to a minute on a cold instance…";

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-amber/30 bg-hull-800/95 px-4 py-2 text-xs font-mono uppercase tracking-wide text-amber shadow-lg shadow-black/30 backdrop-blur">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-amber" />
        </span>
        {message}
      </div>
    </div>
  );
}
