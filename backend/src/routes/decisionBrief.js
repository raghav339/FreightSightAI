// backend/src/routes/decisionBrief.js
//
// GET /api/forecast/:resultId/decision-brief[?cargo_weight_tons=&contract_duration_months=]
//
// One click from a saved forecast to a single forwardable PDF: the forecast,
// the what-if scenario (cargo / contract length, as set on the sliders) and
// the decision-simulator comparison (multi-voyage COA and loading-port
// comparison), reduced to one recommendation.
//
// The comparisons are recomputed here from the ml-service rather than posted
// up by the browser, so the numbers in the PDF cannot be edited client-side
// and the brief works from any saved forecast id (e.g. from History), not
// only while the dashboard is open.
//
// Visibility matches GET /forecast/:id/pdf (see utils/forecastLookup.js).
const express = require("express");
const axios = require("axios");
const { optionalAuth } = require("../middleware/auth");
const { decisionBriefLimiter } = require("../middleware/rateLimit");
const { ML_SERVICE_URL, withRetry, sendMlError } = require("../utils/mlClient");
const { loadForecastRow, normalizeForecastRow } = require("../utils/forecastLookup");
const { buildDecisionBrief } = require("../utils/decisionBrief");
const { renderDecisionBriefPdf } = require("../utils/decisionBriefPdf");

const router = express.Router();

const MAX_CARGO_TONS = 50_000_000;
const MAX_CONTRACT_MONTHS = 36; // ml-service COAOptimizeRequest: le=36

// Three calls run in parallel, so the worst case is one call's budget:
// 20s warm probe + 1.2s backoff + 55s cold retry = ~76s, under Render's ~100s
// proxy window.
const CALL_OPTS = { initialTimeout: 20000, retries: 1, coldTimeout: 55000 };

function mlPost(path, body) {
  return withRetry((timeout) => axios.post(`${ML_SERVICE_URL}${path}`, body, { timeout }), CALL_OPTS);
}

function mlGet(path) {
  return withRetry((timeout) => axios.get(`${ML_SERVICE_URL}${path}`, { timeout }), CALL_OPTS);
}

function detailOf(err) {
  const d = err?.response?.data?.detail;
  if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join(", ");
  return d || err?.message || "request failed";
}

// A comparison that fails is not fatal on its own: the brief says which
// option could not be evaluated and recommends among the rest.
async function settle(promise, label) {
  try {
    const { data } = await promise;
    return { status: "ok", data };
  } catch (err) {
    return { status: "unavailable", reason: `${label} unavailable: ${detailOf(err)}`, error: err };
  }
}

function parseOptionalNumber(raw, { field, min, max, exclusiveMin = false }) {
  if (raw === undefined || raw === null || raw === "") return { value: undefined };
  const n = Number(raw);
  const below = exclusiveMin ? n <= min : n < min;
  if (!Number.isFinite(n) || below || n > max) {
    return { error: `${field} must be a number ${exclusiveMin ? ">" : ">="} ${min} and <= ${max}` };
  }
  return { value: n };
}

router.get("/forecast/:resultId/decision-brief", decisionBriefLimiter, optionalAuth, async (req, res) => {
  const resultId = Number.parseInt(req.params.resultId, 10);
  if (!Number.isFinite(resultId)) {
    return res.status(400).json({ error: "resultId must be a number" });
  }

  const cargoQ = parseOptionalNumber(req.query.cargo_weight_tons, {
    field: "cargo_weight_tons", min: 0, max: MAX_CARGO_TONS, exclusiveMin: true,
  });
  const durQ = parseOptionalNumber(req.query.contract_duration_months, {
    field: "contract_duration_months", min: 0, max: MAX_CONTRACT_MONTHS,
  });
  if (cargoQ.error || durQ.error) {
    return res.status(400).json({ error: cargoQ.error || durQ.error });
  }

  let row;
  try {
    row = await loadForecastRow(resultId, req.user?.id);
  } catch (err) {
    console.error("decision brief lookup failed:", err.message);
    return res.status(500).json({ error: "Could not load forecast for decision brief" });
  }
  if (!row) return res.status(404).json({ error: "Forecast result not found" });

  const forecast = normalizeForecastRow(row);
  const scenario = {
    base_cargo_tons: forecast.base_cargo_tons,
    base_duration_months: forecast.base_duration_months,
    cargo_tons: cargoQ.value ?? forecast.base_cargo_tons,
    duration_months: durQ.value ?? forecast.base_duration_months,
  };
  scenario.changed =
    scenario.cargo_tons !== scenario.base_cargo_tons ||
    scenario.duration_months !== scenario.base_duration_months;

  if (!scenario.cargo_tons || scenario.cargo_tons <= 0) {
    return res.status(400).json({ error: "This forecast has no valid cargo weight to build a brief from" });
  }
  // ml-service rejects a program smaller than one lift; say so plainly.
  if (forecast.total_program_tons && scenario.cargo_tons > forecast.total_program_tons) {
    return res.status(400).json({
      error: `cargo_weight_tons (${scenario.cargo_tons}) cannot exceed the total program (${forecast.total_program_tons} t)`,
    });
  }

  const lane = {
    commodity: forecast.commodity,
    origin_port: forecast.origin_port,
    destination_port: forecast.destination_port,
    shipment_date: forecast.shipment_date,
  };
  const program = forecast.total_program_tons || undefined;
  const duration = scenario.duration_months || undefined;

  // What-if is only needed when the scenario differs from the saved forecast.
  // It IS required then: without it the scenario's vessel fit is unknown.
  const whatifCall = scenario.changed
    ? mlPost("/recommend", {
        ...lane,
        cargo_weight_tons: scenario.cargo_tons,
        contract_duration_months: duration,
        total_program_tons: program,
      })
    : null;

  // Same inputs the Decision simulator sends, so UI and PDF agree.
  const coaCall = mlPost("/coa-optimize", {
    ...lane,
    cargo_weight_tons: scenario.cargo_tons,
    total_program_tons: program,
    contract_duration_months: scenario.duration_months || 1,
  });
  const compareCall = mlPost("/compare-origins", {
    commodity: lane.commodity,
    destination_port: lane.destination_port,
    shipment_date: lane.shipment_date,
    cargo_weight_tons: scenario.cargo_tons,
    contract_duration_months: duration,
    total_program_tons: program,
  });

  // Live AIS port conditions. Optional: the brief is complete without them,
  // it just cannot flag a congested port.
  const radarCall = mlGet("/ais/port-radar");

  const [whatifR, coa, compare, radar] = await Promise.all([
    whatifCall ? settle(whatifCall, "What-if") : Promise.resolve(null),
    settle(coaCall, "Multi-voyage contract pricing"),
    settle(compareCall, "Origin comparison"),
    settle(radarCall, "Port radar"),
  ]);

  if (whatifR && whatifR.status !== "ok") {
    console.error("decision brief what-if failed:", whatifR.error?.message);
    return sendMlError(res, whatifR.error, "Forecast service is temporarily unavailable. Please try again shortly.");
  }
  if (coa.status !== "ok" && compare.status !== "ok") {
    // Nothing to compare against. A pure input problem (400) is passed on as
    // such; anything else is the service being down or cold.
    const fatal = [coa, compare].find((r) => r.error?.response?.status !== 400) || compare;
    console.error("decision brief comparisons failed:", fatal.error?.message);
    return sendMlError(res, fatal.error, "Decision service is temporarily unavailable. Please try again shortly.");
  }

  let pdf;
  try {
    const brief = buildDecisionBrief({
      forecast,
      scenario,
      whatif: whatifR ? whatifR.data : null,
      coa,
      compare,
      radar,
    });
    pdf = await renderDecisionBriefPdf(brief);
  } catch (err) {
    console.error("decision brief build/render failed:", err);
    return res.status(500).json({ error: "Could not generate the decision brief" });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdf.length);
  res.setHeader("Content-Disposition", `attachment; filename="freightsight-decision-brief-${resultId}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  return res.end(pdf);
});

module.exports = router;
