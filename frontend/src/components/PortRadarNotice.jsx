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
import api from "../api/client.js";
import { Button } from "./ui/button.jsx";
import { statusStyle } from "./PortRadarCard.jsx";
import { cn } from "../lib/utils.js";

const ALERT = new Set(["ELEVATED", "CRITICAL"]);

function scrollToWhatIf() {
  document.getElementById("whatif-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export default function PortRadarNotice({ origin, destination }) {
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    const wanted = [
      { role: "loading port", port: origin },
      { role: "discharge port", port: destination },
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
  // Defensive: e.radar can come back missing/null if the port-radar
  // response shape is ever unexpected, and an unguarded e.radar.status
  // would throw during render and (with no error boundary above this)
  // take the whole page down. Filter those entries out instead.
  const usableEntries = entries.filter((e) => e.radar && typeof e.radar.status === "string");
  if (usableEntries.length === 0) return null;
  const alerts = usableEntries.filter((e) => ALERT.has(e.radar.status));

  return (
    <section className={cn("border p-4", alerts.length ? "border-vermilion/45 bg-vermilion/5" : "border-rule/60 bg-parchment")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.17em] text-inksoft">
          {alerts.length > 0 && <AlertTriangle className="h-3.5 w-3.5 text-vermilion" />}
          {alerts.length ? "Route operational warning" : "Live port conditions"}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.15em]">
          {usableEntries.map((e) => (
            <span key={e.port} className="text-inksoft">
              {e.port} <span className={cn("font-semibold", statusStyle(e.radar.status).text)}>{statusStyle(e.radar.status).label}</span>
            </span>
          ))}
        </div>
      </div>

      {alerts.map((e) => (
        <p key={e.port} className="mt-3 text-sm leading-relaxed text-ink">
          <strong className="font-semibold">{e.port}</strong> ({e.role}) shows {statusStyle(e.radar.status).label.toLowerCase()} congestion on live AIS:{" "}
          {e.radar.now?.waiting} vessels waiting at anchor against about {e.radar.baseline?.waiting} normally. Longer turnaround can affect effective
          voyage economics and charter timing; the forecast above does not include port delays.
        </p>
      ))}

      <div className="mt-3 flex flex-wrap gap-3">
        {alerts.length > 0 && (
          <Button type="button" size="sm" onClick={scrollToWhatIf}>Run what-if</Button>
        )}
        <Button as={Link} to={`/port-radar?port=${encodeURIComponent((alerts[0] || usableEntries[0]).port)}`} size="sm" variant="outline">
          Open port radar
        </Button>
      </div>
    </section>
  );
}
