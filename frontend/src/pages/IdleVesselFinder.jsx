// frontend/src/pages/IdleVesselFinder.jsx
// (6) Idle-vessel repositioning — given a vessel idle at a port, rank the
// next-best loading ports to reposition to, weighing predicted freight
// earnings against ballast/idle time.
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, AlertTriangle, Anchor, TimerReset, Radar, RefreshCw, MapPin, Gauge, Clock3, ShieldCheck } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Field, Select, Input } from "../components/ui/field.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";

export default function IdleVesselFinder() {
  const [meta, setMeta] = useState({ destinations: [], commodities: ["Coal", "Iron Ore", "Bulk Minerals & Ores"] });
  const [vesselTypes, setVesselTypes] = useState([]);
  const [form, setForm] = useState({ current_port: "", vessel_type: "", commodity: "", cargo_weight_tons: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [aisVessels, setAisVessels] = useState(null);
  const [aisLoading, setAisLoading] = useState(false);
  const [aisError, setAisError] = useState(null);

  async function loadAisIdleVessels() {
    setAisLoading(true);
    setAisError(null);
    try {
      const { data } = await api.get("/ais/idle-vessels", {
        params: { lookback_hours: 48, min_idle_hours: 4, limit: 50, cargo_only: true },
      });
      setAisVessels(data);
    } catch (err) {
      setAisError(err.response?.data?.error || "Live AIS idle-vessel detection is unavailable.");
    } finally {
      setAisLoading(false);
    }
  }

  useEffect(() => {
    api.get("/routes").then(({ data }) => setMeta(data)).catch(() => {});
    api
      .get("/vessels")
      .then(({ data }) => setVesselTypes(data.vessel_types || []))
      .catch(() => {});
    loadAisIdleVessels();
    const timer = window.setInterval(loadAisIdleVessels, 30000);
    return () => window.clearInterval(timer);
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const { data } = await api.post("/idle-alternatives", {
        current_port: form.current_port,
        vessel_type: form.vessel_type || undefined,
        commodity: form.commodity || undefined,
        cargo_weight_tons: form.cargo_weight_tons ? Number(form.cargo_weight_tons) : undefined,
      });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || "Could not find alternatives");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-1.5">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-signal/80">{"Idle vessel finder"}</span>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-paper-50 sm:text-3xl">
          {"Reposition an idle vessel"}
        </h1>
        <p className="max-w-2xl text-sm text-slate-400">
          {"Vessel just discharged and sitting idle at an East Coast port? Rank the next-best loading ports to ballast toward, weighing predicted freight earnings against ballast time."}
        </p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
              <Radar className="h-[18px] w-[18px]" />
            </span>
            <div>
              <CardTitle className="text-lg">Live AIS Idle Detection</CardTitle>
              <p className="mt-1 text-xs text-slate-500">AIS history + movement stability + port proximity + navigation status</p>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={loadAisIdleVessels} disabled={aisLoading}>
            <RefreshCw className={`h-4 w-4 ${aisLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-2">
          {aisError && (
            <div className="flex items-center gap-2 rounded-lg border border-port/30 bg-port/10 px-4 py-3 text-sm text-port">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {aisError}
            </div>
          )}

          {!aisError && aisVessels && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-hull-600/60 bg-hull-900/50 p-3">
                  <div className="text-xs uppercase tracking-wider text-slate-500">Detected</div>
                  <div className="mt-1 font-display text-2xl font-semibold text-paper-50">{aisVessels.count}</div>
                </div>
                <div className="rounded-xl border border-hull-600/60 bg-hull-900/50 p-3">
                  <div className="text-xs uppercase tracking-wider text-slate-500">SOG threshold</div>
                  <div className="mt-1 font-mono text-xl font-semibold text-paper-50">≤ {aisVessels.definition.sog_threshold_kn} kn</div>
                </div>
                <div className="rounded-xl border border-hull-600/60 bg-hull-900/50 p-3">
                  <div className="text-xs uppercase tracking-wider text-slate-500">Min idle</div>
                  <div className="mt-1 font-mono text-xl font-semibold text-paper-50">{aisVessels.min_idle_hours} h</div>
                </div>
                <div className="rounded-xl border border-hull-600/60 bg-hull-900/50 p-3">
                  <div className="text-xs uppercase tracking-wider text-slate-500">Last scan</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-paper-50">{aisVessels.generated_at ? new Date(aisVessels.generated_at).toLocaleTimeString() : "—"}</div>
                </div>
              </div>

              {aisVessels.vessels.length === 0 ? (
                <div className="rounded-xl border border-hull-600/60 bg-hull-900/30 p-6 text-sm text-slate-400">
                  No high-confidence AIS-idle cargo/bulk candidates are currently present in the stored observation window.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {aisVessels.vessels.map((vessel) => (
                    <div key={vessel.mmsi} className="rounded-xl border border-hull-600/60 bg-hull-900/50 p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-display text-base font-medium text-paper-50">{vessel.ship_name}</span>
                            <Badge variant={vessel.idle_confidence === "HIGH" ? "low" : vessel.idle_confidence === "MEDIUM" ? "medium" : "neutral"}>
                              {vessel.idle_confidence} CONFIDENCE · {vessel.idle_score}/100
                            </Badge>
                          </div>
                          <div className="mt-1 text-xs text-slate-500">MMSI {vessel.mmsi} · {vessel.vessel_category} · IMO {vessel.imo || "unknown"}</div>
                          <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-300">
                            <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-signal" />{vessel.nearest_port || "Open water"}</span>
                            <span className="inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5 text-signal" />{vessel.sog_kn ?? "—"} kn</span>
                            <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 text-signal" />{vessel.idle_duration_hours.toFixed(1)} h idle</span>
                            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-signal" />{vessel.nav_status_label}</span>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                          <div className="text-right text-xs text-slate-500">
                            <div>Port distance</div>
                            <div className="mt-1 font-mono text-sm text-paper-50">{vessel.distance_to_port_nm ?? "—"} nm</div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              update("current_port", vessel.nearest_port || "");
                              setResult(null);
                              window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
                            }}
                            disabled={!vessel.nearest_port}
                          >
                            Reposition this vessel
                          </Button>
                        </div>
                      </div>
                      <div className="mt-3 rounded-lg border border-hull-600/40 bg-hull-950/50 p-3">
                        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Evidence</div>
                        <div className="mt-2 grid gap-1 text-xs text-slate-400 sm:grid-cols-2">
                          {vessel.evidence.map((item, index) => <div key={index}>• {item}</div>)}
                        </div>
                      </div>
                      <div className="mt-3 text-[11px] leading-relaxed text-slate-600">AIS idle detection does not assert commercial charter availability. Confirm fixture status independently before chartering.</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        onSubmit={handleSubmit}
      >
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
              <Anchor className="h-[18px] w-[18px]" />
            </span>
            <CardTitle className="text-lg">{"Vessel status"}</CardTitle>
          </CardHeader>

          <CardContent className="flex flex-col gap-6 pt-2">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={"Current port"}>
                <Select required value={form.current_port} onChange={(e) => update("current_port", e.target.value)}>
                  <option value="">{"Select port"}</option>
                  {meta.destinations.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </Select>
              </Field>

              <Field label={"Vessel type"} hint={"optional"}>
                <Select value={form.vessel_type} onChange={(e) => update("vessel_type", e.target.value)}>
                  <option value="">{"Any"}</option>
                  {vesselTypes.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </Select>
              </Field>

              <Field label={"Preferred commodity"} hint={"optional"}>
                <Select value={form.commodity} onChange={(e) => update("commodity", e.target.value)}>
                  <option value="">{"Any"}</option>
                  {meta.commodities.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </Field>

              <Field label={"Cargo weight (tons)"} hint={"optional"}>
                <Input
                  type="number"
                  min="0"
                  step="100"
                  value={form.cargo_weight_tons}
                  onChange={(e) => update("cargo_weight_tons", e.target.value)}
                />
              </Field>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-port/30 bg-port/10 px-4 py-2.5 text-sm font-medium text-port">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}

            <Button type="submit" disabled={loading} className="w-full sm:w-auto">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {"Searching…"}
                </>
              ) : (
                "Find alternatives"
              )}
            </Button>
          </CardContent>
        </Card>
      </motion.form>

      {result && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <Card>
            <CardHeader className="flex flex-row items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
                <TimerReset className="h-[18px] w-[18px]" />
              </span>
              <div className="flex flex-col">
                <CardTitle className="text-lg">{`Next-best employment from ${result.current_port}`}</CardTitle>
                <span className="text-xs text-slate-500">{result.note}</span>
              </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-3 pt-2">
              {result.alternatives.length === 0 && (
                <p className="text-sm text-slate-400">
                  {"No feasible ports found for that vessel type — try loosening the vessel or commodity filter."}
                </p>
              )}
              <div className="flex flex-col gap-3">
                {result.alternatives.map((a) => (
                  <div
                    key={`${a.origin_port}-${a.commodity}`}
                    className="flex flex-col gap-2 rounded-xl border border-hull-600/60 bg-hull-900/50 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal/10 font-mono text-xs font-semibold text-signal">
                        {a.rank}
                      </span>
                      <div className="flex flex-col">
                        <span className="font-display text-base font-medium text-paper-50">{a.origin_port}</span>
                        <span className="text-xs text-slate-500">{a.note}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <Badge variant="neutral">{a.commodity}</Badge>
                      <Badge
                        variant={a.risk_label === "high" ? "high" : a.risk_label === "medium" ? "medium" : "low"}
                      >
                        {a.risk_label}
                      </Badge>
                      <span className="font-mono text-xs text-slate-400">
                        ~{a.estimated_ballast_days}d ballast · ${a.predicted_freight_rate_usd_per_ton?.toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </section>
  );
}
