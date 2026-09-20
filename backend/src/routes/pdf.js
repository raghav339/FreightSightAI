// backend/src/routes/pdf.js
// NEW — (4) downloadable one-pager for a saved forecast, so a logistics
// manager can share a specific recommendation without screenshotting the
// dashboard. Uses pdfkit (pure-JS, no native deps) to stream a PDF straight
// from the saved forecast_requests/forecast_results row.
const express = require("express");
const PDFDocument = require("pdfkit");
const { loadForecastRow } = require("../utils/forecastLookup");
const { optionalAuth } = require("../middleware/auth");
const L = require("../utils/pdfCopy");

const router = express.Router();

function parseJsonField(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function money(n) {
  return typeof n === "number" ? n.toFixed(2) : "—";
}

// GET /api/forecast/:resultId/pdf
// Anonymous and signed-in callers can both download. A forecast made while
// signed in (q.user_id set) is a private, account-owned artifact and stays
// restricted to its owner. A forecast made anonymously (q.user_id IS NULL)
// has no owner to restrict to, so anyone with the link can fetch its PDF —
// same visibility as the forecast result itself (report_available: true
// for every forecast, see routes/forecast.js).
router.get("/forecast/:resultId/pdf", optionalAuth, async (req, res) => {
  const resultId = Number.parseInt(req.params.resultId, 10);
  if (!Number.isFinite(resultId)) {
    return res.status(400).json({ error: "resultId must be a number" });
  }

  let row;
  try {
    row = await loadForecastRow(resultId, req.user?.id);
  } catch (err) {
    console.error("pdf lookup failed:", err.message);
    return res.status(500).json({ error: "Could not load forecast for PDF export" });
  }

  if (!row) {
    return res.status(404).json({ error: "Forecast result not found" });
  }


  const originInfo = parseJsonField(row.origin_port_info, {});
  const destInfo = parseJsonField(row.destination_port_info, {});
  const feasibleVessels = parseJsonField(row.feasible_vessel_types, []);
  const topDrivers = parseJsonField(row.top_drivers, []);
  const rejectedVessels = parseJsonField(row.rejected_vessel_types, []);
  const forecastCurve = parseJsonField(row.forecast_curve, []);

  const doc = new PDFDocument({ size: "A4", margin: 50 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="freightsight-forecast-${resultId}.pdf"`
  );
  doc.pipe(res);

  // Header
  doc.font("Helvetica");
  doc.fontSize(18).fillColor("#0f766e").text(L.title, { align: "left" }).moveDown(0.2);
  doc.fontSize(9).fillColor("#666666").text(L.subtitle).moveDown(1);

  doc
    .strokeColor("#dddddd")
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .stroke()
    .moveDown(0.8);

  // (Phase 2/21/22) Data-confidence / proxy disclaimer — shown prominently,
  // near the top, not buried. forecast_type/data_confidence/
  // data_source_level are stored on every forecast_results row (see
  // backend/src/routes/forecast.js); this was previously computed by the
  // ML service but discarded before it ever reached the PDF or the UI.
  if (row.forecast_type === "synthetic_route") {
    doc.fontSize(9).fillColor("#92400e").text(L.proxyDisclaimer, { width: 495 }).moveDown(0.4);
  }
  if (row.data_confidence || row.data_source_level) {
    doc
      .fontSize(9)
      .fillColor("#666666")
      .text(`${L.dataConfidence}: ${row.data_confidence || "—"}   ·   ${L.dataSourceLevel}: ${row.data_source_level || "—"}`)
      .moveDown(0.6);
  }

  // Route summary
  doc.fontSize(13).fillColor("#111111").text(`${L.route}: ${row.route}`, { continued: false });
  doc
    .fontSize(10)
    .fillColor("#333333")
    .text(
      `${L.commodity}: ${row.commodity}   ·   ${L.cargo}: ${Number(row.cargo_weight_tons).toLocaleString()} t   ·   ` +
        `${L.shipmentMonth}: ${row.shipment_date}   ·   ${L.mode}: ${row.shipment_mode}`
    )
    .moveDown(1);

  function section(title) {
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor("#0f766e").text(title);
    doc.fontSize(10).fillColor("#222222");
  }

  // (a) Rate / market timing
  section(L.rateForecast);
  doc.text(`${L.predictedRate}: $${money(row.predicted_freight_rate_usd_per_ton)}`);
  doc.text(`${L.marketRisk}: ${row.risk_label?.toUpperCase()} (${L.confidence} ${row.risk_confidence != null ? (row.risk_confidence * 100).toFixed(1) + "%" : "—"})`);
  doc.text(`${L.charterWindow}: ${row.recommended_charter_window || "—"}`);

  // (Phase 4) Multi-horizon forecast curve — H+1/H+2/H+3, each from its
  // own directly-trained model, not a relabeled single-step prediction.
  if (forecastCurve.length) {
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor("#333333").text(`${L.multiHorizonOutlook}:`);
    forecastCurve.forEach((p) => {
      const bounds =
        p.lower_bound != null && p.upper_bound != null
          ? ` (range $${money(p.lower_bound)}–$${money(p.upper_bound)})`
          : "";
      doc.text(`  • ${p.date || "—"}: $${money(p.predicted_rate)}${bounds} — ${L.confidence}: ${p.confidence || "—"}`);
    });
  }

  // (b) Vessel optimization
  section(L.vesselOptimization);
  doc.text(`${L.vesselStatus}: ${row.vessel_status || "—"}`);
  doc.text(`${L.recommendedVessel}: ${row.recommended_vessel_type || "—"}`);
  if (feasibleVessels.length) doc.text(`${L.feasible}: ${feasibleVessels.join(", ")}`);
  if (row.vessel_status === "NO_FEASIBLE_VESSEL" || row.vessel_rejection_reason) {
    doc.fillColor("#92400e").text(row.vessel_rejection_reason || L.noFeasibleVessel, { width: 495 });
    doc.fillColor("#222222");
  }
  if (rejectedVessels.length) {
    doc.fontSize(9).fillColor("#666666").text(`${L.rejectedVessels}:`);
    rejectedVessels.forEach((rv) => {
      doc.text(`  • ${rv.vessel_type || rv.name || "—"}: ${rv.rejection_reason || rv.reason || "—"}`);
    });
    doc.fontSize(10).fillColor("#222222");
  }
  if (row.vessel_constraint_note) doc.text(row.vessel_constraint_note, { width: 495 });
  doc.moveDown(0.3);
  doc.text(
    `${L.loadPort} (${row.origin_port}): draft ${originInfo.max_draft_m ?? "—"}m, LOA ${originInfo.max_loa_m ?? "—"}m, ` +
      `beam ${originInfo.max_beam_m ?? "—"}m, handling ${originInfo.cargo_handling_rate_tpd ?? "—"} t/day`
  );
  doc.text(
    `${L.dischargePort} (${row.destination_port}): draft ${destInfo.max_draft_m ?? "—"}m, LOA ${destInfo.max_loa_m ?? "—"}m, ` +
      `beam ${destInfo.max_beam_m ?? "—"}m, handling ${destInfo.cargo_handling_rate_tpd ?? "—"} t/day`
  );

  // (c) Idle scenario management
  section(L.idleManagement);
  doc.text(`${L.turnaround}: ${row.port_turnaround_days != null ? row.port_turnaround_days + " " + L.days : "—"}`);
  if (row.idle_management_advice) doc.text(row.idle_management_advice, { width: 495 });

  // (d) Risk mitigation
  section(L.riskMitigation);
  doc.text(row.congestion_warning || L.noCongestion, { width: 495 });

  // Objective: contracting strategy
  section(L.contractingStrategy);
  doc.text(row.contracting_strategy || "—", { width: 495 });
  if (row.contract_duration_months || row.total_program_tons) {
    doc.text(
      `${L.program}: ${row.contract_duration_months ? row.contract_duration_months + " " + L.months : "—"}, ` +
        `${row.total_program_tons ? Number(row.total_program_tons).toLocaleString() + " " + L.totalTons : ""}`
    );
  }

  // (3) Explainability
  if (topDrivers.length) {
    section(L.whyForecast);
    topDrivers.forEach((d) => {
      doc.text(
        `• ${d.feature}: ${d.value} (${d.direction}, typical ${d.typical_value}) — ${L.globalImportance} ${(d.global_importance * 100).toFixed(1)}%`
      );
    });
  }

  // Summary
  section(L.aiSummary);
  doc.text(row.summary || "—", { width: 495 });

  doc.moveDown(1.2);
  doc
    .fontSize(8)
    .fillColor("#999999")
    .text(
      `${L.footer} ${new Date().toISOString().slice(0, 10)} · ${L.footerRecord} #${resultId} · ${L.footerNote}`,
      { width: 495 }
    );

  doc.end();
});

module.exports = router;
