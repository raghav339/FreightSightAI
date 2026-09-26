// backend/src/routes/analysis.js
// NEW — decision-support endpoints that sit alongside /forecast but don't
// write a full forecast_requests/forecast_results row each call:
//   POST /api/compare-origins    (2) rank every loading port for one cargo
//   POST /api/idle-alternatives  (6) rank next-best ports for an idle vessel
//   POST /api/port-substitution  (7) "if this discharge port fails, where next?"
//   POST /api/whatif             (5) lightweight re-run of the decision
//                                 engine for a what-if / sensitivity slider
const express = require("express");
const axios = require("axios");
const { decisionLimiter } = require("../middleware/rateLimit");
const { ML_SERVICE_URL, withRetry, sendMlError } = require("../utils/mlClient");
const { createTtlCache } = require("../utils/ttlCache");

// Identical compare-origins / idle-alternatives requests within 2 minutes are
// answered from memory (see utils/ttlCache.js).
const compareCache = createTtlCache({ ttlMs: 120000 });
const idleCache = createTtlCache({ ttlMs: 120000 });
const substitutionCache = createTtlCache({ ttlMs: 120000 });
const disruptionCache = createTtlCache({ ttlMs: 120000 });
const liveDisruptionCache = createTtlCache({ ttlMs: 120000 });

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
    const cacheKey = JSON.stringify([commodity, destination_port, shipment_date, Number(cargo_weight_tons), vessel_type || null, contract_duration_months || null, total_program_tons || null]);
    const data = await compareCache.getOrCompute(cacheKey, async () => {
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
      // compare-origins fans out across every loading port (11 today)
      // inside ml-service, each doing a model .predict() plus a live AIS
      // lookup — real work even on a warm instance. Give this endpoint a
      // timeout sized for its actual fan-out rather than the single-origin
      // default, so a normal warm request doesn't get misread as a cold start.
      { initialTimeout: 20000 }
      );
      return data;
    });
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
    const cacheKey = JSON.stringify([current_port, vessel_type || null, commodity || null, cargo_weight_tons ? Number(cargo_weight_tons) : null, new Date().toISOString().slice(0, 10)]);
    const data = await idleCache.getOrCompute(cacheKey, async () => {
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
      // Same fan-out concern as /compare-origins, worse in the common
      // case — up to 10 origins x 3 commodities = 30 model calls when no
      // commodity filter is given. Keep the total browser-facing request
      // budget safely below Render's proxy window: a quick warm probe
      // first, then one longer cold-start attempt.
      { initialTimeout: 8000, retries: 1, coldTimeout: 70000 }
      );
      return data;
    });
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

// POST /api/port-substitution
// Port Substitution Engine: if `failed_port` becomes unavailable, rank the
// other discharge ports (vessel fit, draft/LOA, cargo capacity, congestion,
// distance, freight impact, delay, handling) and return a substitution map.
// Only failed_port is required; loading port + commodity add freight impact.
router.post("/port-substitution", decisionLimiter, async (req, res) => {
  const { failed_port, cargo_weight_tons, commodity, origin_port, shipment_date, vessel_type, max_distance_nm } = req.body || {};

  if (!failed_port || String(failed_port).trim().length === 0 || String(failed_port).length > 60) {
    return res.status(400).json({ error: "failed_port is required" });
  }
  const tons = cargo_weight_tons ? Number(cargo_weight_tons) : undefined;
  if (tons !== undefined && (!Number.isFinite(tons) || tons <= 0)) {
    return res.status(400).json({ error: "cargo_weight_tons must be a positive number" });
  }

  const payload = {
    failed_port: String(failed_port).trim(),
    cargo_weight_tons: tons,
    commodity: commodity || undefined,
    origin_port: origin_port || undefined,
    shipment_date: shipment_date || undefined,
    vessel_type: vessel_type || undefined,
    max_distance_nm: max_distance_nm ? Number(max_distance_nm) : undefined,
  };

  try {
    const cacheKey = JSON.stringify([payload, new Date().toISOString().slice(0, 10)]);
    const data = await substitutionCache.getOrCompute(cacheKey, async () => {
      const { data } = await withRetry(
        (timeout) => axios.post(`${ML_SERVICE_URL}/port-substitution`, payload, { timeout }),
        { initialTimeout: 20000, retries: 1, coldTimeout: 70000 }
      );
      return data;
    });
    res.json(data);
  } catch (err) {
    console.error("Port substitution failed:", err.message);
    if (err.response?.status === 400 || err.response?.status === 422) return badRequest(res, err);
    sendMlError(res, err, "Could not compute port substitutions");
  }
});

// POST /api/disruption/simulate
// Disruption Engine: simulate an event (cyclone, port closure, vessel
// shortage, freight spike, congestion surge) at a port and see the
// propagation to delay/freight, plus (for discharge ports) ranked
// alternatives from the Port Substitution Engine.
router.post("/disruption/simulate", decisionLimiter, async (req, res) => {
  const {
    event_type, port, severity, duration_days, origin_port, destination_port,
    commodity, shipment_date, cargo_weight_tons, stockpile_buffer_days, include_alternatives,
  } = req.body || {};

  if (!event_type || !port || severity === undefined || severity === null) {
    return res.status(400).json({ error: "event_type, port, and severity are required" });
  }
  const sev = Number(severity);
  if (!Number.isFinite(sev) || sev < 0 || sev > 100) {
    return res.status(400).json({ error: "severity must be a number between 0 and 100" });
  }

  const payload = {
    event_type, port, severity: sev,
    duration_days: duration_days ? Number(duration_days) : undefined,
    origin_port: origin_port || undefined,
    destination_port: destination_port || undefined,
    commodity: commodity || undefined,
    shipment_date: shipment_date || undefined,
    cargo_weight_tons: cargo_weight_tons ? Number(cargo_weight_tons) : undefined,
    stockpile_buffer_days: stockpile_buffer_days ? Number(stockpile_buffer_days) : undefined,
    include_alternatives: include_alternatives === undefined ? undefined : Boolean(include_alternatives),
  };

  try {
    const cacheKey = JSON.stringify([payload, new Date().toISOString().slice(0, 10)]);
    const data = await disruptionCache.getOrCompute(cacheKey, async () => {
      const { data } = await withRetry(
        (timeout) => axios.post(`${ML_SERVICE_URL}/disruption/simulate`, payload, { timeout }),
        { initialTimeout: 20000, retries: 1, coldTimeout: 70000 }
      );
      return data;
    });
    res.json(data);
  } catch (err) {
    console.error("Disruption simulation failed:", err.message);
    if (err.response?.status === 400 || err.response?.status === 422) return badRequest(res, err);
    sendMlError(res, err, "Could not simulate this disruption");
  }
});

// GET /api/disruption/event-types
router.get("/disruption/event-types", async (req, res) => {
  try {
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/disruption/event-types`, { timeout }),
      { initialTimeout: 8000 }
    );
    res.json(data);
  } catch (err) {
    sendMlError(res, err, "Could not load disruption event types");
  }
});

// POST /api/disruption/live
// Disruption Engine — Live mode: severity comes from a live marine-weather
// reading at the port (wind/wave/precipitation), not from the caller.
router.post("/disruption/live", decisionLimiter, async (req, res) => {
  const { port, duration_days, origin_port, destination_port, commodity, shipment_date, cargo_weight_tons, stockpile_buffer_days, include_alternatives } = req.body || {};

  if (!port || String(port).trim().length === 0 || String(port).length > 60) {
    return res.status(400).json({ error: "port is required" });
  }

  const payload = {
    port: String(port).trim(),
    duration_days: duration_days ? Number(duration_days) : undefined,
    origin_port: origin_port || undefined,
    destination_port: destination_port || undefined,
    commodity: commodity || undefined,
    shipment_date: shipment_date || undefined,
    cargo_weight_tons: cargo_weight_tons ? Number(cargo_weight_tons) : undefined,
    stockpile_buffer_days: stockpile_buffer_days ? Number(stockpile_buffer_days) : undefined,
    include_alternatives: include_alternatives === undefined ? undefined : Boolean(include_alternatives),
  };

  try {
    // Cache key buckets by 5-minute window (matches the ml-service's own
    // live-weather cache bucket) rather than by calendar day, since a live
    // reading goes stale much faster than a decision-support forecast.
    const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const cacheKey = JSON.stringify([payload, bucket]);
    const data = await liveDisruptionCache.getOrCompute(cacheKey, async () => {
      const { data } = await withRetry(
        (timeout) => axios.post(`${ML_SERVICE_URL}/disruption/live`, payload, { timeout }),
        { initialTimeout: 12000, retries: 1, coldTimeout: 70000 }
      );
      return data;
    });
    res.json(data);
  } catch (err) {
    console.error("Live disruption assessment failed:", err.message);
    if (err.response?.status === 400 || err.response?.status === 422) return badRequest(res, err);
    sendMlError(res, err, "Could not fetch live conditions for this port");
  }
});

module.exports = router;