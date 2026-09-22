// (2) Route/origin comparison — pick a destination, commodity, cargo, and
// date, and rank every known loading port (Australia/US/Mozambique/Russia/
// Indonesia) by vessel feasibility (both origin and destination), then
// total voyage time, then freight rate. Port congestion is shown on every
// row as a supporting signal but is not itself a ranking key.
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, AlertTriangle, Compass, Ship, CheckCircle2, XCircle } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Field, Input, Select } from "../components/ui/field.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";

const EMPTY_FORM = {
  commodity: "",
  destination_port: "",
  shipment_date: "",
  cargo_weight_tons: "",
  contract_duration_months: "",
  total_program_tons: "",
};

export default function CompareOrigins() {
  const [meta, setMeta] = useState({ commodities: ["Coal", "Iron Ore", "Bulk Minerals & Ores"], destinations: [] });
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api
      .get("/routes")
      .then(({ data }) => setMeta(data))
      .catch(() => {});
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
      const payload = {
        commodity: form.commodity,
        destination_port: form.destination_port,
        shipment_date: form.shipment_date,
        cargo_weight_tons: Number(form.cargo_weight_tons),
        contract_duration_months: form.contract_duration_months ? Number(form.contract_duration_months) : undefined,
        total_program_tons: form.total_program_tons ? Number(form.total_program_tons) : undefined,
      };
      const { data } = await api.post("/compare-origins", payload);
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || "Comparison request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mx-auto max-w-[1240px] px-5 py-10 lg:px-8 lg:py-14">
      <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1.5">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-signal/80">{"Origin comparison"}</span>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-paper-50 sm:text-3xl">
          {"Compare every loading port"}
        </h1>
        <p className="max-w-2xl text-sm text-slate-400">
          {"Fix the destination, commodity, cargo, and month — see all 11 loading ports across Australia, the US, Mozambique, Russia, and Indonesia ranked by feasibility, then transit time, then freight rate, with congestion shown alongside for context."}
        </p>
      </header>

      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        onSubmit={handleSubmit}
      >
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
              <Compass className="h-[18px] w-[18px]" />
            </span>
            <CardTitle className="text-lg">{"Fixed cargo parameters"}</CardTitle>
          </CardHeader>

          <CardContent className="flex flex-col gap-6 pt-2">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={"Commodity"}>
                <Select required value={form.commodity} onChange={(e) => update("commodity", e.target.value)}>
                  <option value="">{"Select commodity"}</option>
                  {meta.commodities.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </Field>

              <Field label={"Destination port (East Coast India)"}>
                <Select
                  required
                  value={form.destination_port}
                  onChange={(e) => update("destination_port", e.target.value)}
                >
                  <option value="">{"Select destination"}</option>
                  {meta.destinations.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </Select>
              </Field>

              <Field label={"Shipment date"}>
                <Input
                  type="date"
                  required
                  value={form.shipment_date}
                  onChange={(e) => update("shipment_date", e.target.value)}
                />
              </Field>

              <Field label={"Cargo weight (tons)"}>
                <Input
                  type="number"
                  min="1"
                  step="0.1"
                  required
                  value={form.cargo_weight_tons}
                  onChange={(e) => update("cargo_weight_tons", e.target.value)}
                />
              </Field>

              <Field label={"Contract duration (months)"} hint={"optional — COA planning"}>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={form.contract_duration_months}
                  onChange={(e) => update("contract_duration_months", e.target.value)}
                />
              </Field>

              <Field label={"Total program tonnage"} hint={"optional — COA planning"}>
                <Input
                  type="number"
                  min={form.cargo_weight_tons || 0}
                  step="100"
                  value={form.total_program_tons}
                  onChange={(e) => update("total_program_tons", e.target.value)}
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
                  <Loader2 className="h-4 w-4 animate-spin" /> {"Comparing…"}
                </>
              ) : (
                "Compare origins"
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
                <Ship className="h-[18px] w-[18px]" />
              </span>
              <div className="flex flex-col">
                <CardTitle className="text-lg">
                  {result.commodity} → {result.destination_port}
                </CardTitle>
                <span className="text-xs text-slate-500">{result.note}</span>
              </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-3 pt-2">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-separate border-spacing-y-2 text-sm">
                  <thead>
                    <tr className="text-left text-[0.68rem] uppercase tracking-widest text-slate-500">
                      <th className="px-3 py-1">{"#"}</th>
                      <th className="px-3 py-1">{"Origin port"}</th>
                      <th className="px-3 py-1">{"Country"}</th>
                      <th className="px-3 py-1">{"Feasible"}</th>
                      <th className="px-3 py-1">{"Transit"}</th>
                      <th className="px-3 py-1">{"Turnaround"}</th>
                      <th className="px-3 py-1">{"Total voyage"}</th>
                      <th className="px-3 py-1">{"Congestion"}</th>
                      <th className="px-3 py-1">{"Forecast rate"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.results.map((r) => (
                      <tr
                        key={r.origin_port}
                        className="rounded-xl bg-hull-900/50 text-slate-300 [&>td]:border-y [&>td]:border-hull-600/50 [&>td:first-child]:rounded-l-xl [&>td:first-child]:border-l [&>td:last-child]:rounded-r-xl [&>td:last-child]:border-r"
                      >
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{r.rank}</td>
                        <td className="px-3 py-2.5 font-medium text-paper-100">{r.origin_port}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{r.origin_country}</td>
                        <td className="px-3 py-2.5">
                          {r.feasible ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-starboard">
                              <CheckCircle2 className="h-3.5 w-3.5" /> {"Yes"}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-port">
                              <XCircle className="h-3.5 w-3.5" /> {"No"}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs">
                          {r.estimated_transit_days != null ? `${r.estimated_transit_days}d` : "—"}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs">
                          {r.port_turnaround_days != null ? `${r.port_turnaround_days}d` : "—"}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs font-semibold text-paper-100">
                          {r.total_voyage_days != null ? `${r.total_voyage_days}d` : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge
                            variant={
                              r.origin_port_congestion === "high"
                                ? "high"
                                : r.origin_port_congestion === "medium"
                                ? "medium"
                                : "low"
                            }
                            className="text-[0.65rem]"
                            title={r.origin_port_congestion_source || undefined}
                          >
                            {r.origin_port_congestion || "—"}
                          </Badge>
                          {r.ais_congestion?.available ? (
                            <span
                              className="mt-1 block font-mono text-[0.6rem] text-slate-500"
                              title={r.ais_congestion.source}
                            >
                              AIS live: {r.ais_congestion.congestion_index} ({r.ais_congestion.unique_vessels} vessels/24h)
                            </span>
                          ) : (
                            <span className="mt-1 block text-[0.6rem] text-slate-600">
                              AIS live: unavailable
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs">
                          ${r.predicted_freight_rate_usd_per_ton?.toFixed(2)}/t
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[0.7rem] text-slate-600">
                {"Ranked by feasibility first, then total voyage time (transit + turnaround), then forecast rate."}
              </p>
            </CardContent>
          </Card>
        </motion.div>
      )}
      </div>
    </section>
  );
}