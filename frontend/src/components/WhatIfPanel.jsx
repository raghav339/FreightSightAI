// (5) Sensitivity / what-if panel — lets the user drag cargo weight and
// contract duration around the values they just forecast with, and see how
// the vessel recommendation, turnaround, idle-time advice, and contracting
// strategy shift — without re-running the full rate/risk model or writing
// another row to history.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, SlidersHorizontal } from "lucide-react";
import api from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";

const DEBOUNCE_MS = 350;

export default function WhatIfPanel({ baseRequest, onScenarioChange }) {
  const baseCargo = Number(baseRequest?.cargo_weight_tons) || 50000;
  const baseDuration = Number(baseRequest?.contract_duration_months) || 6;
  const cargoStep = baseCargo < 1000 ? 10 : baseCargo < 10000 ? 100 : 1000;
  const cargoMinRaw = Math.max(cargoStep, baseCargo * 0.4);
  const cargoMin = Math.round(cargoMinRaw / cargoStep) * cargoStep;
  const cargoMaxRaw = Math.max(cargoMin + cargoStep, baseCargo * 1.8);
  const cargoMax = Math.max(cargoMin + cargoStep, Math.round(cargoMaxRaw / cargoStep) * cargoStep);

  const [cargo, setCargo] = useState(baseCargo);
  const [duration, setDuration] = useState(baseDuration);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    setCargo(baseCargo);
    setDuration(baseDuration);
  }, [baseRequest?.origin_port, baseRequest?.destination_port, baseRequest?.commodity]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!baseRequest) return;
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const { data } = await api.post("/whatif", {
          commodity: baseRequest.commodity,
          origin_port: baseRequest.origin_port,
          destination_port: baseRequest.destination_port,
          shipment_date: baseRequest.shipment_date,
          cargo_weight_tons: cargo,
          contract_duration_months: duration || undefined,
          total_program_tons: baseRequest.total_program_tons || undefined,
        });
        setResult(data);
      } catch (err) {
        setError(err.response?.data?.error || "Could not recompute — try adjusting the sliders again.");
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [cargo, duration, baseRequest]);

  // Report the live scenario upward (debounced result included) so a
  // sibling panel — e.g. the decision simulator — can compare procurement
  // options against whatever cargo/duration the user last dragged to,
  // instead of only ever seeing the original base-case forecast inputs.
  useEffect(() => {
    if (!onScenarioChange) return;
    onScenarioChange({ cargo, duration, result });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargo, duration, result]);

  const voyages = useMemo(() => {
    if (!baseRequest?.total_program_tons || !cargo) return null;
    return Math.max(1, Math.ceil(Number(baseRequest.total_program_tons) / cargo));
  }, [baseRequest?.total_program_tons, cargo]);

  if (!baseRequest) return null;

  return (
    <motion.div id="whatif-panel" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <Card>
        <CardHeader className="flex flex-row items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-signal/10 text-signal">
            <SlidersHorizontal className="h-[18px] w-[18px]" />
          </span>
          <div className="flex flex-col">
            <CardTitle className="text-lg">{"What-if — cargo & contract sensitivity"}</CardTitle>
            <span className="text-xs text-slate-500">
              {`Drag to see how vessel choice, turnaround, and contracting strategy shift for ${baseRequest.origin_port}–${baseRequest.destination_port}. These same numbers feed the Decision simulator below.`}
            </span>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-6 pt-2">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-slate-400">{"Cargo weight"}</span>
                <span className="font-mono text-sm font-semibold text-paper-50">
                  {cargo.toLocaleString()} t
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" aria-label="Decrease cargo weight" onClick={() => setCargo((v) => Math.max(cargoMin, v - cargoStep))} className="h-9 w-9 rounded-lg border border-hull-600 bg-hull-800 text-slate-300 hover:border-signal/40">−</button>
                <input
                  aria-label={"Cargo weight"}
                  type="range"
                  min={cargoMin}
                  max={cargoMax}
                  step={cargoStep}
                  value={Math.min(Math.max(cargo, cargoMin), cargoMax)}
                  onChange={(e) => setCargo(Number(e.target.value))}
                  onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowDown") e.stopPropagation(); }}
                  className="w-full accent-signal"
                />
                <button type="button" aria-label="Increase cargo weight" onClick={() => setCargo((v) => Math.min(cargoMax, v + cargoStep))} className="h-9 w-9 rounded-lg border border-hull-600 bg-hull-800 text-slate-300 hover:border-signal/40">+</button>
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <span className="font-mono text-[0.65rem] text-slate-600">{cargoMin.toLocaleString()}</span>
                <input
                  aria-label={"Cargo weight"}
                  type="number"
                  min={cargoMin}
                  max={cargoMax}
                  step={cargoStep}
                  value={cargo}
                  onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setCargo(Math.min(Math.max(cargoMin, n), cargoMax)); }}
                  className="w-28 rounded-lg border border-hull-600 bg-hull-900 px-2 py-1.5 text-center font-mono text-xs text-paper-50"
                />
                <span className="text-right font-mono text-[0.65rem] text-slate-600">{cargoMax.toLocaleString()}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-slate-400">{"Contract duration"}</span>
                <span className="font-mono text-sm font-semibold text-paper-50">
                  {duration ? `${duration} mo` : "Spot"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={24}
                step={1}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full accent-signal"
              />
              <div className="flex justify-between font-mono text-[0.65rem] text-slate-600">
                <span>{"Spot"}</span>
                <span>24 mo</span>
              </div>
            </div>
          </div>

          {voyages && (
            <p className="text-xs text-slate-500">
              {`At ${cargo.toLocaleString()}t per lift, the ${Number(baseRequest.total_program_tons).toLocaleString()}t program implies roughly ${voyages} voyages.`}
            </p>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {"Recomputing…"}
            </div>
          )}

          {error && <p className="text-xs font-medium text-port">{error}</p>}

          {result && !error && (
            <div className="grid grid-cols-1 gap-4 border-t border-hull-600/60 pt-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-[0.68rem] font-semibold uppercase tracking-widest text-slate-500">
                  {result.vessel_status === "NO_FEASIBLE_VESSEL" ? "Vessel fit" : "Recommended vessel"}
                </span>
                <span
                  className={
                    result.vessel_status === "NO_FEASIBLE_VESSEL"
                      ? "font-display text-base font-medium text-amber-300"
                      : "font-display text-base font-medium text-paper-50"
                  }
                >
                  {result.vessel_status === "NO_FEASIBLE_VESSEL" ? "None feasible" : result.recommended_vessel_type}
                </span>
                {result.vessel_status === "NO_FEASIBLE_VESSEL" ? (
                  <span className="text-xs text-amber-300">
                    {result.vessel_rejection_reason || "No vessel class fits both ports for this cargo."}
                  </span>
                ) : (
                  result.feasible_vessel_types?.length > 0 && (
                    <span className="text-xs text-slate-500">
                      {"Feasible"}: {result.feasible_vessel_types.join(", ")}
                    </span>
                  )
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[0.68rem] font-semibold uppercase tracking-widest text-slate-500">
                  {"Port turnaround"}
                </span>
                <span className="font-display text-base font-medium text-paper-50">
                  {result.port_turnaround_days != null ? `~${result.port_turnaround_days} days` : "—"}
                </span>
              </div>

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-[0.68rem] font-semibold uppercase tracking-widest text-slate-500">
                  {"Idle-time advice"}
                </span>
                <p className="text-sm leading-relaxed text-slate-300">{result.idle_management_advice}</p>
              </div>

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-[0.68rem] font-semibold uppercase tracking-widest text-slate-500">
                  {"Contracting strategy"}
                </span>
                <p className="text-sm leading-relaxed text-slate-300">{result.contracting_strategy}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <Badge variant="signal">{`Charter window: ${result.recommended_charter_window}`}</Badge>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}