import { useState } from "react";
import { ChevronDown } from "lucide-react";
import useNetworkStatus from "../hooks/useNetworkStatus.js";
import { getOfflineSummary } from "../lib/forecastCache.js";

// Features that have no offline fallback — they always need the live
// backend / ML service, so we say so up front instead of letting people
// fill a form and hit an error.
const LIVE_ONLY = ["COA optimizer", "Compare origins", "Idle vessels", "Live fleet map", "Port radar", "History"];

function cachedSummaryText({ lanes, hasRouteList, hasVesselList }) {
  if (lanes.length === 0 && !hasRouteList && !hasVesselList) return "nothing cached on this device yet";
  const parts = [];
  if (lanes.length > 0) parts.push(`${lanes.length} forecast lane${lanes.length === 1 ? "" : "s"}`);
  if (hasRouteList) parts.push("route list");
  if (hasVesselList) parts.push("vessel list");
  return `cached on this device: ${parts.join(" · ")}`;
}

// Same placement/visual language as WakingBanner — deliberately quiet:
// it only renders when the connection is actually degraded, so it never
// competes for attention on a normal, healthy connection.
export default function ConnectionBanner() {
  const { status, effectiveType } = useNetworkStatus();
  const [open, setOpen] = useState(false);
  if (status === "online") return null;

  const offline = status === "offline";
  const summary = offline ? getOfflineSummary() : null;
  const message = offline
    ? `offline — ${cachedSummaryText(summary)}`
    : `slow connection${effectiveType ? ` (${effectiveType})` : ""} — running in lite mode`;

  // No own fixed positioning — see the note in WakingBanner.jsx; App.jsx's
  // StatusBanners stacks both in one fixed column.
  return (
    <div role="status" aria-live="polite" className="pointer-events-auto flex max-w-[min(92vw,760px)] flex-col border border-rule/55 bg-parchment font-mono text-[9px] uppercase tracking-[0.15em] text-ink shadow-[0_2px_0_rgb(255_255_255_/_0.45)] backdrop-blur-[2px]">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-45 ${offline ? "bg-vermilion" : "bg-brass"} ${offline ? "" : "animate-ping"}`} />
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full border bg-paper ${offline ? "border-vermilion/70" : "border-brass/70"}`} />
        </span>
        <span className="text-rule">connection</span>
        <span className="h-3 w-px bg-rule/40" />
        <span>{message}</span>
        {offline ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-[8px] tracking-[0.14em] text-rule underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            what works offline
            <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        ) : (
          <span className="ml-auto hidden font-mono text-[8px] tracking-[0.14em] text-rule sm:inline">resilience mode</span>
        )}
      </div>

      {offline && open && (
        <div className="flex flex-col gap-2.5 border-t border-rule/40 px-4 py-3 text-[11px] normal-case leading-relaxed tracking-normal text-inksoft">
          <div>
            <div className="font-semibold text-ink">Works offline (Forecast page)</div>
            {summary.lanes.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-0.5">
                {summary.lanes.slice(0, 6).map((l) => (
                  <li key={`${l.origin_port}|${l.destination_port}|${l.commodity}`}>
                    {l.origin_port} → {l.destination_port} · {l.commodity}
                  </li>
                ))}
                {summary.lanes.length > 6 && <li className="opacity-75">+{summary.lanes.length - 6} more cached lane(s)</li>}
              </ul>
            ) : (
              <p className="mt-1">No forecasts are cached yet. Run a forecast once while online to make that lane available offline.</p>
            )}
            <p className="mt-1">Other cargo weights on a cached lane return the closest saved forecast, labelled approximate.</p>
          </div>
          <div>
            <div className="font-semibold text-ink">Needs a live connection</div>
            <p className="mt-1">{LIVE_ONLY.join(", ")}.</p>
          </div>
          <p className="text-[10px] text-rule">Saved in this browser only — it isn’t shared with other users or devices.</p>
        </div>
      )}
    </div>
  );
}
