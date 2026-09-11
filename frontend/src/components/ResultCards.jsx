// frontend/src/components/ResultCards.jsx
import { useState } from "react";
import { motion } from "framer-motion";
import { Gauge, ShieldAlert, ShipWheel, CalendarClock, Sparkles, Anchor, TimerReset, RadioTower, FileSignature, Map as MapIcon, BrainCircuit, Download, Route } from "lucide-react";
import { Card, CardContent } from "./ui/card.jsx";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import TiltCard from "./ui/tilt-card.jsx";
import RouteMap from "./ui/RouteMap.jsx";
import api from "../api/client.js";

const RISK_VARIANT = { low: "low", medium: "medium", high: "high" };

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07 } },
};
const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

function StatCard({ icon: Icon, iconClass, label, children, sub }) {
  return (
    <motion.div variants={item} className="h-full">
      <TiltCard maxTilt={4} className="h-full rounded-2xl">
        <Card className="flex h-full flex-col gap-3 p-6">
          <div className="flex items-center gap-2">
            <span className={`flex h-8 w-8 items-center justify-center rounded-lg bg-hull-700/80 ${iconClass}`}>
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">{label}</span>
          </div>
          <div>{children}</div>
          {sub && <span className="text-xs text-slate-500">{sub}</span>}
        </Card>
      </TiltCard>
    </motion.div>
  );
}

function WideCard({ icon: Icon, iconClass, label, sub, children }) {
  return (
    <motion.div variants={item}>
      <Card className="flex flex-col gap-2.5 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`flex h-7 w-7 items-center justify-center rounded-md bg-hull-700/80 ${iconClass}`}>
            <Icon className="h-3.5 w-3.5" strokeWidth={2} />
          </span>
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">{label}</span>
          {sub && <span className="text-xs font-medium text-slate-600">· {sub}</span>}
        </div>
        {children}
      </Card>
    </motion.div>
  );
}

function PortInfoBlock({ label, info }) {
  if (!info) return null;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hull-600/60 bg-hull-900/50 p-3.5">
      <span className="text-sm font-semibold text-paper-100">
        {label}: <span className="font-normal text-slate-300">{info.name}</span>
      </span>
      {info.known ? (
        <span className="font-mono text-xs leading-relaxed text-slate-500">
          {`Draft ${info.max_draft_m}m · LOA ${info.max_loa_m}m · Beam ${info.max_beam_m}m · ${info.cargo_handling_rate_tpd?.toLocaleString()} t/day handling`}
          {info.typical_congestion ? ` · ${info.typical_congestion} ${"typical congestion"}` : ""}
        </span>
      ) : (
        <span className="text-xs text-slate-500">{"No infrastructure data on file for this port."}</span>
      )}
    </div>
  );
}

export default function ResultCards({ result }) {
  const [pdfLoading, setPdfLoading] = useState(false);
  if (!result) return null;
  const riskVariant = RISK_VARIANT[result.risk_label] || "medium";
  const pdfHref = result.record_id ? `${api.defaults.baseURL}/forecast/${result.record_id}/pdf` : null;
  const reportAvailable = result.report_available === true;

  async function downloadPdf() {
    if (!result.record_id || pdfLoading) return;
    setPdfLoading(true);
    try {
      const response = await api.get(`/forecast/${result.record_id}/pdf`, { responseType: "blob" });
      const url = window.URL.createObjectURL(response.data);
      const link = document.createElement("a");
      link.href = url;
      link.download = `freightsight-forecast-${result.record_id}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } finally {
      setPdfLoading(false);
    }
  }

  return (
    <motion.div initial="hidden" animate="show" variants={container} className="flex flex-col gap-5">
      {(result.forecast_type === "market_proxy" || result.forecast_type === "synthetic_route") && (
        <motion.div variants={item}>
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
            {result.forecast_type === "synthetic_route"
              ? "MVP data notice: route freight rates are synthetic development data supplied for demonstration. They are not broker quotes, observed market rates, or real-time fixtures."
              : "Freight forecast uses a market-index (BDRY) proxy because route-level freight observations are unavailable for this lane. It is not an observed route-specific freight rate."}
          </div>
        </motion.div>
      )}

      {pdfHref && reportAvailable && (
        <motion.div variants={item} className="flex justify-end">
          <Button variant="outline" className="gap-2 text-xs" onClick={downloadPdf} disabled={pdfLoading}>
            <Download className="h-3.5 w-3.5" /> {pdfLoading ? "Preparing…" : "Download one-pager (PDF)"}
          </Button>
        </motion.div>
      )}


      <WideCard icon={Gauge} iconClass="text-signal" label={"Forecast basis"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-hull-600/60 bg-hull-900/50 p-3">
            <div className="text-xs uppercase tracking-widest text-slate-500">{"What is predicted"}</div>
            <div className="mt-1 text-sm font-medium text-paper-100">{result.forecast_basis || (result.forecast_type === "route_specific" ? "Verified route freight" : "BDRY dry-bulk market proxy")}</div>
            <div className="mt-1 text-xs leading-relaxed text-slate-500">{result.forecast_source || "Historical BDRY + operational features"}</div>
          </div>
          <div className="rounded-lg border border-hull-600/60 bg-hull-900/50 p-3">
            <div className="text-xs uppercase tracking-widest text-slate-500">{"Data quality"}</div>
            <div className="mt-1 text-sm font-medium text-paper-100">{(result.data_confidence || "medium").toUpperCase()} · {(result.training_data_mode || "unknown").toUpperCase()}</div>
            <div className="mt-1 text-xs leading-relaxed text-slate-500">{"Latest feature date"}: {result.latest_feature_date || "—"} · {"Risk reliability"}: {result.risk_reliability || "—"}</div>
          </div>
        </div>
      </WideCard>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Gauge}
          iconClass="text-signal"
          label={"BDRY freight-rate proxy"}
          sub={`${"Route"}: ${result.route}`}
        >
          <div className="flex items-baseline gap-1.5">
            <span className="font-display text-3xl font-semibold tracking-tight text-paper-50">
              {result.forecast_value?.toFixed(2)}
            </span>
          </div>
          <span className="text-xs text-slate-500">{"BDRY ETF proxy — not a quoted USD/ton charter rate"}</span>
        </StatCard>

        <StatCard icon={ShieldAlert} iconClass="text-port" label={"Market risk"}>
          <Badge variant={riskVariant} className="text-sm">
            {result.risk_label === "low" ? "Low" : result.risk_label === "high" ? "High" : "Medium"}
          </Badge>
          <div className="mt-2 text-xs text-slate-500">
            {"Confidence"}: {result.risk_confidence != null ? `${(result.risk_confidence * 100).toFixed(1)}%` : "—"}
          </div>
          {(result.data_confidence || result.data_source_level) && (
            <div className="mt-1 text-xs text-slate-600">
              {result.data_confidence && `${"Data confidence"}: ${result.data_confidence}`}
              {result.data_confidence && result.data_source_level && " · "}
              {result.data_source_level && `${"Market-data source"}: ${result.data_source_level}`}
            </div>
          )}
        </StatCard>

        <StatCard
          icon={ShipWheel}
          iconClass="text-starboard"
          label={result.vessel_status === "NO_FEASIBLE_VESSEL" ? "Vessel fit" : "Recommended vessel"}
          sub={
            result.vessel_status === "NO_FEASIBLE_VESSEL"
              ? "No class fits both ports"
              : result.feasible_vessel_types?.length > 0
              ? `${"Feasible"}: ${result.feasible_vessel_types.join(", ")}`
              : null
          }
        >
          <span
            className={
              result.vessel_status === "NO_FEASIBLE_VESSEL"
                ? "font-display text-lg font-medium text-amber-300"
                : "font-display text-lg font-medium text-paper-50"
            }
          >
            {result.vessel_status === "NO_FEASIBLE_VESSEL" ? "None feasible" : result.vessel_suggestion}
          </span>
        </StatCard>

        <StatCard icon={CalendarClock} iconClass="text-amber" label={"Charter window"}>
          <span className="font-display text-lg font-medium text-paper-50">{result.charter_window}</span>
        </StatCard>
      </div>

      {(result.origin_port_info?.name || result.destination_port_info?.name) && (
        <motion.div variants={item}>
          <Card className="flex flex-col gap-3 p-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-hull-700/80 text-signal">
                <MapIcon className="h-3.5 w-3.5" strokeWidth={2} />
              </span>
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">{"Voyage sea route"}</span>
              <span className="text-xs font-medium text-slate-600">· {result.route} · maritime corridor</span>
            </div>
            <div className="h-[340px] overflow-hidden rounded-xl border border-hull-600/60">
              <RouteMap
                origin={result.origin_port_info?.name}
                destination={result.destination_port_info?.name}
                className="h-full w-full"
              />
            </div>
          </Card>
        </motion.div>
      )}

      <WideCard icon={Sparkles} iconClass="text-signal" label={"AI summary"}>
        <p className="text-[0.95rem] leading-relaxed text-slate-300">{result.reasoning}</p>
        {result.vessel_status === "NO_FEASIBLE_VESSEL" && (
          <p className="mt-2 text-xs leading-relaxed text-amber-300">
            {"Note: no vessel class actually fits both ports for this cargo — any vessel named above is an indicative capacity match only, not a real recommendation."}
          </p>
        )}
      </WideCard>

      {result.forecast_curve?.length > 0 && (
        <WideCard icon={CalendarClock} iconClass="text-amber" label={"Multi-horizon outlook"}>
          <div className="grid gap-2 sm:grid-cols-3">
            {result.forecast_curve.map((p, i) => (
              <div key={i} className="rounded-lg border border-hull-600/60 bg-hull-900/50 p-3">
                <div className="font-mono text-xs text-slate-500">{p.date}</div>
                <div className="font-display text-lg font-semibold text-paper-50">
                  {typeof p.predicted_rate === "number" ? p.predicted_rate.toFixed(2) : "—"}
                </div>
                {(p.lower_bound != null && p.upper_bound != null) && (
                  <div className="text-xs text-slate-500">
                    {p.lower_bound.toFixed(2)}–{p.upper_bound.toFixed(2)}
                  </div>
                )}
                {typeof p.confidence === "number" && <div className="mt-1 text-xs text-slate-600">{(p.confidence * 100).toFixed(1)}%</div>}
              </div>
            ))}
          </div>
          <p className="mt-1 text-[0.7rem] text-slate-600">{"Each horizon (H+1/H+2/H+3) is its own directly-trained model, not a relabeled single-step forecast."}</p>
        </WideCard>
      )}

      {(result.origin_port_info || result.destination_port_info) && (
        <WideCard icon={Anchor} iconClass="text-signal" label={"Vessel type optimization — port constraints"}>
          {result.vessel_status && (
            <div className="text-xs text-slate-500">
              {"Vessel feasibility status"}: <span className="font-mono text-slate-400">{result.vessel_status === "RECOMMENDED_VESSEL" ? "Recommended vessel" : result.vessel_status === "REQUESTED_VESSEL_FEASIBLE" ? "Requested vessel feasible" : result.vessel_status === "REQUESTED_VESSEL_NOT_FEASIBLE_USING_RECOMMENDED" ? "Requested vessel not feasible — using recommended vessel" : result.vessel_status === "NO_FEASIBLE_VESSEL" ? "No feasible vessel" : result.vessel_status}</span>
            </div>
          )}
          {result.vessel_status !== "NO_FEASIBLE_VESSEL" && result.vessel_suggestion && (
            <div className="text-sm text-slate-300">
              {"Recommended vessel"}: <span className="font-display font-semibold text-paper-50">{result.vessel_suggestion}</span>
            </div>
          )}
          {result.vessel_status === "NO_FEASIBLE_VESSEL" ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm leading-relaxed text-amber-200">
              {result.vessel_rejection_reason || "No vessel class in the dataset is feasible for this cargo at both ports."}{" "}
              No vessel is actually recommended here — treat any vessel class shown elsewhere as an indicative capacity match only, not a fit-checked recommendation.
            </div>
          ) : (
            result.recommended_vessel_reason && (
              <div className="rounded-lg border border-signal/20 bg-signal/5 p-3 text-xs leading-relaxed text-slate-300">
                <span className="font-semibold text-signal">{"Why this vessel"}:</span> {result.recommended_vessel_reason}
              </div>
            )
          )}
          {result.rejected_vessel_types?.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                {"Rejected vessel classes"}
              </span>
              <div className="flex flex-col gap-1">
                {result.rejected_vessel_types.map((rv, i) => (
                  <div key={i} className="text-xs text-slate-500">
                    <span className="font-mono text-slate-400">{rv.vessel_type || rv.name}</span>
                    {" — "}
                    {rv.rejection_reason || rv.reason}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <PortInfoBlock label={"Load port"} info={result.origin_port_info} />
            <PortInfoBlock label={"Discharge port"} info={result.destination_port_info} />
          </div>
        </WideCard>
      )}

      {result.idle_management_advice && (
        <WideCard
          icon={TimerReset}
          iconClass="text-amber"
          label={"Idle scenario management"}
          sub={result.port_turnaround_days != null ? `est. turnaround ~${result.port_turnaround_days} days` : null}
        >
          <p className="text-sm leading-relaxed text-slate-300">{result.idle_management_advice}</p>
        </WideCard>
      )}

      {(result.transit_note || result.stowage_note) && (
        <WideCard
          icon={Route}
          iconClass="text-starboard"
          label={"Transit & stowage"}
          sub={result.estimated_transit_days != null ? `~${result.estimated_transit_days} day transit` : null}
        >
          {result.transit_note && <p className="text-sm leading-relaxed text-slate-300">{result.transit_note}</p>}
          {result.stowage_note && <p className="text-sm leading-relaxed text-slate-300">{result.stowage_note}</p>}
        </WideCard>
      )}

      {result.congestion_warning && (
        <WideCard icon={RadioTower} iconClass="text-port" label={"Risk mitigation — congestion early warning"}>
          <p className="text-sm leading-relaxed text-slate-300">{result.congestion_warning}</p>
        </WideCard>
      )}

      {result.contracting_strategy && (
        <WideCard icon={FileSignature} iconClass="text-starboard" label={"Spot → short/mid-term contracting strategy"}>
          <p className="text-sm leading-relaxed text-slate-300">{result.contracting_strategy}</p>
        </WideCard>
      )}

      {(result.feature_importance?.length > 0 || result.top_drivers?.length > 0) && (
        <WideCard icon={BrainCircuit} iconClass="text-signal" label={"Why this forecast"} sub={"model explainability"}>
          <div className="grid gap-5 sm:grid-cols-2">
            {result.top_drivers?.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                  {"Top drivers for this request"}
                </span>
                <div className="flex flex-col gap-2">
                  {result.top_drivers.map((d) => (
                    <div key={d.feature} className="rounded-lg border border-hull-600/60 bg-hull-900/50 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-medium text-paper-100">{d.feature}</span>
                        <span className="text-[0.68rem] text-slate-500">{d.direction}</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {`Value ${d.value} vs typical ${d.typical_value} · ${(d.global_importance * 100).toFixed(1)}% global weight`}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.feature_importance?.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                  {"Global feature importance"}
                </span>
                <div className="flex flex-col gap-2">
                  {result.feature_importance.map((f) => (
                    <div key={f.feature} className="flex items-center gap-2.5">
                      <span className="w-24 shrink-0 truncate font-mono text-xs text-slate-400">{f.feature}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hull-700/70">
                        <div
                          className="h-full rounded-full bg-signal"
                          style={{ width: `${Math.min(100, f.importance * 100)}%` }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right font-mono text-xs text-slate-500">
                        {(f.importance * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="mt-1 text-[0.7rem] text-slate-600">
            {"Local drivers are a lightweight importance × deviation-from-typical estimate, not a full SHAP attribution — useful for a quick \"what moved this forecast\" read."}
          </p>
        </WideCard>
      )}
    </motion.div>
  );
}