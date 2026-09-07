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

module.exports = router;
