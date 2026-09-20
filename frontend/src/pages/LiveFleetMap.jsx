// Live AIS fleet map. Plots every port FreightSight tracks plus the latest
// known position of every vessel AISStream has reported nearby recently.
// This is raw observation, not a forecast — same honesty rule as the rest
// of the app: if AIS isn't configured or a window is empty, say so plainly
// instead of showing a misleadingly empty-but-silent map.
import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Radar, RefreshCw, AlertTriangle, Anchor } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Field, Select } from "../components/ui/field.jsx";
import { Button } from "../components/ui/button.jsx";

const STATUS_COLOR = { underway: "#2FBF71", slow: "#E8A33D", stopped: "#D9483C" };
const STATUS_LABEL = { underway: "Underway", slow: "Slow / maneuvering", stopped: "Stopped / anchored" };
const PORT_COLOR = "#FFB020";

function StatBox({ label, value, colorClass }) {
  return (
    <div className="rounded-xl border border-hull-600/60 bg-hull-900/50 p-3">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 font-display text-2xl font-semibold ${colorClass || "text-paper-50"}`}>{value}</div>
    </div>
  );
}

// A common cause of a blank Leaflet map in React is the container having
// size 0 at first measurement (e.g. mid fade-in) — re-measure a beat after
// mount, same fix RouteMap.jsx uses.
function InvalidateOnMount() {
  const map = useMap();
  useEffect(() => {
    const t1 = setTimeout(() => map.invalidateSize(), 100);
    const t2 = setTimeout(() => map.invalidateSize(), 500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [map]);
  return null;
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
            {"Real-time vessel positions from AISStream around the 21 ports FreightSight covers. This is a raw observation feed, not a forecast — dots are colored by current movement, nothing more."}
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

            <div className="h-[520px] w-full overflow-hidden rounded-xl border border-hull-600/60">
              <MapContainer
                center={[10, 90]}
                zoom={3}
                scrollWheelZoom={true}
                className="h-full w-full"
                style={{ background: "#070B12" }}
              >
                <TileLayer
                  className="route-map-dark-tiles"
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  subdomains="abc"
                  maxZoom={19}
                  errorTileUrl="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
                />

                {ports.map((p) => (
                  <CircleMarker
                    key={p.name}
                    center={[p.lat, p.lon]}
                    radius={5}
                    pathOptions={{ color: PORT_COLOR, weight: 1.5, fillColor: PORT_COLOR, fillOpacity: 0.45 }}
                  >
                    <Tooltip direction="top" offset={[0, -6]} opacity={1} className="route-map-tooltip">
                      {p.name} · port
                    </Tooltip>
                  </CircleMarker>
                ))}

                {vessels.map((v) => {
                  const color = STATUS_COLOR[v.status] || "#8892A6";
                  return (
                    <CircleMarker
                      key={v.mmsi}
                      center={[v.lat, v.lon]}
                      radius={5}
                      pathOptions={{ color, weight: 1.5, fillColor: color, fillOpacity: 0.9 }}
                    >
                      <Popup>
                        <div className="min-w-[180px] font-mono text-xs leading-relaxed">
                          <div className="font-semibold">{v.ship_name || "Unnamed vessel"}</div>
                          <div>MMSI {v.mmsi}</div>
                          <div>{STATUS_LABEL[v.status] || v.status} · {v.sog_kn != null ? `${v.sog_kn.toFixed(1)} kn` : "speed unknown"}</div>
                          <div>
                            Near {v.port_near || "open water"}
                            {v.port_distance_nm != null ? ` (${v.port_distance_nm.toFixed(1)} nm)` : ""}
                          </div>
                          {v.destination && <div>Bound for {v.destination}</div>}
                          <div className="mt-1 text-[10px] text-gray-500">
                            {v.received_at ? new Date(v.received_at).toLocaleString() : ""}
                          </div>
                        </div>
                      </Popup>
                    </CircleMarker>
                  );
                })}

                <InvalidateOnMount />
              </MapContainer>
            </div>

            {!error && vessels.length === 0 && (
              <div className="flex items-center gap-2 rounded-xl border border-hull-600/60 bg-hull-900/30 p-6 text-sm text-slate-400">
                <Anchor className="h-4 w-4 shrink-0" />
                {`No AIS vessel activity observed in the last ${lookbackHours}h ${portFilter ? `near ${portFilter}` : "in any tracked port area"}. Try widening the time window.`}
              </div>
            )}

            <div className="flex flex-wrap gap-4 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: PORT_COLOR }} /> Tracked port</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR.underway }} /> Underway (&gt;3 kn)</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR.slow }} /> Slow (0.5–3 kn)</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR.stopped }} /> Stopped (≤0.5 kn)</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
