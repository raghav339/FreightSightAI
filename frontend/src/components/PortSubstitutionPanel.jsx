// Port Substitution Engine panel: "If <port> becomes unavailable, where should
// we go?" Ranks every other discharge port on vessel fit, draft/LOA, cargo
// capacity, congestion, distance, freight impact, delay and handling, and shows
// the result as a substitution map plus a ranked list. The rules and their
// limits live in ml-service/app/port_substitution.py.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import api from "../api/client.js";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import { Card, CardContent } from "./ui/card.jsx";
import { Field, Input, Select } from "./ui/field.jsx";
import SubstitutionMap from "./SubstitutionMap.jsx";
import { cn } from "../lib/utils.js";

const VERDICT = {
  PRIMARY: { label: "Primary", badge: "low" },
  BACKUP: { label: "Backup", badge: "medium" },
  VIABLE: { label: "Viable", badge: "neutral" },
  NOT_VIABLE: { label: "Not viable", badge: "high" },
};

const CRITERIA = [
  ["freight", "Freight"], ["delay", "Time"], ["congestion", "Congestion"],
  ["proximity", "Closeness"], ["handling", "Handling"], ["vessel_margin", "Vessel fit"],
];

const fmt = (v, d = 1, unit = "") => (v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : `${Number(v).toFixed(d)}${unit}`);
const signed = (v, d = 2, unit = "") => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}${unit}`);

// $1.04M / $207K / $850 — compact total for the "$ saved / $ at risk" stat.
function usdCompact(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `$${Math.round(a / 1e3).toLocaleString("en-US")}K`;
  return `$${Math.round(a)}`;
}

function Metric({ label, children, tone }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-inksoft">{label}</span>
      <span className={cn("text-sm tabular-nums text-ink", tone)}>{children}</span>
    </div>
  );
}

function OptionCard({ o, active, onSelect }) {
  const v = VERDICT[o.verdict] || VERDICT.VIABLE;
  const fr = o.freight || {};
  const delay = o.delay || {};
  const cong = o.congestion || {};
  return (
    <div
      onClick={() => onSelect(o.port)}
      className={cn("cursor-pointer border p-4 transition-colors", active ? "border-ink bg-parchment" : "border-rule/60 bg-paper/40 hover:border-ink/50")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-display text-lg font-semibold text-ink">{o.rank ? `${o.rank}. ` : ""}{o.port}</span>
          <Badge variant={v.badge}>{v.label}</Badge>
        </div>
        <div className="flex items-center gap-3">
          {fr.total_impact_usd != null && Math.abs(fr.total_impact_usd) >= 1 && (
            <span className={cn("font-mono text-xs font-semibold tabular-nums", fr.total_impact_usd > 0 ? "text-vermilion" : "text-kelp")}>
              {fr.total_impact_usd > 0 ? "+" : "−"}{usdCompact(fr.total_impact_usd)} on this cargo
            </span>
          )}
          {o.score != null && <span className="font-mono text-xs text-inksoft">score <span className="font-semibold text-ink">{o.score}</span>/100</span>}
        </div>
      </div>

      {o.feasible ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Metric label="Vessel">{o.vessel.class}{!o.vessel.keeps_planned_vessel && o.vessel.planned_vessel ? " (changed)" : ""}</Metric>
            <Metric label="Freight vs original" tone={fr.delta_usd_per_ton > 0 ? "text-vermilion" : fr.delta_usd_per_ton < 0 ? "text-kelp" : ""}>
              {fr.delta_usd_per_ton == null ? "—" : `${signed(fr.delta_usd_per_ton, 2, "/t")}`}
            </Metric>
            <Metric label="Expected delay">{fmt(delay.total_days, 1, " d")}</Metric>
            <Metric label="From failed port">{fmt(o.distance.from_failed_nm, 0, " nm")}</Metric>
            <Metric label="Draft headroom">{fmt(o.vessel.draft_margin_m, 1, " m")}</Metric>
            <Metric label="LOA headroom">{fmt(o.vessel.loa_margin_m, 0, " m")}</Metric>
            <Metric label="Congestion">{cong.level}{cong.source === "live_ais_radar" ? " · live" : ""}</Metric>
            <Metric label="Discharge">{fmt(o.handling.discharge_days, 1, " d")}{o.handling.berths ? ` · ${o.handling.berths} berths` : ""}</Metric>
          </div>
          {active && (
            <div className="mt-4 flex flex-col gap-3 border-t border-rule/40 pt-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {CRITERIA.map(([k, label]) => (
                  <div key={k}>
                    <div className="flex justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-inksoft">
                      <span>{label}</span><span>{Math.round((o.score_breakdown?.[k] ?? 0) * 100)}</span>
                    </div>
                    <div className="mt-1 h-1 bg-rule/30"><div className="h-1 bg-ink/70" style={{ width: `${Math.round((o.score_breakdown?.[k] ?? 0) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
              {o.why?.length > 0 && <p className="text-xs text-inksoft">{o.why.join(" ")}</p>}
              <p className="text-xs text-inksoft">
                Delay = {fmt(Math.max(delay.extra_transit_days ?? 0, 0), 1)} d extra sailing + {fmt(Math.max(delay.extra_handling_days ?? 0, 0), 1)} d extra handling
                + {fmt(delay.congestion_days, 1)} d congestion allowance ({cong.source === "live_ais_radar" ? "live AIS status" : "static rating, planning assumption"}).
                {fr.total_impact_usd != null && <> Freight impact on this parcel: {signed(fr.total_impact_usd, 0, " USD")}.</>}
              </p>
              {o.data_gaps?.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-brass"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{o.data_gaps.join(" ")} Data coverage {Math.round((o.coverage ?? 0) * 100)}%.</p>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-inksoft"><XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion" />{o.vessel.rejection_reason}</p>
      )}
    </div>
  );
}

export default function PortSubstitutionPanel({ port }) {
  const [meta, setMeta] = useState({ commodities: [], origins: [] });
  const [metaReady, setMetaReady] = useState(false);
  const [form, setForm] = useState({ cargo_weight_tons: "50000", commodity: "", origin_port: "", shipment_date: "" });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api.get("/routes").then(({ data: d }) => setMeta(d)).catch(() => {}).finally(() => setMetaReady(true));
  }, []);

  // `run` is only re-created when the port changes, so it reads the latest
  // form values through a ref instead of a stale closure.
  const formRef = useRef(form);
  formRef.current = form;

  const run = useCallback(async () => {
    if (!port) return;
    const f = formRef.current;
    setLoading(true);
    setError(null);
    try {
      const { data: res } = await api.post("/port-substitution", {
        failed_port: port,
        cargo_weight_tons: f.cargo_weight_tons ? Number(f.cargo_weight_tons) : undefined,
        commodity: f.commodity || undefined,
        origin_port: f.origin_port || undefined,
        shipment_date: f.shipment_date || undefined,
      });
      setData(res);
      setSelected(res.options.find((o) => o.feasible)?.port || null);
    } catch (err) {
      setData(null);
      setError(err.response?.data?.error || "Could not compute substitutions for this port.");
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  // Re-run automatically when a different port is picked (form values are
  // applied via the button, so typing never fires a request per keystroke).
  const isOrigin = (meta.origins || []).includes(port);
  useEffect(() => { if (metaReady && !isOrigin) run(); }, [run, metaReady, isOrigin]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const viable = (data?.options || []).filter((o) => o.feasible);
  const rejected = (data?.options || []).filter((o) => !o.feasible);
  if (isOrigin) return null;

  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col gap-5 pt-5">
        <div>
          <div className="fs-kicker">Port substitution engine</div>
          <h3 className="mt-1 font-display text-2xl font-semibold tracking-[-0.02em] text-ink">If {port} becomes unavailable, where should we go?</h3>
          <p className="mt-1 max-w-3xl text-xs text-inksoft">
            Every other discharge port is checked for vessel fit (draft, length, beam), cargo capacity and cargo handling, then ranked on freight impact,
            expected delay, congestion and distance from {port}. Add the loading port and commodity to include freight-rate impact.
          </p>
        </div>

        <form className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <Field label="Cargo (tonnes)"><Input type="number" min="1" value={form.cargo_weight_tons} onChange={(e) => update("cargo_weight_tons", e.target.value)} /></Field>
          <Field label="Commodity" hint="optional">
            <Select value={form.commodity} onChange={(e) => update("commodity", e.target.value)}>
              <option value="">Any</option>
              {(meta.commodities || []).map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Loading port" hint="optional">
            <Select value={form.origin_port} onChange={(e) => update("origin_port", e.target.value)}>
              <option value="">Not specified</option>
              {(meta.origins || []).map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          </Field>
          <Field label="Shipment date" hint="optional"><Input type="date" value={form.shipment_date} onChange={(e) => update("shipment_date", e.target.value)} /></Field>
          <div className="flex items-end"><Button type="submit" disabled={loading} className="w-full">{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Find substitutes</Button></div>
        </form>

        {error && <div role="alert" className="border border-vermilion/40 bg-vermilion/5 p-3 text-sm text-vermilion">{error}</div>}
        {loading && !data && <div className="flex items-center gap-3 text-sm text-inksoft"><Loader2 className="h-4 w-4 animate-spin" /> Evaluating alternative ports…</div>}

        {data && (
          <>
            <div className={cn("flex items-start gap-3 border p-4 text-sm", viable.length ? "border-kelp/40 bg-kelp/5" : "border-vermilion/40 bg-vermilion/5")}>
              {viable.length ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-kelp" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-vermilion" />}
              <div>
                <p className="font-medium text-ink">{data.recommendation}</p>
                {(() => {
                  const top = viable[0];
                  const impact = top?.freight?.total_impact_usd;
                  if (impact == null || Math.abs(impact) < 1) return null;
                  return (
                    <p className={cn("mt-1 text-sm font-semibold tabular-nums", impact > 0 ? "text-vermilion" : "text-kelp")}>
                      {impact > 0 ? "+" : "−"}{usdCompact(impact)} freight impact on this cargo at {top.port}
                    </p>
                  );
                })()}
                {data.notes?.map((n) => <p key={n} className="mt-1 text-xs text-inksoft">{n}</p>)}
                <p className="mt-1 text-xs text-inksoft">
                  {port} congestion: {data.failed_port_info?.congestion?.level}
                  {data.failed_port_info?.congestion?.source === "live_ais_radar" ? " (live AIS)" : " (static rating)"}.
                  {data.live_ais_used ? " Live AIS status is used for candidates where available." : ""}
                </p>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <SubstitutionMap map={data.map} selected={selected} onSelect={setSelected} />
              <div className="flex flex-col gap-3">
                {viable.map((o) => <OptionCard key={o.port} o={o} active={selected === o.port} onSelect={setSelected} />)}
                {viable.length === 0 && <p className="text-sm text-inksoft">No viable substitute found.</p>}
              </div>
            </div>

            {rejected.length > 0 && (
              <details className="border border-rule/60 bg-paper/40 p-4">
                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.15em] text-inksoft">Ruled out ({rejected.length})</summary>
                <div className="mt-3 flex flex-col gap-2">
                  {rejected.map((o) => <OptionCard key={o.port} o={o} active={false} onSelect={setSelected} />)}
                </div>
              </details>
            )}

            <div className="flex flex-wrap items-start justify-between gap-3">
              <details className="max-w-3xl text-xs text-inksoft">
                <summary className="flex cursor-pointer items-center gap-1.5"><Info className="h-3.5 w-3.5" /> How this is scored, and what it does not include</summary>
                <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5">
                  <li>Weights: {Object.entries(data.weights).map(([k, w]) => `${k.replace("_", " ")} ${Math.round(w * 100)}%`).join(", ")}.</li>
                  {data.assumptions.map((a) => <li key={a}>{a}</li>)}
                </ul>
              </details>
              <Button as={Link} to="/compare" size="sm" variant="outline">Compare loading origins</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
