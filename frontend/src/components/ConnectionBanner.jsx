import useNetworkStatus from "../hooks/useNetworkStatus.js";

// Same placement/visual language as WakingBanner — deliberately quiet:
// it only renders when the connection is actually degraded, so it never
// competes for attention on a normal, healthy connection.
export default function ConnectionBanner() {
  const { status, effectiveType } = useNetworkStatus();
  if (status === "online") return null;

  const offline = status === "offline";
  const message = offline
    ? "offline — showing cached forecasts where available"
    : `slow connection${effectiveType ? ` (${effectiveType})` : ""} — running in lite mode`;

  // No own fixed positioning — see the note in WakingBanner.jsx; App.jsx's
  // StatusBanners stacks both in one fixed column.
  return (
    <div role="status" aria-live="polite" className="pointer-events-auto flex max-w-[min(92vw,760px)] items-center gap-3 border border-rule/55 bg-parchment/96 px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.15em] text-ink shadow-[0_2px_0_rgb(255_255_255_/_0.45)] backdrop-blur-[2px]">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className={`absolute inline-flex h-full w-full rounded-full opacity-45 ${offline ? "bg-vermilion" : "bg-brass"} ${offline ? "" : "animate-ping"}`} />
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full border bg-paper ${offline ? "border-vermilion/70" : "border-brass/70"}`} />
      </span>
      <span className="text-rule">connection</span>
      <span className="h-3 w-px bg-rule/40" />
      <span>{message}</span>
      <span className="ml-auto hidden font-mono text-[8px] tracking-[0.14em] text-rule sm:inline">resilience mode</span>
    </div>
  );
}
