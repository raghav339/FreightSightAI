import { useState } from "react";
import { motion } from "framer-motion";
import { Anchor, CalendarClock, Download, Map as MapIcon, RadioTower, Route, ShipWheel, ShieldAlert, TimerReset, WifiOff } from "lucide-react";
import { Badge } from "./ui/badge.jsx";
import { Button } from "./ui/button.jsx";
import RouteMap from "./ui/RouteMap.jsx";
import api from "../api/client.js";
import useNetworkStatus from "../hooks/useNetworkStatus.js";
import { useTranslation } from "react-i18next";
import { useLabels } from "../i18n/labels.js";

const RISK_VARIANT = { low: "low", medium: "medium", high: "high" };
const num = (n, opts) => Number(n).toLocaleString("en-US", opts);

function VesselBlock({ result }) {
  const { t } = useTranslation();
  const L = useLabels();
  const noFit = result.vessel_status === "NO_FEASIBLE_VESSEL";
  return (
    <div className="result-metric result-metric--vessel">
      <div className="result-metric__head"><ShipWheel className="result-icon result-icon--kelp" /><span>{t("result.recommendedVessel")}</span></div>
      <div className={`result-metric__value ${noFit ? "result-metric__value--warning" : ""}`}>{noFit ? t("result.noneFeasible") : (L.vessel(result.vessel_suggestion) || t("form.autoRecommend"))}</div>
      {!noFit && result.feasible_vessel_types?.length > 0 && <div className="result-metric__sub">{t("result.feasible", { list: result.feasible_vessel_types.map(L.vessel).join(", ") })}</div>}
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
  const { t, i18n } = useTranslation();
  const L = useLabels();
  const dateLocale = `${i18n.language}-u-nu-latn`;
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

  const proxyNotice = t("result.mvpNotice");

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }} className="flex flex-col gap-7">
      {result._cached && (
        <div className="fs-forecast-notice result-notice flex items-center gap-2">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            {result._approx
              ? t("result.cachedApprox")
              : t("result.cachedExact", { when: result._cachedAt ? ` (${new Date(result._cachedAt).toLocaleString(dateLocale)})` : "" })}
          </span>
        </div>
      )}

      {(result.forecast_type === "synthetic_route") && (
        <div className="fs-forecast-notice result-notice">{proxyNotice}</div>
      )}

      {reportAvailable && result.record_id && (
        <div className="flex justify-end">
          <Button variant="outline" className="gap-2" onClick={downloadPdf} disabled={pdfLoading}>
            <Download className="h-3.5 w-3.5" /> {pdfLoading ? t("result.preparing") : t("result.downloadPdf")}
          </Button>
        </div>
      )}

      <section className="result-hero">
        <div className="result-hero__left">
          <div className="result-kicker">{t("result.kicker")}</div>
          <div className="result-price-row">
            <div className="result-price">{Number(result.forecast_value ?? 0).toFixed(2)}</div>
            <div className="result-unit">{t("result.unit")}</div>
          </div>
          <p className="result-route-line">
            {t("result.routeLine", {
              commodity: L.commodity(result.commodity) || t("result.bulkCargo"),
              route: L.route(result.route) || t("result.selectedRoute"),
              weight: num(result.cargo_weight_tons || 0),
              date: result.shipment_date || "—",
            })}
          </p>
          <div className="result-rulers">
            {result.distance_km != null && <span>{t("result.km", { value: num(result.distance_km) })}</span>}
            {result.estimated_transit_days != null && <span>{t("result.transitDays", { value: Number(result.estimated_transit_days).toFixed(1) })}</span>}
            <span>{result.contract_duration_months ? t("result.moCoa", { value: result.contract_duration_months }) : t("result.spotVoyage")}</span>
          </div>
        </div>

        <div className="result-hero__right">
          <div className="result-metric">
            <div className="result-metric__head"><ShieldAlert className="result-icon result-icon--vermilion" /><span>{t("result.marketRisk")}</span></div>
            <Badge variant={riskVariant} className="result-risk-badge">{L.risk(result.risk_label) || L.risk("medium")}</Badge>
            <div className="result-metric__sub">{t("result.confidenceLine", { pct: result.risk_confidence != null ? `${(result.risk_confidence * 100).toFixed(1)}%` : "—", route: L.route(result.route) || t("result.routeWord") })}</div>
          </div>
          <VesselBlock result={result} />
          <div className="result-metric">
            <div className="result-metric__head"><CalendarClock className="result-icon result-icon--brass" /><span>{t("result.charterWindow")}</span></div>
            <div className="result-window">{result.charter_window || t("result.charterFallback")}</div>
            <div className="result-metric__sub">{result.charter_rationale || t("result.charterRationaleFallback")}</div>
          </div>
        </div>
      </section>

      <section className="analyst-read">
        <div>
          <div className="result-kicker">{t("result.analystKicker")}</div>
          <p className="analyst-read__text">{result.reasoning || t("result.analystFallback", {
            commodity: L.commodity(result.commodity) || t("result.thisCargo"),
            destination: L.port(result.destination_port) || t("result.theDestination"),
            rate: Number(result.forecast_value ?? 0).toFixed(2),
            risk: L.risk(result.risk_label) || L.risk("medium"),
            window: result.charter_window || t("result.reviewWindow"),
          })}</p>
        </div>
      </section>

      {(result.origin_port_info?.name || result.destination_port_info?.name) && (
        <section className="voyage-plot">
          <div className="voyage-plot__header">
            <div className="result-kicker">{t("result.voyagePlot", { route: L.route(result.route) || t("result.selectedRoute") })}</div>
            <div className="result-kicker">{isSlow ? t("result.liteMode") : t("result.greatCircle")}</div>
          </div>
          {isSlow ? (
            // Lite mode: Leaflet's OSM tiles are a burst of small image
            // requests per view — exactly the kind of thing worth skipping
            // on a slow/offline connection. The route text stands in for it.
            <div className="voyage-plot__map flex flex-col items-center justify-center gap-1 border border-dashed border-rule/40 bg-parchment/60 text-center">
              <MapIcon className="h-5 w-5 text-rule" />
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-inksoft">
                {L.port(result.origin_port_info?.name) || t("result.origin")} → {L.port(result.destination_port_info?.name) || t("result.destination")}
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-rule">{t("result.tilesSkipped")}</span>
            </div>
          ) : (
            <div className="voyage-plot__map">
              <RouteMap origin={result.origin_port_info?.name} destination={result.destination_port_info?.name} className="h-full w-full" />
            </div>
          )}
        </section>
      )}

      <WideSection eyebrow={t("result.basis.eyebrow")} title={t("result.basis.title")}>
        <div className="result-two-col">
          <div className="result-paper-card"><div className="result-label">{t("result.basis.predicted")}</div><div className="result-paper-value">{result.forecast_basis || (result.forecast_type === "route_specific" ? t("result.basis.verified") : t("result.basis.synthetic"))}</div><div className="result-paper-sub">{result.forecast_source || t("result.basis.observations")}</div></div>
          <div className="result-paper-card"><div className="result-label">{t("result.basis.quality")}</div><div className="result-paper-value">{t(`result.confidence.${result.data_confidence || "medium"}`, { defaultValue: String(result.data_confidence) })} · {t(`result.dataMode.${result.training_data_mode || "unknown"}`, { defaultValue: String(result.training_data_mode) })}</div><div className="result-paper-sub">{t("result.basis.latest", { date: result.latest_feature_date || "—", value: result.risk_reliability || "—" })}</div></div>
        </div>
      </WideSection>

      {result.forecast_curve?.length > 0 && <WideSection eyebrow={t("result.outlook.eyebrow")} title={t("result.outlook.title")}>
        <div className="result-three-col">{result.forecast_curve.map((p, i) => <div className="result-paper-card" key={i}><div className="result-paper-sub">{p.date}</div><div className="result-paper-value">{typeof p.predicted_rate === "number" ? `$${p.predicted_rate.toFixed(2)}/t` : "—"}</div>{p.lower_bound != null && p.upper_bound != null && <div className="result-paper-sub">${p.lower_bound.toFixed(2)}–${p.upper_bound.toFixed(2)}/t</div>}</div>)}</div>
      </WideSection>}

      {(result.origin_port_info || result.destination_port_info) && <WideSection eyebrow={t("result.fit.eyebrow")} title={t("result.fit.title")}>
        <div className="result-two-col">
          {[["loadPort", result.origin_port_info], ["dischargePort", result.destination_port_info]].map(([labelKey, info]) => (
            <div className="result-paper-card" key={labelKey}>
              <div className="result-label">{t(`result.fit.${labelKey}`)}</div>
              <div className="result-paper-value">{L.port(info?.name) || "—"}</div>
              <div className="result-paper-sub">{info?.known ? t("result.fit.limits", { draft: info.max_draft_m, loa: info.max_loa_m, beam: info.max_beam_m }) : t("result.fit.noData")}</div>
            </div>
          ))}
        </div>
      </WideSection>}

      {result.idle_management_advice && <WideSection eyebrow={t("result.idle.eyebrow")} title={t("result.idle.title")}><p className="result-copy"><TimerReset className="inline-icon" /> {result.idle_management_advice}</p></WideSection>}
      {(result.transit_note || result.stowage_note) && <WideSection eyebrow={t("result.transit.eyebrow")} title={t("result.transit.title")}><p className="result-copy"><Route className="inline-icon" /> {result.transit_note}</p>{result.stowage_note && <p className="result-copy mt-2">{result.stowage_note}</p>}</WideSection>}
      {result.congestion_warning && <WideSection eyebrow={t("result.risk.eyebrow")} title={t("result.risk.title")}><p className="result-copy"><RadioTower className="inline-icon" /> {result.congestion_warning}</p></WideSection>}
      {result.contracting_strategy && <WideSection eyebrow={t("result.contract.eyebrow")} title={t("result.contract.title")}><p className="result-copy"><Anchor className="inline-icon" /> {result.contracting_strategy}</p></WideSection>}

      {(result.feature_importance?.length > 0 || result.top_drivers?.length > 0) && <WideSection eyebrow={t("result.why.eyebrow")} title={t("result.why.title")}>
        <div className="result-two-col">
          {result.top_drivers?.length > 0 && <div><div className="result-label">{t("result.why.topDrivers")}</div>{result.top_drivers.map((d) => <div className="driver-row" key={d.feature}><div className="driver-row__top"><span>{d.feature}</span><span>{d.direction}</span></div><div className="result-paper-sub">{t("result.why.valueVsTypical", { value: d.value, typical: d.typical_value })}</div></div>)}</div>}
          {result.feature_importance?.length > 0 && <div><div className="result-label">{t("result.why.globalImportance")}</div>{result.feature_importance.map((f) => <div className="importance-row" key={f.feature}><span>{f.feature}</span><div><div className="importance-bar"><i style={{ width: `${Math.min(100, f.importance * 100)}%` }} /></div></div><b>{(f.importance * 100).toFixed(0)}%</b></div>)}</div>}
        </div>
        <p className="result-footnote">{t("result.why.footnote")}</p>
      </WideSection>}
    </motion.div>
  );
}
