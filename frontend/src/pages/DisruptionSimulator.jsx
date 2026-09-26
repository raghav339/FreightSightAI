// Disruption Intelligence — Simulate mode.
//
// "An external disruption becomes a procurement decision": pick an event
// type, a port, and a severity, and see it propagate through port
// productivity, loading delay, vessel waiting and freight pressure, then
// (for a discharge port) a wait-it-out-vs-alternative-port comparison
// reusing the Port Substitution Engine.
//
// Every number here comes from POST /disruption/simulate
// (ml-service/app/disruption_engine.py + app/utils.py::simulate_disruption).
// This page renders that response; it does not compute anything itself
// beyond simple display formatting. Results are always clearly labelled
// "Simulated scenario" or "Live conditions" (app/disruption_engine.py's
// `source` field) — Live mode fetches current marine conditions
// (wind/wave/precipitation) for the port and derives severity from those
// (POST /disruption/live) rather than letting the user set it by hand; see
// ml-service/app/marine_weather.py for the scoring and its limits.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info, Loader2, Radio, TestTube2, Wind } from "lucide-react";
import api from "../api/client.js";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent } from "../components/ui/card.jsx";
import { Field, Input, Select } from "../components/ui/field.jsx";
import PropagationChain from "../components/PropagationChain.jsx";
import SubstitutionMap from "../components/SubstitutionMap.jsx";
import DisruptionBriefButton from "../components/DisruptionBriefButton.jsx";
import { cn } from "../lib/utils.js";

const EMPTY_FORM = {
  event_type: "",
  port: "",
  severity: 50,
  duration_days: "",
  stockpile_buffer_days: "",
  origin_port: "",
  destination_port: "",
  commodity: "",
  shipment_date: "",
  cargo_weight_tons: "50000",
};

function severityWord(v) {
  if (v < 30) return "Low";
  if (v < 60) return "Moderate";
  if (v < 85) return "High";
  return "Severe";
}

const fmt = (v, d = 1, unit = "") => (v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : `${Number(v).toFixed(d)}${unit}`);
const signed = (v, d = 2, unit = "") => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}${unit}`);

// $1.04M / $207K / $850 — same compact style used in the Decision Brief PDF,
// for the "$ saved / $ at risk" rollup below.
function usdCompact(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `$${Math.round(a / 1e3).toLocaleString("en-US")}K`;
  return `$${Math.round(a)}`;
}

function DollarRollup({ wait, alternative }) {
  const waitUsd = wait?.freight_impact_usd;
  const altUsd = alternative?.freight_impact_usd;

  // Both priced: the single number is what diverting is worth (or costs)
  // versus waiting it out, on this cargo's freight rate alone.
  if (waitUsd != null && altUsd != null) {
    const diff = waitUsd - altUsd; // > 0 means diverting is cheaper
    const compact = usdCompact(diff);
    if (!compact || Math.abs(diff) < 1) return null;
    return (
      <div className={cn("mb-4 flex items-center gap-2 border px-4 py-3", diff >= 0 ? "border-kelp/40 bg-kelp/5" : "border-vermilion/40 bg-vermilion/5")}>
        <span className={cn("font-display text-xl font-semibold tabular-nums", diff >= 0 ? "text-kelp" : "text-vermilion")}>{compact}</span>
        <span className="text-sm text-inksoft">
          {diff >= 0 ? "saved on freight by diverting, versus waiting it out" : "cheaper on freight by waiting it out, versus diverting"}
        </span>
      </div>
    );
  }

  // No alternative (or it isn't priced) — the number is exposure on this
  // cargo if the plan stays as-is and the disruption's freight pressure holds.
  if (waitUsd != null && Math.abs(waitUsd) >= 1) {
    const compact = usdCompact(waitUsd);
    return (
      <div className="mb-4 flex items-center gap-2 border border-brass/40 bg-brass/5 px-4 py-3">
        <span className="font-display text-xl font-semibold tabular-nums text-brass">{compact}</span>
        <span className="text-sm text-inksoft">at risk on freight if this disruption holds and the plan doesn't change</span>
      </div>
    );
  }
  return null;
}

function DecisionCompare({ decision, port }) {
  if (!decision) return null;
  const { wait, alternative } = decision;
  return (
    <>
      <DollarRollup wait={wait} alternative={alternative} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="border border-vermilion/40 bg-vermilion/5 p-4">
          <div className="fs-kicker text-vermilion">Wait it out</div>
          <div className="mt-1 font-display text-lg font-semibold text-ink">{wait.port}</div>
          <div className="mt-3 flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between"><span className="text-inksoft">Expected delay</span><span className="tabular-nums text-ink">+{fmt(wait.expected_delay_days, 1, " d")}</span></div>
            <div className="flex justify-between"><span className="text-inksoft">Freight vs. baseline</span><span className="tabular-nums text-ink">{wait.freight_delta_usd_per_ton == null ? "—" : signed(wait.freight_delta_usd_per_ton, 2, "/t")}</span></div>
            {wait.freight_impact_usd != null && (
              <div className="flex justify-between"><span className="text-inksoft">On this cargo</span><span className="tabular-nums text-ink">{signed(wait.freight_impact_usd, 0, " USD")}</span></div>
            )}
          </div>
        </div>
        <div className={cn("border p-4", alternative ? "border-kelp/40 bg-kelp/5" : "border-rule/60 bg-paper/40")}>
          <div className={cn("fs-kicker", alternative ? "text-kelp" : "text-inksoft")}>Alternative port</div>
          {alternative ? (
            <>
              <div className="mt-1 font-display text-lg font-semibold text-ink">{alternative.port}</div>
              <div className="mt-3 flex flex-col gap-1.5 text-sm">
                <div className="flex justify-between"><span className="text-inksoft">Expected delay</span><span className="tabular-nums text-ink">+{fmt(alternative.expected_delay_days, 1, " d")}</span></div>
                <div className="flex justify-between"><span className="text-inksoft">Freight vs. baseline</span><span className="tabular-nums text-ink">{alternative.freight_delta_usd_per_ton == null ? "—" : signed(alternative.freight_delta_usd_per_ton, 2, "/t")}</span></div>
                {alternative.freight_impact_usd != null && (
                  <div className="flex justify-between"><span className="text-inksoft">On this cargo</span><span className="tabular-nums text-ink">{signed(alternative.freight_impact_usd, 0, " USD")}</span></div>
                )}
                <div className="flex justify-between"><span className="text-inksoft">From {port}</span><span className="tabular-nums text-ink">{fmt(alternative.distance_from_disrupted_port_nm, 0, " nm")}</span></div>
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-inksoft">No vessel-feasible alternative found for this cargo.</p>
          )}
        </div>
      </div>
    </>
  );
}

export default function DisruptionSimulator() {
  const [meta, setMeta] = useState({ commodities: [], origins: [], destinations: [] });
  const [eventTypes, setEventTypes] = useState([]);
  const [mode, setMode] = useState("simulate"); // "simulate" | "live"
  const [form, setForm] = useState(EMPTY_FORM);
  const [laneOpen, setLaneOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [briefPayload, setBriefPayload] = useState(null);

  useEffect(() => {
    api.get("/routes").then(({ data: d }) => setMeta(d)).catch(() => {});
    api.get("/disruption/event-types").then(({ data: d }) => setEventTypes(d.event_types || [])).catch(() => {});
  }, []);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const ports = [
    ...(meta.destinations || []).map((p) => ({ name: p, role: "discharge" })),
    ...(meta.origins || []).map((p) => ({ name: p, role: "loading" })),
  ];

  async function handleSubmit(e) {
    e.preventDefault();
    if (mode === "simulate" && (!form.event_type || !form.port)) {
      setError("Pick an event type and a port.");
      return;
    }
    if (mode === "live" && !form.port) {
      setError("Pick a port.");
      return;
    }
    setError(null);
    setLoading(true);
    setData(null);
    setBriefPayload(null);
    try {
      const shared = {
        port: form.port,
        duration_days: form.duration_days ? Number(form.duration_days) : undefined,
        stockpile_buffer_days: form.stockpile_buffer_days ? Number(form.stockpile_buffer_days) : undefined,
        origin_port: form.origin_port || undefined,
        destination_port: form.destination_port || undefined,
        commodity: form.commodity || undefined,
        shipment_date: form.shipment_date || undefined,
        cargo_weight_tons: form.cargo_weight_tons ? Number(form.cargo_weight_tons) : undefined,
      };
      // Same shape the results were just computed from — reused verbatim so
      // the Decision Brief PDF can never drift from what's on screen.
      const forBrief = mode === "live"
        ? { ...shared, mode: "live" }
        : { ...shared, mode: "simulate", event_type: form.event_type, severity: Number(form.severity) };
      const { data: res } = mode === "live"
        ? await api.post("/disruption/live", shared)
        : await api.post("/disruption/simulate", { ...shared, event_type: form.event_type, severity: Number(form.severity) });
      setData(res);
      setBriefPayload(forBrief);
    } catch (err) {
      setError(err.response?.data?.error || (mode === "live"
        ? "Could not fetch live conditions for this port. Try again shortly, or use Simulate mode."
        : "Could not simulate this disruption."));
    } finally {
      setLoading(false);
    }
  }

  const d = data?.disruption;
  const lane = data?.lane;
  const alt = data?.alternatives;
  const bestAlt = alt?.options?.find((o) => o.feasible) || null;

  return (
    <section className="mx-auto max-w-[1240px] px-5 py-10 lg:px-8">
      <div className="fs-kicker">Disruption intelligence</div>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-[-0.02em] text-ink">
        If this happens, what should we do?
      </h1>
      <p className="mt-2 max-w-3xl text-sm text-inksoft">
        Simulate an event at a port — a cyclone, a closure, a vessel shortage — and see how it propagates through port
        productivity, loading delay, vessel waiting and freight rates, then compare waiting it out against the best
        alternative port. Every result below is computed from the event type, severity and this port's own data — nothing
        is a pre-set answer for a named scenario.
      </p>

      <Card className="mt-6">
        <CardContent className="pt-5">
          <div className="mb-5 inline-flex border border-rule/60">
            <button
              type="button"
              onClick={() => { setMode("simulate"); setData(null); setError(null); }}
              className={cn("flex items-center gap-1.5 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.15em]", mode === "simulate" ? "bg-ink text-paper" : "text-inksoft hover:text-ink")}
            >
              <TestTube2 className="h-3.5 w-3.5" /> Simulate
            </button>
            <button
              type="button"
              onClick={() => { setMode("live"); setData(null); setError(null); }}
              className={cn("flex items-center gap-1.5 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.15em]", mode === "live" ? "bg-ink text-paper" : "text-inksoft hover:text-ink")}
            >
              <Radio className="h-3.5 w-3.5" /> Live
            </button>
          </div>
          {mode === "live" && (
            <p className="mb-5 flex items-start gap-1.5 text-xs text-inksoft">
              <Wind className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Severity is derived from current wind, wave and precipitation conditions at the port
              (<a href="https://www.weatherapi.com" target="_blank" rel="noreferrer" className="underline">WeatherAPI.com</a>),
              not chosen by hand. If live conditions can't be fetched, this will say so rather than guess.
            </p>
          )}
          <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
            <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", mode === "simulate" ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
              {mode === "simulate" && (
                <Field label="Event type">
                  <Select value={form.event_type} onChange={(e) => update("event_type", e.target.value)} required>
                    <option value="" disabled>Choose an event type</option>
                    {eventTypes.map((e) => <option key={e.event_type} value={e.event_type}>{e.label}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Affected port">
                <Select value={form.port} onChange={(e) => update("port", e.target.value)} required>
                  <option value="" disabled>Choose a port</option>
                  {ports.map((p) => <option key={`${p.role}-${p.name}`} value={p.name}>{p.name} ({p.role})</option>)}
                </Select>
              </Field>
              <Field label="Duration" hint="days, optional">
                <Input type="number" min="1" placeholder="1" value={form.duration_days} onChange={(e) => update("duration_days", e.target.value)} />
              </Field>
              <Field label="Stockpile buffer" hint="days, optional">
                <Input type="number" min="0" placeholder="none" value={form.stockpile_buffer_days} onChange={(e) => update("stockpile_buffer_days", e.target.value)} />
              </Field>
            </div>

            {mode === "simulate" && (
              <Field label="Severity" hint={`${form.severity}/100 · ${severityWord(form.severity)}`}>
                <input
                  type="range" min="0" max="100" step="1" value={form.severity}
                  onChange={(e) => update("severity", e.target.value)}
                  className="h-1.5 w-full cursor-pointer appearance-none bg-rule/50 accent-vermilion"
                />
              </Field>
            )}

            <button
              type="button"
              onClick={() => setLaneOpen((o) => !o)}
              className="flex items-center gap-1.5 self-start font-mono text-[10px] uppercase tracking-[0.15em] text-inksoft hover:text-ink"
            >
              {laneOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              Lane details (optional — adds freight-rate impact)
            </button>
            {laneOpen && (
              <div className="grid grid-cols-1 gap-4 border-t border-rule/40 pt-4 sm:grid-cols-2 lg:grid-cols-5">
                <Field label="Loading port" hint="optional">
                  <Select value={form.origin_port} onChange={(e) => update("origin_port", e.target.value)}>
                    <option value="">Not specified</option>
                    {(meta.origins || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                </Field>
                <Field label="Discharge port" hint="optional">
                  <Select value={form.destination_port} onChange={(e) => update("destination_port", e.target.value)}>
                    <option value="">Not specified</option>
                    {(meta.destinations || []).map((dst) => <option key={dst} value={dst}>{dst}</option>)}
                  </Select>
                </Field>
                <Field label="Commodity" hint="optional">
                  <Select value={form.commodity} onChange={(e) => update("commodity", e.target.value)}>
                    <option value="">Not specified</option>
                    {(meta.commodities || []).map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </Field>
                <Field label="Shipment date" hint="optional">
                  <Input type="date" value={form.shipment_date} onChange={(e) => update("shipment_date", e.target.value)} />
                </Field>
                <Field label="Cargo (tonnes)">
                  <Input type="number" min="1" value={form.cargo_weight_tons} onChange={(e) => update("cargo_weight_tons", e.target.value)} />
                </Field>
              </div>
            )}

            <div><Button type="submit" disabled={loading}>{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {mode === "live" ? "Assess live conditions" : "Simulate disruption"}</Button></div>
          </form>
        </CardContent>
      </Card>

      {error && <div role="alert" className="mt-6 border border-vermilion/40 bg-vermilion/5 p-3 text-sm text-vermilion">{error}</div>}
      {loading && !data && <div className="mt-6 flex items-center gap-3 text-sm text-inksoft"><Loader2 className="h-4 w-4 animate-spin" /> {mode === "live" ? "Fetching live marine conditions…" : "Propagating the disruption…"}</div>}

      {data && (
        <div className="mt-8 flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              {d.source === "live" ? (
                <>
                  <Badge variant="low" dot={false}><Radio className="h-3 w-3" /> Live conditions</Badge>
                  <span className="text-sm text-inksoft">Derived from current marine conditions at {data.port}, not chosen by hand.</span>
                </>
              ) : (
                <>
                  <Badge variant="high" dot={false}><TestTube2 className="h-3 w-3" /> Simulated scenario</Badge>
                  <span className="text-sm text-inksoft">Not a live event — a planning simulation for {data.port}.</span>
                </>
              )}
            </div>
            <DisruptionBriefButton payload={briefPayload} />
          </div>

          {data.live_conditions && (
            <Card>
              <CardContent className="pt-5">
                <div className="fs-kicker">Live marine conditions · {data.port}</div>
                <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div><div className="font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">Wind</div><div className="mt-0.5 text-lg tabular-nums text-ink">{fmt(data.live_conditions.conditions.wind_speed_kmh, 0, " km/h")}</div></div>
                  <div><div className="font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">Wave height</div><div className="mt-0.5 text-lg tabular-nums text-ink">{fmt(data.live_conditions.conditions.wave_height_m, 1, " m")}</div></div>
                  <div><div className="font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">Precipitation</div><div className="mt-0.5 text-lg tabular-nums text-ink">{fmt(data.live_conditions.conditions.precipitation_mm_h, 1, " mm/h")}</div></div>
                  <div><div className="font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">Visibility</div><div className="mt-0.5 text-lg tabular-nums text-ink">{fmt(data.live_conditions.conditions.visibility_km, 1, " km")}</div></div>
                </div>
                <p className="mt-3 text-xs text-inksoft">
                  Data coverage {Math.round((data.live_conditions.coverage || 0) * 100)}% ·
                  severity derived against reference points (storm-force wind, very-rough sea, violent rain, good visibility) — see the assumptions below.
                </p>
                {data.live_conditions.conditions.status !== "ok" && data.live_conditions.conditions.error && (
                  <p className="mt-1.5 text-xs text-vermilion">
                    Some readings unavailable: {data.live_conditions.conditions.error}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <Card>
              <CardContent className="pt-5">
                <div className="fs-kicker">Propagation</div>
                <h3 className="mt-1 font-display text-2xl font-semibold tracking-[-0.02em] text-ink">{d.event_label}</h3>
                <PropagationChain steps={d.propagation} eventType={d.event_type} className="mt-5" />
              </CardContent>
            </Card>

            <div className="flex flex-col gap-6">
              {lane && (
                <Card>
                  <CardContent className="pt-5">
                    <div className="fs-kicker">Freight impact</div>
                    <h3 className="mt-1 font-display text-xl font-semibold text-ink">{lane.origin_port} → {lane.destination_port}</h3>
                    <p className="text-xs text-inksoft">{lane.commodity}</p>
                    <div className="mt-4 grid grid-cols-2 gap-4">
                      <div><div className="font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">Baseline</div><div className="mt-0.5 text-lg tabular-nums text-ink">${fmt(lane.baseline_rate_usd_per_ton, 2)}/t</div></div>
                      <div><div className="font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">With disruption</div><div className="mt-0.5 text-lg tabular-nums text-vermilion">${fmt(lane.adjusted_rate_usd_per_ton, 2)}/t</div></div>
                    </div>
                    <p className="mt-3 text-sm text-inksoft">
                      {signed(lane.delta_usd_per_ton, 2, "/t")} · {signed(lane.total_impact_usd, 0, " USD")} total on this parcel.
                    </p>
                    <p className="mt-2 text-xs text-inksoft">{lane.note}</p>
                  </CardContent>
                </Card>
              )}

              {data.decision && (
                <Card>
                  <CardContent className="pt-5">
                    <div className="fs-kicker">Wait vs. divert</div>
                    <DecisionCompare decision={data.decision} port={data.port} />
                  </CardContent>
                </Card>
              )}

              {data.notes?.length > 0 && (
                <div className="flex flex-col gap-2 border border-brass/40 bg-brass/5 p-4 text-sm text-ink">
                  {data.notes.map((n) => (
                    <div key={n} className="flex items-start gap-2"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brass" />{n}</div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {alt && (
            <Card>
              <CardContent className="pt-5">
                <div className="fs-kicker">Alternative discharge ports</div>
                <h3 className="mt-1 font-display text-xl font-semibold text-ink">{alt.recommendation}</h3>
                <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <SubstitutionMap map={alt.map} />
                  <div className="flex flex-col gap-2">
                    {alt.options.filter((o) => o.feasible).slice(0, 3).map((o) => (
                      <div key={o.port} className={cn("flex items-center justify-between border p-3 text-sm", o.port === bestAlt?.port ? "border-kelp/50 bg-kelp/5" : "border-rule/50 bg-paper/40")}>
                        <span className="font-medium text-ink">{o.rank}. {o.port}</span>
                        <span className="text-inksoft">{fmt(o.delay.total_days, 1, "d")} · {o.freight.delta_usd_per_ton == null ? "—" : signed(o.freight.delta_usd_per_ton, 2, "/t")}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-4">
                  <Button as={Link} to={`/port-radar?port=${encodeURIComponent(data.port)}`} size="sm" variant="outline">Full substitution analysis</Button>
                </div>
              </CardContent>
            </Card>
          )}

          <details className="border border-rule/60 bg-paper/40 p-4 text-xs text-inksoft">
            <summary className="flex cursor-pointer items-center gap-1.5"><Info className="h-3.5 w-3.5" /> What this simulation does and does not account for</summary>
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5">
              {d.assumptions.map((a) => <li key={a}>{a}</li>)}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}