// backend/src/routes/analysis.js
// NEW — decision-support endpoints that sit alongside /forecast but don't
// write a full forecast_requests/forecast_results row each call:
//   POST /api/compare-origins    (2) rank every loading port for one cargo
//   POST /api/idle-alternatives  (6) rank next-best ports for an idle vessel
//   POST /api/whatif             (5) lightweight re-run of the decision
//                                 engine for a what-if / sensitivity slider
const express = require("express");
const axios = require("axios");
const { decisionLimiter } = require("../middleware/rateLimit");
const { ML_SERVICE_URL, withRetry, sendMlError } = require("../utils/mlClient");

const router = express.Router();

function badRequest(res, err) {
  const detail = err.response?.data?.detail;
  return res.status(400).json({
    error: Array.isArray(detail)
      ? detail.map((d) => d.msg || JSON.stringify(d)).join(", ")
      : detail || "Request failed",
  });
}

// POST /api/compare-origins
router.post("/compare-origins", decisionLimiter, async (req, res) => {
  const { commodity, destination_port, shipment_date, cargo_weight_tons, vessel_type, contract_duration_months, total_program_tons } = req.body;

  if (!commodity || !destination_port || !shipment_date || !cargo_weight_tons) {
    return res.status(400).json({
      error: "commodity, destination_port, shipment_date, and cargo_weight_tons are required",
    });
  }

  try {
    const { data } = await withRetry(
      (timeout) =>
        axios.post(
          `${ML_SERVICE_URL}/compare-origins`,
          {
            commodity,
            destination_port,
            shipment_date,
            cargo_weight_tons: Number(cargo_weight_tons),
            vessel_type: vessel_type || undefined,
            contract_duration_months: contract_duration_months ? Number(contract_duration_months) : undefined,
            total_program_tons: total_program_tons ? Number(total_program_tons) : undefined,
          },
          { timeout }
        ),
      // BUGFIX: compare-origins fans out across every loading port (11
      // today) inside ml-service, each doing a model .predict() plus a
      // live AIS lookup. Even on a fully warm instance that's real work,
      // not a cold start — the old 8000ms initialTimeout (sized for a
      // single-origin /forecast call) meant compare-origins routinely blew
      // past it on a normal, warm request, which triggered the cold-start
      // retry path and made every call look like "waking up" even when
      // ml-service was already awake. Give this endpoint room sized for
      // its actual fan-out instead of reusing the single-origin default.
      { initialTimeout: 20000 }
    );
    res.json(data);
  } catch (err) {
    if (err.response?.status === 400) return badRequest(res, err);
    console.error("compare-origins call failed:", err.message);
    sendMlError(res, err, "Comparison service is temporarily unavailable. Please try again shortly.");
  }
});

// POST /api/idle-alternatives
router.post("/idle-alternatives", decisionLimiter, async (req, res) => {
  const { current_port, vessel_type, commodity, cargo_weight_tons } = req.body;

  if (!current_port) {
    return res.status(400).json({ error: "current_port is required" });
  }

  try {
    const { data } = await withRetry(
      (timeout) =>
        axios.post(
          `${ML_SERVICE_URL}/idle-alternatives`,
          {
            current_port,
            vessel_type: vessel_type || undefined,
            commodity: commodity || undefined,
            cargo_weight_tons: cargo_weight_tons ? Number(cargo_weight_tons) : undefined,
          },
          { timeout }
        ),
      // BUGFIX: same fan-out issue as /compare-origins, actually worse in
      // the common case — up to 10 origins x 3 commodities = 30 model
      // calls when no commodity filter is given. The old 8000ms default
      // (sized for a single /forecast call) meant this almost always got
      // misdiagnosed as a cold start on a fully warm instance.
      // Keep the total browser-facing request budget safely below Render's
      // proxy window: quick warm probe first, then one longer cold-start
      // attempt. The previous 20s + 80s combination was already over 100s
      // once the retry backoff was included.
      { initialTimeout: 8000, retries: 1, coldTimeout: 70000 }
    );
    res.json(data);
  } catch (err) {
    if (err.response?.status === 400) return badRequest(res, err);
    console.error("idle-alternatives call failed:", err.message);
    sendMlError(res, err, "Idle-vessel service is temporarily unavailable. Please try again shortly.");
  }
});

// POST /api/whatif — same request shape as /forecast, but proxies straight
// to the ML service's lightweight /recommend and never touches the DB, so
// a slider can fire many of these per second without piling up history rows.
router.post("/whatif", decisionLimiter, async (req, res) => {
  const {
    commodity,
    origin_port,
    destination_port,
    shipment_date,
    cargo_weight_tons,
    vessel_type,
    contract_duration_months,
    total_program_tons
  } = req.body;

  if (!commodity || !origin_port || !destination_port || !shipment_date || !cargo_weight_tons) {
    return res.status(400).json({
      error: "commodity, origin_port, destination_port, shipment_date, and cargo_weight_tons are required",
    });
  }

  try {
    const { data } = await withRetry(
      (timeout) =>
        axios.post(
          `${ML_SERVICE_URL}/recommend`,
          {
            commodity,
            origin_port,
            destination_port,
            shipment_date,
            cargo_weight_tons: Number(cargo_weight_tons),
            vessel_type: vessel_type || undefined,
            contract_duration_months: contract_duration_months ? Number(contract_duration_months) : undefined,
            total_program_tons: total_program_tons ? Number(total_program_tons) : undefined,
          },
          { timeout }
        ),
      { initialTimeout: 6000, retries: 1, coldTimeout: 20000 }
    );
    res.json(data);
  } catch (err) {
    if (err.response?.status === 400) return badRequest(res, err);
    console.error("whatif call failed:", err.message);
    sendMlError(res, err, "Forecast service is temporarily unavailable. Please try again shortly.");
  }
});

module.exports = router;