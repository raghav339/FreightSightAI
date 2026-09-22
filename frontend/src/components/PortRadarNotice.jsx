// Slim "live port conditions" strip for the forecast results page.
//
// Checks the loading and discharge port against the Port Disruption Radar.
// Always shows the two statuses (so it is visible the system checked); expands
// into a warning with a route to the What-If panel only when a port is
// ELEVATED or CRITICAL. Silent if the radar is unreachable: this is an
// enhancement to the forecast, never something the forecast depends on.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { useLabels } from "../i18n/labels.js";
import api from "../api/client.js";
import { Button } from "./ui/button.jsx";
import { statusStyle } from "./PortRadarCard.jsx";
import { cn } from "../lib/utils.js";

const ALERT = new Set(["ELEVATED", "CRITICAL"]);

function scrollToWhatIf() {
  document.getElementById("whatif-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export default function PortRadarNotice({ origin, destination }) {
  const { t } = useTranslation();
  const L = useLabels();
  const statusLabel = (status) => t(`radar.status.${status}`, { defaultValue: statusStyle(status).label });
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    const wanted = [
      { role: "loading", port: origin },
      { role: "discharge", port: destination },
    ].filter((e) => e.port);

    Promise.allSettled(
      wanted.map((e) => api.get(`/ais/port-radar/${encodeURIComponent(e.port)}`, { skipWakeBanner: true }))
    ).then((results) => {
      if (cancelled) return;
      setEntries(
        results
          .map((r, i) => (r.status === "fulfilled" ? { ...wanted[i], radar: r.value.data } : null))
          .filter(Boolean)
      );
    });
    return () => {
      cancelled = true;
    };
  }, [origin, destination]);

  if (!entries || entries.length === 0) return null;
  const alerts = entries.filter((e) => ALERT.has(e.radar.status));

  return (
    <section className={cn("border p-4", alerts.length ? "border-vermilion/45 bg-vermilion/5" : "border-rule/60 bg-parchment")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.17em] text-inksoft">
          {alerts.length > 0 && <AlertTriangle className="h-3.5 w-3.5 text-vermilion" />}
          {alerts.length ? t("notice.warningTitle") : t("notice.title")}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.15em]">
          {entries.map((e) => (
            <span key={e.port} className="text-inksoft">
              {L.port(e.port)} <span className={cn("font-semibold", statusStyle(e.radar.status).text)}>{statusLabel(e.radar.status)}</span>
            </span>
          ))}
        </div>
      </div>

      {alerts.map((e) => (
        <p key={e.port} className="mt-3 text-sm leading-relaxed text-ink">
          <Trans
            i18nKey="notice.body"
            values={{
              port: L.port(e.port),
              role: t(`notice.role.${e.role}`),
              status: statusLabel(e.radar.status).toLowerCase(),
              waiting: e.radar.now?.waiting,
              baseline: e.radar.baseline?.waiting,
            }}
            components={{ b: <strong className="font-semibold" /> }}
          />
        </p>
      ))}

      <div className="mt-3 flex flex-wrap gap-3">
        {alerts.length > 0 && (
          <Button type="button" size="sm" onClick={scrollToWhatIf}>{t("notice.runWhatIf")}</Button>
        )}
        <Button as={Link} to={`/port-radar?port=${encodeURIComponent((alerts[0] || entries[0]).port)}`} size="sm" variant="outline">
          {t("notice.openRadar")}
        </Button>
      </div>
    </section>
  );
}
