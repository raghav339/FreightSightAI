// backend/src/routes/calibration.js
//
// GET /api/calibration/summary — "here's how our past forecasts compared
// to actual market rates". Proxies ml-service GET /calibration/summary,
// which reshapes the held-out test-set metrics already computed at
// training time (route_freight_model.py's walk-forward evaluation) into a
// lane-level backtest: per-lane MAE against actual held-out observations,
// next to a naive-persistence baseline, so the chart shows real skill, not
// just "we have a model".
//
// Cached in memory: this only changes when the model is retrained, so
// there's no reason to re-fetch from ml-service on every page view.
"use strict";

const express = require("express");
const axios = require("axios");
const { ML_SERVICE_URL, withRetry, sendMlError } = require("../utils/mlClient");
const { createTtlCache } = require("../utils/ttlCache");

const router = express.Router();
const cache = createTtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 20 });

router.get("/calibration/summary", async (req, res) => {
  const horizon = String(req.query.horizon || "1");
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  const key = `${horizon}:${limit}`;

  try {
    const data = await cache.getOrCompute(key, async () => {
      const { data } = await withRetry(
        (timeout) => axios.get(`${ML_SERVICE_URL}/calibration/summary`, { timeout, params: { horizon, limit } }),
        { initialTimeout: 15000 }
      );
      return data;
    });
    res.json(data);
  } catch (err) {
    console.error("calibration summary: ml-service call failed:", err.message);
    sendMlError(res, err, "Could not load the calibration summary");
  }
});

module.exports = router;
