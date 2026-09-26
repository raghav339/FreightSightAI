// Live AIS fleet map. Plots every port FreightSight tracks plus the latest
// known position of every vessel AISStream has reported nearby recently.
// This is raw observation, not a forecast — same honesty rule as the rest
// of the app: if AIS isn't configured or a window is empty, say so plainly
// instead of showing a misleadingly empty-but-silent map.
import { useEffect, useState } from "react";
import { Radar, RefreshCw, AlertTriangle, Anchor } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Field, Select } from "../components/ui/field.jsx";
import { Button } from "../components/ui/button.jsx";
import FleetMap, { STATUS } from "../components/FleetMap.jsx";

const STATUS_COLOR = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.color]));

function StatBox({ label, value, colorClass }) {
  return (
    <div className="rounded-xl border border-hull-600/60 bg-hull-900/50 p-3">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 font-display text-2xl font-semibold ${colorClass || "text-paper-50"}`}>{value}</div>
    </div>
  );
}

function emptyReason({ status, lookbackHours, portFilter }) {
  const scope = portFilter ? `near ${portFilter}` : "in any tracked port area";
  if (status && !status.api_key_configured) {
    return "Live AIS isn't configured on this deployment (no AISSTREAM_API_KEY on the ML service), so no vessel positions are being collected.";
  }
  if (status && !status.running) {
    return "The AIS collector isn't running on the ML service, so no new vessel positions are being collected.";
  }
  if (status && !status.last_message_at) {
    return "The AIS collector is running but hasn't received any vessel positions yet. It can take a few minutes after the service starts" + (status.last_error ? ` (last error: ${status.last_error}).` : ".");
  }
  return `No AIS vessel positions were reported ${scope} in the last ${lookbackHours}h. Try a longer window${status?.last_message_at ? ` (last AIS message: ${new Date(status.last_message_at).toLocaleString()})` : ""}.`;
}

// Which vessels are currently inside which tracked port's area, built from the
// same positions as the map dots (each vessel is tagged with its nearest port).
function VesselsByPort({ ports, vessels }) {
  const grouped = {};
  for (const v of vessels) {
    const key = v.port_near || "__open__";
    (grouped[key] ||= []).push(v);
  }
  const rows = ports
    .map((p) => ({ name: p.name, list: grouped[p.name] || [] }))
    .sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name));
  const open = grouped.__open__ || [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-lg font-semibold text-paper-50">Vessels by port</h3>
        <span className="text-xs text-slate-500">
          {vessels.length - open.length} near a tracked port{open.length ? ` · ${open.length} in open water` : ""}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ name, list }) => (
          <div key={name} className={`rounded-xl border border-hull-600/60 p-3 ${list.length ? "bg-hull-900/50" : "opacity-60"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-paper-50">{name}</span>
              <span className="font-mono text-sm text-paper-50">{list.length}</span>
            </div>
            {list.length === 0 ? (
              <div className="mt-1 text-xs text-slate-500">No vessels reported</div>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {list.slice(0, 5).map((v) => (
                  <li key={v.mmsi} className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[v.status] || "#8892A6" }} />
                    <span className="truncate">{v.ship_name || `MMSI ${v.mmsi}`}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-500">
                      {v.port_distance_nm != null ? `${v.port_distance_nm.toFixed(1)} nm` : ""}
                    </span>
                  </li>
                ))}
                {list.length > 5 && <li className="text-[11px] text-slate-500">+{list.length - 5} more</li>}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LiveFleetMap() {
  const [ports, setPorts] = useState([]);
  const [status, setStatus] = useState(null);
  const [data, setData] = useState(null);
  const [lookbackHours, setLookbackHours] = useState(6);
  const [portFilter, setPortFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function loadPositions({ silent } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const params = { lookback_hours: lookbackHours };
      if (portFilter) params.port = portFilter;
      const { data } = await api.get("/ais/positions", { params });
      setData(data);
    } catch (err) {
      setError(err.response?.data?.error || "Live AIS positions are unavailable right now.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    api.get("/ais/ports").then(({ data }) => setPorts(data.ports || [])).catch(() => {});
    api.get("/ais/status").then(({ data }) => setStatus(data)).catch(() => {});
  }, []);

  useEffect(() => {
    loadPositions();
    const timer = window.setInterval(() => loadPositions({ silent: true }), 20000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookbackHours, portFilter]);

  const vessels = data?.vessels || [];
  const notConfigured = status && !status.api_key_configured;
  const configuredButQuiet = status && status.api_key_configured && !status.running;

  return (
    <section className="mx-auto max-w-[1240px] px-5 py-10 lg:px-8 lg:py-14">
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-1.5">
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-signal/80">{"Live fleet tracker"}</span>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-paper-50 sm:text-3xl">
            {"Vessels near tracked ports, live from AIS"}
          </h1>
          <p className="max-w-2xl text-sm text-slate-400">
            {"Real-time vessel positions from AISStream around the 21 ports FreightSight covers. This is a raw observation feed, not a forecast — each vessel points along its heading and is colored by current movement, nothing more."}
          </p>
        </header>

        {notConfigured && (
          <div className="flex items-start gap-2 rounded-lg border border-brass/30 bg-brass/10 px-4 py-3 text-sm text-brass">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              {"Live AIS tracking isn't configured on this deployment (no AISSTREAM_API_KEY set on the ML service). Every port FreightSight tracks is still shown below — vessel positions will start appearing automatically once a key is configured, no other changes needed."}
            </div>
          </div>
        )}
        {!notConfigured && configuredButQuiet && (
          <div className="flex items-start gap-2 rounded-lg border border-brass/30 bg-brass/10 px-4 py-3 text-sm text-brass">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>{"The AIS collector isn't currently running on the ML service, so positions may be stale or empty."}</div>
          </div>
        )}

        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
                <Radar className="h-[18px] w-[18px]" />
              </span>
              <div>
                <CardTitle className="text-lg">Fleet map</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  {data?.generated_at ? `Last updated ${new Date(data.generated_at).toLocaleTimeString()}` : "—"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Port">
                <Select value={portFilter} onChange={(e) => setPortFilter(e.target.value)}>
                  <option value="">All tracked ports</option>
                  {ports.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Window">
                <Select value={lookbackHours} onChange={(e) => setLookbackHours(Number(e.target.value))}>
                  <option value={1}>Last 1h</option>
                  <option value={6}>Last 6h</option>
                  <option value={24}>Last 24h</option>
                  <option value={48}>Last 48h</option>
                </Select>
              </Field>
              <Button type="button" variant="outline" onClick={() => loadPositions()} disabled={loading}>
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-2">
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-vermilion/30 bg-vermilion/10 px-4 py-3 text-sm text-vermilion">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatBox label="Vessels shown" value={vessels.length} />
              <StatBox label="Ports tracked" value={ports.length} />
              <StatBox label="Underway" value={vessels.filter((v) => v.status === "underway").length} colorClass="text-kelp" />
              <StatBox label="Stopped" value={vessels.filter((v) => v.status === "stopped").length} colorClass="text-vermilion" />
            </div>

            <FleetMap ports={ports} vessels={vessels} portFilter={portFilter} generatedAt={data?.generated_at} loading={loading} />

            {!error && vessels.length === 0 && (
              <div className="flex items-center gap-2 rounded-xl border border-hull-600/60 bg-hull-900/30 p-6 text-sm text-slate-400">
                <Anchor className="h-4 w-4 shrink-0" />
                {emptyReason({ status, lookbackHours, portFilter })}
              </div>
            )}

            {ports.length > 0 && <VesselsByPort ports={ports} vessels={vessels} />}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
