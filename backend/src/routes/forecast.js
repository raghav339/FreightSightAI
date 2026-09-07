// ================================================================
// FILE: backend/src/routes/forecast.js
// ================================================================
// backend/src/routes/forecast.js
const express = require("express");
const axios = require("axios");
const db = require("../db");
const validateForecast = require("../middleware/validateForecast");
const { optionalAuth } = require("../middleware/auth");
const { decisionLimiter } = require("../middleware/rateLimit");
const { ML_SERVICE_URL, withRetry, sendMlError, isColdStartFailure } = require("../utils/mlClient");

const router = express.Router();

router.post("/forecast", decisionLimiter, optionalAuth, validateForecast, async (req, res) => {
  const {
    commodity,
    origin_port,
    destination_port,
    shipment_date,
    cargo_weight_tons,
    cargo_volume_cbm,
    shipment_mode,
    vessel_type,
    distance_km,
    delay_days,
    // Objective: spot -> short/mid-term multi-voyage (COA) contracting
    contract_duration_months,
    total_program_tons,
  } = req.body;

  let requestId;
  try {
    // 1. Save the input
    const insertReq = await db.run(
      `INSERT INTO forecast_requests
       (commodity, origin_port, destination_port, shipment_date, cargo_weight_tons, cargo_volume_cbm,
        shipment_mode, vessel_type, distance_km, delay_days, contract_duration_months, total_program_tons, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        commodity,
        origin_port,
        destination_port,
        shipment_date,
        cargo_weight_tons,
        cargo_volume_cbm ?? null,
        shipment_mode,
        vessel_type ?? null,
        distance_km ?? null,
        delay_days ?? 0,
        contract_duration_months ?? null,
        total_program_tons ?? null,
        req.user?.id ?? null,
      ]
    );
    requestId = insertReq.lastID;
  } catch (err) {
    console.error("Failed to save forecast request:", err.message);
    return res.status(500).json({ error: "Could not save request" });
  }

  // 2. Forward to the ML service
  let mlResult;
  try {
    const { data } = await withRetry(
      (timeout) =>
        axios.post(
          `${ML_SERVICE_URL}/forecast`,
          {
            commodity,
            origin_port,
            destination_port,
            shipment_date,
            cargo_weight_tons: Number(cargo_weight_tons),
            cargo_volume_cbm: cargo_volume_cbm ? Number(cargo_volume_cbm) : undefined,
            shipment_mode,
            vessel_type: vessel_type || undefined,
            distance_km: distance_km ? Number(distance_km) : undefined,
            delay_days: delay_days ? Number(delay_days) : 0,
            contract_duration_months: contract_duration_months ? Number(contract_duration_months) : undefined,
            total_program_tons: total_program_tons ? Number(total_program_tons) : undefined,
            // and this record's later PDF export always agree.
          },
          { timeout }
        ),
      { initialTimeout: 8000 }
    );
    mlResult = data;

    if (
      !mlResult ||
      typeof mlResult.route !== "string" ||
      typeof mlResult.predicted_freight_rate_usd_per_ton !== "number" ||
      !["low", "medium", "high"].includes(mlResult.risk_label)
    ) {
        throw new Error("ML service returned an invalid forecast payload");
    }
    
  } catch (err) {
    // 8. Error handling: ML service failed -> fallback message + log the failure
    console.error("ML service call failed:", err.message);
    await db
      .run(
        `INSERT INTO alerts (route, alert_type, message) VALUES (?, ?, ?)`,
        [
          `${origin_port}-${destination_port}`,
          "volatility",
          `ML service unavailable for request #${requestId}`,
        ]
      )
      .catch(() => {});
    const cold = isColdStartFailure(err);
    if (cold) res.set("Retry-After", "10");
    return res.status(cold ? 503 : 502).json({
      error: cold
        ? "Forecast service is starting up (cold instance) — please retry in a few seconds."
        : "Forecast service is temporarily unavailable. Please try again shortly.",
      retryable: cold,
      request_id: requestId,
    });
  }

  // 3. Save the returned forecast (full SIH26006 payload — vessel/port
  // feasibility, idle-time advice, congestion warning, contracting strategy)
  let resultId;
  try {
    const insertResult = await db.run(
      `INSERT INTO forecast_results
       (request_id, route, predicted_freight_rate_usd_per_ton, risk_label, risk_confidence,
        recommended_vessel_type, recommended_charter_window, summary, trend_points,
        feasible_vessel_types, vessel_constraint_note, origin_port_info, destination_port_info,
        port_turnaround_days, idle_management_advice, congestion_warning, contracting_strategy,
        feature_importance, top_drivers, forecast_type, data_confidence, data_source_level,
        vessel_status, vessel_rejection_reason, rejected_vessel_types, forecast_curve,
        recommended_vessel_reason, port_data_warning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        mlResult.route,
        mlResult.predicted_freight_rate_usd_per_ton,
        mlResult.risk_label,
        mlResult.risk_confidence,
        mlResult.recommended_vessel_type,
        mlResult.recommended_charter_window,
        mlResult.summary,
        JSON.stringify(mlResult.trend_points),
        JSON.stringify(mlResult.feasible_vessel_types ?? []),
        mlResult.vessel_constraint_note ?? null,
        JSON.stringify(mlResult.origin_port_info ?? null),
        JSON.stringify(mlResult.destination_port_info ?? null),
        mlResult.port_turnaround_days ?? null,
        mlResult.idle_management_advice ?? null,
        mlResult.congestion_warning ?? null,
        mlResult.contracting_strategy ?? null,
        // (3) Explainability — top global drivers + per-request local drivers
        JSON.stringify(mlResult.feature_importance ?? []),
        JSON.stringify(mlResult.top_drivers ?? []),
        // (Phase 2/3) proxy vs route-specific transparency — the ML
        // service always computes these; they were previously silently
        // dropped here before ever reaching storage or the frontend.
        mlResult.forecast_type ?? null,
        mlResult.data_confidence ?? null,
        mlResult.data_source_level ?? null,
        // (Phase 6) both-port vessel feasibility outcome
        mlResult.vessel_status ?? null,
        mlResult.vessel_rejection_reason ?? null,
        JSON.stringify(mlResult.rejected_vessel_types ?? []),
        // (Phase 4) genuine multi-horizon forecast curve
        JSON.stringify(mlResult.forecast_curve ?? []),
        // Preserve decision-quality explanation/disclaimer fields in history.
        mlResult.recommended_vessel_reason ?? null,
        mlResult.port_data_warning ?? null,
      ]
    );
    resultId = insertResult.lastID;

    // raise an alert automatically for high-risk routes
    if (mlResult.risk_label === "high") {
      await db.run(
        `INSERT INTO alerts (route, alert_type, message, forecast_result_id) VALUES (?, ?, ?, ?)`,
        [mlResult.route, "high_risk", `High risk detected on ${mlResult.route}: ${mlResult.summary}`, resultId]
      );
    }
  } catch (err) {
      console.error("Failed to save forecast result:", err.message);

      return res.status(500).json({
        error: "Forecast was generated but could not be saved.",
        request_id: requestId,
      });
    }

  // 4/6. Return one unified JSON response — includes the full SIH26006
  // deliverable set: (a) optimal entry timing, (b) vessel/port feasibility,
  // (c) idle-scenario management, (d) risk/congestion early warning, and the
  // spot -> short/mid-term COA contracting-strategy recommendation.
  return res.json({
    record_id: resultId ?? null,
    request_id: requestId,
    route: mlResult.route,
    forecast_value: mlResult.predicted_freight_rate_usd_per_ton,
    risk_label: mlResult.risk_label,
    risk_confidence: mlResult.risk_confidence,
    vessel_suggestion: mlResult.recommended_vessel_type,
    charter_window: mlResult.recommended_charter_window,
    reasoning: mlResult.summary,
    chart_values: mlResult.trend_points,

    // (b) Vessel Type Optimization — port-infrastructure-aware
    feasible_vessel_types: mlResult.feasible_vessel_types,
    vessel_constraint_note: mlResult.vessel_constraint_note,
    origin_port_info: mlResult.origin_port_info,
    destination_port_info: mlResult.destination_port_info,

    // (c) Idle Scenario Management
    port_turnaround_days: mlResult.port_turnaround_days,
    idle_management_advice: mlResult.idle_management_advice,

    // (d) Risk Mitigation / early warning
    congestion_warning: mlResult.congestion_warning,

    // Objective: spot -> short/mid-term multi-voyage contracting
    contracting_strategy: mlResult.contracting_strategy,

    // (3) Explainability — why the model produced this forecast
    feature_importance: mlResult.feature_importance ?? [],
    top_drivers: mlResult.top_drivers ?? [],

    // (Phase 2/3) proxy vs route-specific transparency — previously
    // computed by the ML service but silently dropped before reaching the
    // frontend. See README "Known limitations".
    forecast_type: mlResult.forecast_type,
    data_confidence: mlResult.data_confidence,
    data_source_level: mlResult.data_source_level,

    // (Phase 6) both-port vessel feasibility outcome
    vessel_status: mlResult.vessel_status,
    vessel_rejection_reason: mlResult.vessel_rejection_reason,
    rejected_vessel_types: mlResult.rejected_vessel_types ?? [],

    // (Phase 4) genuine multi-horizon forecast curve (H+1/H+2/H+3)
    forecast_curve: mlResult.forecast_curve ?? [],

    // BUGFIX: previously dropped here — see routes/pdf.js / ResultCards.jsx,
    // which both already expect these two fields.
    recommended_vessel_reason: mlResult.recommended_vessel_reason ?? null,
    port_data_warning: mlResult.port_data_warning ?? null,

    // A PDF report is available for every forecast, signed in or not — see
    // routes/pdf.js, which now allows anonymous downloads of anonymous
    // (user_id IS NULL) forecast records.
    report_available: true,
  });
});


// -------------------------------------------------------------------------
// Route-level AIS-enhanced freight proxy + COA optimizer.
// These endpoints are deliberately separate from /forecast because the
// legacy forecast response uses BDRY as a market proxy and should not be
// silently relabeled as a true route freight rate.
// -------------------------------------------------------------------------
router.post("/route-forecast", decisionLimiter, optionalAuth, async (req, res) => {
  try {
    const { data } = await withRetry(
      (timeout) =>
        axios.post(
          `${ML_SERVICE_URL}/route-forecast`,
          {
            commodity: req.body.commodity || "Coal",
            origin_port: req.body.origin_port,
            destination_port: req.body.destination_port,
            shipment_date: req.body.shipment_date,
            current_spot_rate_usd_per_ton: req.body.current_spot_rate_usd_per_ton
              ? Number(req.body.current_spot_rate_usd_per_ton) : undefined,
            vessel_type: req.body.vessel_type || undefined,
          },
          { timeout }
        ),
      { initialTimeout: 8000 }
    );
    return res.json(data);
  } catch (err) {
    console.error("Route forecast failed:", err.message);
    if (err.response?.status) {
      return res.status(err.response.status).json({ error: err.response.data?.detail || "Route forecast service is unavailable." });
    }
    return sendMlError(res, err, "Route forecast service is unavailable.");
  }
});

router.post("/coa-optimize", decisionLimiter, optionalAuth, async (req, res) => {
  try {
    const { data } = await withRetry(
      (timeout) =>
        axios.post(
          `${ML_SERVICE_URL}/coa-optimize`,
          {
            commodity: req.body.commodity || "Coal",
            origin_port: req.body.origin_port,
            destination_port: req.body.destination_port,
            shipment_date: req.body.shipment_date,
            current_spot_rate_usd_per_ton: req.body.current_spot_rate_usd_per_ton
              ? Number(req.body.current_spot_rate_usd_per_ton) : undefined,
            cargo_weight_tons: Number(req.body.cargo_weight_tons),
            total_program_tons: req.body.total_program_tons
              ? Number(req.body.total_program_tons) : undefined,
            contract_duration_months: req.body.contract_duration_months
              ? Number(req.body.contract_duration_months) : 3,
            vessel_type: req.body.vessel_type || undefined,
          },
          { timeout }
        ),
      { initialTimeout: 8000 }
    );
    return res.json(data);
  } catch (err) {
    console.error("COA optimization failed:", err.message);
    if (err.response?.status) {
      return res.status(err.response.status).json({ error: err.response.data?.detail || "COA optimization service is unavailable." });
    }
    return sendMlError(res, err, "COA optimization service is unavailable.");
  }
});

module.exports = router;