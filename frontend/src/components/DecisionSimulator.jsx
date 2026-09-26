// (5b) Decision simulator — the "so what should I do about it" step that
// sits right after the what-if sensitivity panel. It does not run any new
// model logic of its own: it takes whatever cargo/duration scenario the
// user last dragged to in WhatIfPanel and replays it through two
// endpoints that already exist — /coa-optimize and /compare-origins — then
// lays the results out side by side against the original base-case
// forecast so the trade-off (stay on this lane vs. go multi-voyage vs.
// load somewhere else) is visible in one place instead of three separate
// pages.
//
// Deliberately button-triggered rather than auto-firing on every slider
// tick: /compare-origins fans out across every loading port (11 calls
// server-side) and both endpoints share the same 30-req/min decision
// rate limit as the what-if slider itself, so wiring this to the debounce
// would burn that budget fast for no benefit.
import { useState } from "react";
import { motion } from "framer-motion";
import { Loader2, GitCompareArrows, TrendingDown, TrendingUp, SlidersHorizontal } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import DecisionBriefButton from "./DecisionBriefButton.jsx";

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function OptionCard({ title, sub, cost, costLabel, cheapest, children, tone = "neutral" }) {
  return (
    <div
      className={
        "flex flex-col gap-3 rounded-xl border p-4 " +
        (cheapest ? "border-starboard/40 bg-starboard/5" : "border-hull-600/60 bg-hull-900/40")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">{title}</div>
          {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
        </div>
        {cheapest && <Badge variant="low">Lowest cost</Badge>}
      </div>
      <div>
        <div className="text-[0.65rem] uppercase tracking-widest text-slate-500">{costLabel}</div>
        <div className="font-display text-xl font-semibold text-paper-50">{fmtUsd(cost)}</div>
      </div>
      <div className="flex flex-col gap-1.5 text-xs leading-relaxed text-slate-400">{children}</div>
    </div>
  );
}

export default function DecisionSimulator({ baseRequest, forecast, scenario }) {
  const [status, setStatus] = useState("idle"); // idle | loading | done
  const [coa, setCoa] = useState({ error: null, data: null });
  const [alt, setAlt] = useState({ error: null, data: null });

  if (!baseRequest || !forecast) return null;

  const cargo = scenario?.cargo || Number(baseRequest.cargo_weight_tons) || 0;
  const duration = scenario?.duration ?? (Number(baseRequest.contract_duration_months) || 0);
  // Every card is priced on the same tonnage as the COA optimizer: the whole
  // program when one is set, otherwise the single cargo.
  const basisTons = Number(baseRequest.total_program_tons) || cargo;

  // Whether the numbers above actually reflect a drag in the What-if panel,
  // vs. just falling back to the original forecast-form inputs. Mirrors the
  // same base-cargo/base-duration defaults WhatIfPanel itself starts from,
  // so this only flips once the user has genuinely moved a slider — it's
  // what tells them (and links them back to) where these numbers came from.
  const baseCargoDefault = Number(baseRequest.cargo_weight_tons) || 50000;
  const baseDurationDefault = Number(baseRequest.contract_duration_months) || 6;
  const scenarioAdjusted =
    scenario != null &&
    (Number(scenario.cargo) !== baseCargoDefault || Number(scenario.duration ?? 0) !== baseDurationDefault);

  function scrollToWhatIf(e) {
    e.preventDefault();
    document.getElementById("whatif-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function run() {
    setStatus("loading");
    setCoa({ error: null, data: null });
    setAlt({ error: null, data: null });

    const [coaSettled, altSettled] = await Promise.allSettled([
      api.post("/coa-optimize", {
        commodity: baseRequest.commodity,
        origin_port: baseRequest.origin_port,
        destination_port: baseRequest.destination_port,
        shipment_date: baseRequest.shipment_date,
        cargo_weight_tons: cargo,
        total_program_tons: baseRequest.total_program_tons || undefined,
        contract_duration_months: duration || 1,
      }),
      api.post("/compare-origins", {
        commodity: baseRequest.commodity,
        destination_port: baseRequest.destination_port,
        shipment_date: baseRequest.shipment_date,
        cargo_weight_tons: cargo,
        contract_duration_months: duration || undefined,
        total_program_tons: baseRequest.total_program_tons || undefined,
      }),
    ]);

    if (coaSettled.status === "fulfilled") setCoa({ error: null, data: coaSettled.value.data });
    else setCoa({ error: coaSettled.reason?.response?.data?.error || "COA optimization failed.", data: null });

    if (altSettled.status === "fulfilled") setAlt({ error: null, data: altSettled.value.data });
    else setAlt({ error: altSettled.reason?.response?.data?.error || "Origin comparison failed.", data: null });

    setStatus("done");
  }

  // Baseline: the original forecast, priced at the current scenario's
  // cargo tonnage so it's comparable to the other two cards.
  const baselineRate = forecast.forecast_value != null ? Number(forecast.forecast_value) : null;
  const baselineCost = baselineRate != null && basisTons ? baselineRate * basisTons : null;
  const stayFeasible = (scenario?.result?.vessel_status ?? forecast.vessel_status) !== "NO_FEASIBLE_VESSEL";

  const coaBest = coa.data?.best_strategy || null;
  const coaCost = coaBest?.expected_freight_cost_usd ?? null;

  // Best alternative = cheapest origin whose vessel fits at BOTH ports.
  // `feasible` (from compare-origins) already reflects full both-port
  // status; the vessel_status check is kept too as a defensive guard for
  // rows where it might be missing. Same rule as the Decision Brief PDF.
  const altFeasible = (alt.data?.results || [])
    .filter((r) => r.origin_port !== baseRequest.origin_port
      && r.feasible === true
      && typeof r.vessel_status === "string" && r.vessel_status !== "NO_FEASIBLE_VESSEL"
      && r.predicted_freight_rate_usd_per_ton != null)
    .sort((a, b) => a.predicted_freight_rate_usd_per_ton - b.predicted_freight_rate_usd_per_ton
      || (a.total_voyage_days ?? Infinity) - (b.total_voyage_days ?? Infinity));
  const altBest = altFeasible[0] || null;
  // Next-cheapest vessel-feasible loading ports, shown by name only.
  const altOthers = altFeasible.slice(1, 4).map((r) => r.origin_port);
  const altCost = altBest ? altBest.predicted_freight_rate_usd_per_ton * basisTons : null;

  // "Lowest cost" only among options that can actually be executed.
  const coaFeasible = coa.data?.status === "optimized";
  const costs = [stayFeasible ? baselineCost : null, coaFeasible ? coaCost : null, altCost].filter((c) => c != null);
  const minCost = costs.length ? Math.min(...costs) : null;

  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
              <GitCompareArrows className="h-[18px] w-[18px]" />
            </span>
            <div className="flex flex-col">
              <CardTitle className="text-lg">Decision simulator — what should procurement do?</CardTitle>
              <span className="text-xs text-slate-500">
                {`Compares staying on this lane against a multi-voyage COA and the best alternative loading port, on ${baseRequest.origin_port}–${baseRequest.destination_port}.`}
              </span>
              <button
                type="button"
                onClick={scrollToWhatIf}
                className="mt-1 flex w-fit items-center gap-1.5 text-[0.68rem] font-medium text-signal hover:underline"
              >
                <SlidersHorizontal className="h-3 w-3" />
                {scenarioAdjusted
                  ? `Priced at ${cargo.toLocaleString()} t${duration ? `, ${duration} mo` : ", spot"} — from the sliders in What-if above`
                  : `Priced at ${cargo.toLocaleString()} t${duration ? `, ${duration} mo` : ", spot"} — your original forecast inputs (adjust What-if above to test a scenario)`}
              </button>
            </div>
          </div>
          <DecisionBriefButton recordId={forecast.record_id} cargo={cargo} duration={duration} />
        </CardHeader>

        <CardContent className="flex flex-col gap-5 pt-2">
          <Button type="button" size="sm" variant="outline" onClick={run} disabled={status === "loading"} className="self-start gap-2">
            {status === "loading" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Comparing options…
              </>
            ) : status === "done" ? (
              "Recompute for current scenario"
            ) : (
              "Compare procurement options"
            )}
          </Button>

          {status === "done" && (
            <div className="grid grid-cols-1 gap-4 border-t border-hull-600/60 pt-4 md:grid-cols-3">
              <OptionCard
                title="Stay on this lane"
                sub={`${baseRequest.origin_port} → ${baseRequest.destination_port}`}
                cost={baselineCost}
                costLabel={`Est. cost at ${basisTons.toLocaleString()} t`}
                cheapest={stayFeasible && minCost != null && baselineCost === minCost}
              >
                <span>Rate: {baselineRate != null ? `$${baselineRate.toFixed(2)}/t` : "—"}</span>
                <span>Risk: {forecast.risk_label ? forecast.risk_label[0].toUpperCase() + forecast.risk_label.slice(1) : "—"}</span>
                {!stayFeasible && <span className="text-amber-300">No vessel fits both ports for this cargo</span>}
              </OptionCard>

              <OptionCard
                title="Go multi-voyage (COA)"
                sub={coa.data ? `${coaBest?.vessel_type || "—"} · ${coaBest?.voyages ?? "—"} voyages` : undefined}
                cost={coaCost}
                costLabel="Expected program cost"
                cheapest={coaFeasible && minCost != null && coaCost === minCost}
              >
                {coa.error ? (
                  <div className="flex flex-col gap-1 text-port">
                    {String(coa.error).split(" | ").map((line, i) => (
                      <span key={i}>{line}</span>
                    ))}
                  </div>
                ) : coa.data ? (
                  <>
                    <span className="flex items-center gap-1">
                      {coa.data.status === "optimized" ? (
                        <span className="text-starboard">Schedule feasible</span>
                      ) : (
                        <span className="text-amber-300">Schedule infeasible</span>
                      )}
                    </span>
                    {coa.data.estimated_savings_vs_spot_usd != null && (
                      <span className="flex items-center gap-1 text-starboard">
                        {coa.data.estimated_savings_vs_spot_usd >= 0 ? (
                          <TrendingDown className="h-3 w-3" />
                        ) : (
                          <TrendingUp className="h-3 w-3" />
                        )}
                        {fmtUsd(Math.abs(coa.data.estimated_savings_vs_spot_usd))} vs spot benchmark
                      </span>
                    )}
                  </>
                ) : null}
              </OptionCard>

              <OptionCard
                title="Switch loading port"
                sub={altBest ? altBest.origin_port : undefined}
                cost={altCost}
                costLabel={`Est. cost at ${basisTons.toLocaleString()} t`}
                cheapest={minCost != null && altCost === minCost}
              >
                {alt.error ? (
                  <span className="text-port">{alt.error}</span>
                ) : altBest ? (
                  <>
                    <span>Rate: ${altBest.predicted_freight_rate_usd_per_ton}/t · Risk: {altBest.risk_label}</span>
                    <span>{altBest.total_voyage_days != null ? `${altBest.total_voyage_days}d total voyage` : "—"}</span>
                    <span>Vessel-feasible at both ports</span>
                    {altOthers.length > 0 && <span>Other feasible ports: {altOthers.join(", ")}</span>}
                  </>
                ) : (
                  <span>No alternative origin has a vessel that fits at both ports.</span>
                )}
              </OptionCard>
            </div>
          )}

          {status === "done" && (
            <p className="text-xs leading-relaxed text-slate-500">
              Costs are indicative planning estimates from the route model and optimizer — not broker or charter
              quotes. "Switch loading port" compares the cheapest vessel-feasible alternative from /compare-origins against the
              current lane's own forecast; it does not account for inland logistics to reach that port.
            </p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
