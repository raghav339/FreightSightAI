// AISStream proxy routes. The browser talks to FreightSight only; the
// AISStream API key stays in the ML-service environment.
const express = require("express");
const axios = require("axios");
const { ML_SERVICE_URL, withRetry, sendMlError } = require("../utils/mlClient");

const router = express.Router();

router.get("/ais/status", async (req, res) => {
  try {
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/ais/status`, { timeout }),
      { initialTimeout: 10000 }
    );
    res.json(data);
  } catch (err) {
    console.error("AIS status failed:", err.message);
    sendMlError(res, err, "Could not load AISStream status");
  }
});

router.get("/ais/idle-vessels", async (req, res) => {
  const { lookback_hours, min_idle_hours, port, limit, cargo_only } = req.query;
  try {
    const params = {};
    if (lookback_hours !== undefined) params.lookback_hours = lookback_hours;
    if (min_idle_hours !== undefined) params.min_idle_hours = min_idle_hours;
    if (port !== undefined && port !== "") params.port = port;
    if (limit !== undefined) params.limit = limit;
    if (cargo_only !== undefined) params.cargo_only = cargo_only;
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/ais/idle-vessels`, { params, timeout }),
      { initialTimeout: 15000 }
    );
    res.json(data);
  } catch (err) {
    console.error("AIS idle vessels failed:", err.message);
    sendMlError(res, err, "Could not detect AIS-idle vessels");
  }
});

router.get("/ais/route-features", async (req, res) => {
  const { origin_port, destination_port, lookback_hours } = req.query;
  if (!origin_port || !destination_port) {
    return res.status(400).json({ error: "origin_port and destination_port are required" });
  }
  try {
    const params = { origin_port, destination_port };
    if (lookback_hours !== undefined) params.lookback_hours = lookback_hours;
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/ais/route-features`, { params, timeout }),
      { initialTimeout: 15000 }
    );
    res.json(data);
  } catch (err) {
    console.error("AIS route features failed:", err.message);
    sendMlError(res, err, "Could not load live AIS route features");
  }
});

router.get("/ais/positions", async (req, res) => {
  const { lookback_hours, port, limit } = req.query;
  try {
    const params = {};
    if (lookback_hours !== undefined) params.lookback_hours = lookback_hours;
    if (port !== undefined && port !== "") params.port = port;
    if (limit !== undefined) params.limit = limit;
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/ais/positions`, { params, timeout }),
      { initialTimeout: 15000 }
    );
    res.json(data);
  } catch (err) {
    console.error("AIS positions failed:", err.message);
    sendMlError(res, err, "Could not load live AIS vessel positions");
  }
});

router.get("/ais/ports", async (req, res) => {
  try {
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/ais/ports`, { timeout }),
      { initialTimeout: 10000 }
    );
    res.json(data);
  } catch (err) {
    console.error("AIS ports failed:", err.message);
    sendMlError(res, err, "Could not load tracked AIS ports");
  }
});

// Port Disruption Radar: "is this port abnormally congested right now compared
// with its own normal?" (ml-service computes it from AIS history; the rules and
// thresholds live in ml-service/app/port_radar.py). Results are cached for two
// minutes upstream, so a short browser cache is safe and keeps dashboards cheap.
function radarParams(query) {
  const params = {};
  if (query.window_hours !== undefined) params.window_hours = query.window_hours;
  if (query.baseline_days !== undefined) params.baseline_days = query.baseline_days;
  return params;
}

router.get("/ais/port-radar", async (req, res) => {
  try {
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/ais/port-radar`, { params: radarParams(req.query), timeout }),
      { initialTimeout: 25000 }
    );
    res.set("Cache-Control", "private, max-age=60").json(data);
  } catch (err) {
    console.error("AIS port radar failed:", err.message);
    sendMlError(res, err, "Could not load the port disruption radar");
  }
});

router.get("/ais/port-radar/:port", async (req, res) => {
  const port = String(req.params.port || "").trim();
  if (!port || port.length > 60) {
    return res.status(400).json({ error: "port is required" });
  }
  try {
    const { data } = await withRetry(
      (timeout) =>
        axios.get(`${ML_SERVICE_URL}/ais/port-radar/${encodeURIComponent(port)}`, { params: radarParams(req.query), timeout }),
      { initialTimeout: 25000 }
    );
    res.set("Cache-Control", "private, max-age=60").json(data);
  } catch (err) {
    console.error("AIS port radar (single port) failed:", err.message);
    sendMlError(res, err, "Could not load the port disruption radar");
  }
});

module.exports = router;
