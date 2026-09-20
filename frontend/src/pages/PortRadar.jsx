// Port Disruption Radar: live AIS congestion status for every tracked port,
// each judged against that port's own normal for the same hours of day.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Loader2, RefreshCw } from "lucide-react";
import api from "../api/client.js";
import { Button } from "../components/ui/button.jsx";
import PortRadarCard, { statusStyle } from "../components/PortRadarCard.jsx";
import { cn } from "../lib/utils.js";

const REFRESH_MS = 2 * 60 * 1000;

export default function PortRadar() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/ais/port-radar");
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || "Could not load the port radar.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const ports = data?.ports || [];
  const selectedName = params.get("port") || ports[0]?.port;
  const selected = useMemo(() => ports.find((p) => p.port === selectedName) || null, [ports, selectedName]);
  const counts = useMemo(() => {
    const c = {};
    ports.forEach((p) => { c[p.status] = (c[p.status] || 0) + 1; });
    return c;
  }, [ports]);

  return (
    <section className="predict-page">
      <div className="predict-shell mx-auto max-w-[1240px] px-5 pb-16 pt-9 lg:px-8 lg:pt-12">
        <header className="predict-heading">
          <div>
            <div className="fs-kicker">Live AIS intelligence</div>
            <h1 className="predict-title">Port disruption radar</h1>
            <p className="predict-intro">
              Is a port abnormally congested right now? Each port is compared with its own normal for the same hours of day, using the
              vessels waiting at anchor, how many are nearby and how fast traffic is moving. Where the evidence is thin, it says so instead of guessing.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={load} disabled={loading} className="shrink-0">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </header>

        {loading && !data && (
          <div className="mt-10 flex items-center gap-3 text-sm text-inksoft"><Loader2 className="h-4 w-4 animate-spin" /> Reading AIS history…</div>
        )}

        {error && (
          <div role="alert" className="mt-8 border border-vermilion/40 bg-vermilion/5 p-4 text-sm text-vermilion">{error}</div>
        )}

        {data && (
          <>
            {!data.feed_active_now && (
              <div className="mt-8 border border-brass/50 bg-brass/5 p-4 text-sm text-ink">
                The AIS feed shows little or no activity in the last {data.window_hours} hours, so current conditions cannot be assessed.
                Ports below are marked "insufficient data" rather than "normal".
              </div>
            )}

            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[10px] uppercase tracking-[0.15em] text-inksoft">
              {["CRITICAL", "ELEVATED", "WATCH", "NORMAL", "INSUFFICIENT_DATA"].map((s) => (
                <span key={s}><span className={cn("font-semibold", statusStyle(s).text)}>{counts[s] || 0}</span> {statusStyle(s).label}</span>
              ))}
              <span>{data.baseline_windows_usable} of {data.baseline_days} baseline days usable</span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {ports.map((p) => {
                const st = statusStyle(p.status);
                const active = p.port === selected?.port;
                return (
                  <button
                    key={p.port}
                    type="button"
                    onClick={() => setParams({ port: p.port })}
                    aria-pressed={active}
                    className={cn(
                      "flex flex-col gap-1 border p-3 text-left transition-colors",
                      active ? "border-ink bg-parchment" : "border-rule/60 bg-paper/40 hover:border-ink/50"
                    )}
                  >
                    <span className="text-sm font-medium text-ink">{p.port}</span>
                    <span className={cn("font-mono text-[10px] uppercase tracking-[0.15em]", st.text)}>{st.label}</span>
                  </button>
                );
              })}
            </div>

            {selected && (
              <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                <PortRadarCard
                  radar={{ ...selected, db_client: data.db_client }}
                  actions={
                    <>
                      <Button as={Link} to="/predict" size="sm">Plot a shipment</Button>
                      <Button as={Link} to="/compare" size="sm" variant="outline">Compare loading origins</Button>
                    </>
                  }
                />
                <aside className="h-fit border border-rule/60 bg-parchment p-5 text-sm leading-relaxed text-inksoft">
                  <div className="fs-kicker">How it works</div>
                  <ul className="mt-3 flex list-disc flex-col gap-2 pl-4">
                    <li>"Now" is the last {data.window_hours} hours of AIS reports within 20 nm of the port.</li>
                    <li>"Normal" is the median of the same hours on each of the last {data.baseline_days} days. Days when the AIS feed was down are left out, so an outage is never read as empty seas.</li>
                    <li>Vessels waiting at anchor count double in the score. Vessels at berth are shown but are not congestion.</li>
                    <li>A port is only judged when at least 3 baseline days and 3 vessels are available.</li>
                    <li>The suggested port-delay allowance is a fixed planning assumption per status, not a measured delay.</li>
                  </ul>
                  <p className="mt-3 text-xs">Source: {data.data_source}. Updated {new Date(data.generated_at).toLocaleTimeString()}.</p>
                </aside>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
