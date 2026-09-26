import { useState } from "react";
import { motion } from "framer-motion";
import { Anchor, CalendarClock, Download, Map as MapIcon, RadioTower, Route, ShipWheel, ShieldAlert, TimerReset, WifiOff } from "lucide-react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import RouteMap from "./ui/RouteMap.jsx";
import api from "../api/client.js";
import useNetworkStatus from "../hooks/useNetworkStatus.js";

const RISK_VARIANT = { low: "low", medium: "medium", high: "high" };
const riskText = { low: "Low", medium: "Medium", high: "High" };

function VesselBlock({ result }) {
  const noFit = result.vessel_status === "NO_FEASIBLE_VESSEL";
  return (
    <div className="result-metric result-metric--vessel">
      <div className="result-metric__head"><ShipWheel className="result-icon result-icon--kelp" /><span>Recommended vessel</span></div>
      <div className={`result-metric__value ${noFit ? "result-metric__value--warning" : ""}`}>{noFit ? "None feasible" : (result.vessel_suggestion || "Auto-recommend")}</div>
      {!noFit && result.feasible_vessel_types?.length > 0 && <div className="result-metric__sub">Feasible: {result.feasible_vessel_types.join(", ")}</div>}
      {result.recommended_vessel_reason && <div className="result-metric__sub">{result.recommended_vessel_reason}</div>}
    </div>
  );
}

function WideSection({ eyebrow, title, children, className = "" }) {
  return (
    <section className={`result-section ${className}`}>
      <div className="result-section__eyebrow">{eyebrow}</div>
      {title && <h3 className="result-section__title">{title}</h3>}
      {children}
    </section>
  );
}

export default function ResultCards({ result }) {
  const [pdfLoading, setPdfLoading] = useState(false);
  const { isSlow } = useNetworkStatus();
  if (!result) return null;
  const riskVariant = RISK_VARIANT[result.risk_label] || "medium";
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
    } finally { setPdfLoading(false); }
  }

  const proxyNotice = "MVP data notice: route freight rates are synthetic development data supplied for demonstration. They are not broker quotes, observed market rates, or real-time fixtures.";

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }} className="flex flex-col gap-7">
      {result._cached && (
        <div className="fs-forecast-notice result-notice flex items-center gap-2">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            {result._approx
              ? "Offline — no exact match cached, so this is the closest cached forecast for this lane (different cargo weight/date). Reconnect and re-run for a fresh number."
              : `Offline — showing a forecast cached from a previous connected session${result._cachedAt ? ` (${new Date(result._cachedAt).toLocaleString()})` : ""}.`}
          </span>
        </div>
      )}

      {(result.forecast_type === "synthetic_route") && (
        <div className="fs-forecast-notice result-notice">{proxyNotice}</div>
      )}

      {reportAvailable && result.record_id && (
        <div className="flex justify-end">
          <Button variant="outline" className="gap-2" onClick={downloadPdf} disabled={pdfLoading}>
            <Download className="h-3.5 w-3.5" /> {pdfLoading ? "Preparing…" : "Download one-pager (PDF)"}
          </Button>
        </div>
      )}

      <section className="result-hero">
        <div className="result-hero__left">
          <div className="result-kicker">Route freight-rate forecast</div>
          <div className="result-price-row">
            <div className="result-price">{Number(result.forecast_value ?? 0).toFixed(2)}</div>
            <div className="result-unit">USD / ton</div>
          </div>
          <p className="result-route-line">
            Route freight forecast for {result.commodity || "bulk cargo"} on {result.route || "selected route"}, {Number(result.cargo_weight_tons || 0).toLocaleString()} t, sailing {result.shipment_date || "—"}.
          </p>
          <div className="result-rulers">
            {result.distance_km != null && <span>{Number(result.distance_km).toLocaleString()} KM</span>}
            {result.estimated_transit_days != null && <span>{Number(result.estimated_transit_days).toFixed(1)} D TRANSIT</span>}
            <span>{result.contract_duration_months ? `${result.contract_duration_months} MO COA` : "SPOT VOYAGE"}</span>
          </div>
        </div>

        <div className="result-hero__right">
          <div className="result-metric">
            <div className="result-metric__head"><ShieldAlert className="result-icon result-icon--vermilion" /><span>Market risk</span></div>
            <Badge variant={riskVariant} className="result-risk-badge">{riskText[result.risk_label] || "Medium"}</Badge>
            <div className="result-metric__sub">Confidence {result.risk_confidence != null ? `${(result.risk_confidence * 100).toFixed(1)}%` : "—"} · volatility from {result.route || "route"} history</div>
          </div>
          <VesselBlock result={result} />
          <div className="result-metric">
            <div className="result-metric__head"><CalendarClock className="result-icon result-icon--brass" /><span>Charter window</span></div>
            <div className="result-window">{result.charter_window || "Monitor the next market window"}</div>
            <div className="result-metric__sub">{result.charter_rationale || "Based on the projected rate trend and market conditions."}</div>
          </div>
        </div>
      </section>

      <section className="analyst-read">
        <div>
          <div className="result-kicker">Analyst read · generated from model output</div>
          <p className="analyst-read__text">{result.reasoning || `For ${result.commodity || "this cargo"} into ${result.destination_port || "the destination"}, the route freight rate is forecast at about $${Number(result.forecast_value ?? 0).toFixed(2)}/t. Market risk is ${riskText[result.risk_label] || "medium"}. ${result.charter_window || "Review the projected charter window"}.`}</p>
        </div>
      </section>

      {(result.origin_port_info?.name || result.destination_port_info?.name) && (
        <section className="voyage-plot">
          <div className="voyage-plot__header">
            <div className="result-kicker">Voyage plot — {result.route || "selected route"}</div>
            <div className="result-kicker">{isSlow ? "Lite mode — map skipped" : "Great-circle track"}</div>
          </div>
          {isSlow ? (
            // Lite mode: Leaflet's OSM tiles are a burst of small image
            // requests per view — exactly the kind of thing worth skipping
            // on a slow/offline connection. The route text stands in for it.
            <div className="voyage-plot__map flex flex-col items-center justify-center gap-1 border border-dashed border-rule/40 bg-parchment/60 text-center">
              <MapIcon className="h-5 w-5 text-rule" />
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-inksoft">
                {result.origin_port_info?.name || "Origin"} → {result.destination_port_info?.name || "Destination"}
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-rule">map tiles skipped to save bandwidth</span>
            </div>
          ) : (
            <div className="voyage-plot__map">
              <RouteMap origin={result.origin_port_info?.name} destination={result.destination_port_info?.name} className="h-full w-full" />
            </div>
          )}
        </section>
      )}

      <WideSection eyebrow="Forecast basis" title="What shaped this forecast">
        <div className="result-two-col">
          <div className="result-paper-card"><div className="result-label">What is predicted</div><div className="result-paper-value">{result.forecast_basis || (result.forecast_type === "route_specific" ? "Verified route freight" : "Synthetic route freight rate (MVP)")}</div><div className="result-paper-sub">{result.forecast_source || "Route freight observations"}</div></div>
          <div className="result-paper-card"><div className="result-label">Data quality</div><div className="result-paper-value">{(result.data_confidence || "medium").toUpperCase()} · {(result.training_data_mode || "unknown").toUpperCase()}</div><div className="result-paper-sub">Latest feature date: {result.latest_feature_date || "—"} · Risk reliability: {result.risk_reliability || "—"}</div></div>
        </div>
      </WideSection>

      {result.forecast_curve?.length > 0 && <WideSection eyebrow="Multi-horizon outlook" title="Projected movement across the next horizons">
        <div className="result-three-col">{result.forecast_curve.map((p, i) => <div className="result-paper-card" key={i}><div className="result-paper-sub">{p.date}</div><div className="result-paper-value">{typeof p.predicted_rate === "number" ? `$${p.predicted_rate.toFixed(2)}/t` : "—"}</div>{p.lower_bound != null && p.upper_bound != null && <div className="result-paper-sub">${p.lower_bound.toFixed(2)}–${p.upper_bound.toFixed(2)}/t</div>}</div>)}</div>
      </WideSection>}

      {(result.origin_port_info || result.destination_port_info) && <WideSection eyebrow="Vessel fit" title="Port constraints and vessel feasibility">
        <div className="result-two-col">
          <div className="result-paper-card"><div className="result-label">Load port</div><div className="result-paper-value">{result.origin_port_info?.name || "—"}</div><div className="result-paper-sub">{result.origin_port_info?.known ? `Draft ${result.origin_port_info.max_draft_m}m · LOA ${result.origin_port_info.max_loa_m}m · Beam ${result.origin_port_info.max_beam_m}m` : "No infrastructure data on file."}</div></div>
          <div className="result-paper-card"><div className="result-label">Discharge port</div><div className="result-paper-value">{result.destination_port_info?.name || "—"}</div><div className="result-paper-sub">{result.destination_port_info?.known ? `Draft ${result.destination_port_info.max_draft_m}m · LOA ${result.destination_port_info.max_loa_m}m · Beam ${result.destination_port_info.max_beam_m}m` : "No infrastructure data on file."}</div></div>
        </div>
      </WideSection>}

      {result.idle_management_advice && <WideSection eyebrow="Idle scenario management" title="Turnaround and idle-time guidance"><p className="result-copy"><TimerReset className="inline-icon" /> {result.idle_management_advice}</p></WideSection>}
      {(result.transit_note || result.stowage_note) && <WideSection eyebrow="Transit & stowage" title="Voyage operating notes"><p className="result-copy"><Route className="inline-icon" /> {result.transit_note}</p>{result.stowage_note && <p className="result-copy mt-2">{result.stowage_note}</p>}</WideSection>}
      {result.congestion_warning && <WideSection eyebrow="Risk mitigation" title="Congestion early warning"><p className="result-copy"><RadioTower className="inline-icon" /> {result.congestion_warning}</p></WideSection>}
      {result.contracting_strategy && <WideSection eyebrow="Spot → short/mid-term contracting" title="Contracting strategy"><p className="result-copy"><Anchor className="inline-icon" /> {result.contracting_strategy}</p></WideSection>}

      {(result.feature_importance?.length > 0 || result.top_drivers?.length > 0) && <WideSection eyebrow="Why this forecast" title="Model explainability">
        <div className="result-two-col">
          {result.top_drivers?.length > 0 && <div><div className="result-label">Top drivers</div>{result.top_drivers.map((d) => <div className="driver-row" key={d.feature}><div className="driver-row__top"><span>{d.feature}</span><span>{d.direction}</span></div><div className="result-paper-sub">Value {d.value} vs typical {d.typical_value}</div></div>)}</div>}
          {result.feature_importance?.length > 0 && <div><div className="result-label">Global feature importance</div>{result.feature_importance.map((f) => <div className="importance-row" key={f.feature}><span>{f.feature}</span><div><div className="importance-bar"><i style={{ width: `${Math.min(100, f.importance * 100)}%` }} /></div></div><b>{(f.importance * 100).toFixed(0)}%</b></div>)}</div>}
        </div>
        <p className="result-footnote">Local drivers are a lightweight importance × deviation-from-typical estimate, not a full SHAP attribution.</p>
      </WideSection>}
    </motion.div>
  );
}
