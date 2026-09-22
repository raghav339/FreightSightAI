import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Database } from "lucide-react";
import useNetworkStatus from "../hooks/useNetworkStatus.js";
import { getCacheSummary } from "../lib/forecastCache.js";

// Same placement/visual language as WakingBanner — deliberately quiet:
// it only renders when the connection is actually degraded, so it never
// competes for attention on a normal, healthy connection.
//
// When fully offline, this also answers "what will actually work right
// now?" — a collapsible panel reading straight from localStorage (see
// forecastCache.js) so nobody wastes time on a page that needs a live
// connection. The cache itself is per-browser, per-device: it's never
// synced to an account or shared with anyone else using the app.
export default function ConnectionBanner() {
  const { t } = useTranslation();
  const { status, effectiveType } = useNetworkStatus();
  const [expanded, setExpanded] = useState(false);
  if (status === "online") return null;

  const offline = status === "offline";
  const message = offline
    ? t("banners.connection.offline")
    : effectiveType
    ? t("banners.connection.slowType", { type: effectiveType })
    : t("banners.connection.slow");

  const summary = offline ? getCacheSummary() : null;

  // No own fixed positioning — see the note in WakingBanner.jsx; App.jsx's
  // StatusBanners stacks both in one fixed column.
  return (
    <div className="pointer-events-auto flex max-w-[min(92vw,760px)] flex-col items-stretch">
      <div className="flex items-center gap-3 border border-rule/55 bg-parchment/96 px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.15em] text-ink shadow-[0_2px_0_rgb(255_255_255_/_0.45)] backdrop-blur-[2px]">
        <span role="status" aria-live="polite" className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-45 ${offline ? "bg-vermilion" : "bg-brass"} ${offline ? "" : "animate-ping"}`} />
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full border bg-paper ${offline ? "border-vermilion/70" : "border-brass/70"}`} />
          </span>
          <span className="text-rule">{t("banners.connection.label")}</span>
          <span className="h-3 w-px bg-rule/40" />
          <span>{message}</span>
        </span>
        {offline && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="ml-auto flex items-center gap-1.5 rounded border border-rule/40 px-2 py-1 text-[8px] tracking-[0.14em] text-ink transition-colors hover:bg-ink/5"
          >
            <Database className="h-2.5 w-2.5" />
            {t("banners.connection.whatsCached")}
            <ChevronDown className={`h-2.5 w-2.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
        {!offline && (
          <span className="ml-auto hidden font-mono text-[8px] tracking-[0.14em] text-rule sm:inline">{t("banners.connection.mode")}</span>
        )}
      </div>

      {offline && expanded && (
        <div className="border border-t-0 border-rule/55 bg-parchment/96 px-4 py-3 font-mono text-[10px] normal-case tracking-normal text-ink shadow-[0_2px_0_rgb(255_255_255_/_0.45)] backdrop-blur-[2px]">
          <CacheDetail summary={summary} t={t} />
        </div>
      )}
    </div>
  );
}

function Row({ ok, children }) {
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-kelp" : "bg-rule/50"}`} />
      <span className={ok ? "text-ink" : "text-rule"}>{children}</span>
    </div>
  );
}

function CacheDetail({ summary, t }) {
  const { meta, vessels, forecasts } = summary;
  const hasAnything = meta.available || vessels.available || forecasts.count > 0;

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-rule">{t("banners.connection.cacheIntro")}</p>

      <div className="flex flex-col gap-1.5">
        <Row ok={meta.available}>
          {meta.available
            ? t("banners.connection.cacheRoutes", { origins: meta.originCount, destinations: meta.destinationCount, commodities: meta.commodityCount })
            : t("banners.connection.cacheRoutesNone")}
        </Row>
        <Row ok={vessels.available}>
          {vessels.available
            ? t("banners.connection.cacheVessels", { count: vessels.count })
            : t("banners.connection.cacheVesselsNone")}
        </Row>
        <Row ok={forecasts.count > 0}>
          {forecasts.count > 0
            ? t("banners.connection.cacheForecasts", { count: forecasts.count })
            : t("banners.connection.cacheForecastsNone")}
        </Row>
      </div>

      {forecasts.lanes.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-rule/30 pt-2">
          {forecasts.lanes.slice(0, 5).map((lane) => (
            <li key={`${lane.origin}|${lane.destination}|${lane.commodity}`} className="flex items-center gap-1.5 text-ink">
              <span className="truncate">{lane.origin} → {lane.destination}</span>
              <span className="text-rule">· {lane.commodity}</span>
            </li>
          ))}
          {forecasts.lanes.length > 5 && (
            <li className="text-rule">{t("banners.connection.cacheLanesMore", { count: forecasts.lanes.length - 5 })}</li>
          )}
        </ul>
      )}

      <p className="border-t border-rule/30 pt-2 text-rule">{t("banners.connection.cacheUnavailable")}</p>
      <p className="text-rule">{t("banners.connection.cacheScope")}</p>

      {!hasAnything && <p className="text-vermilion">{t("banners.connection.cacheEmpty")}</p>}
    </div>
  );
}
