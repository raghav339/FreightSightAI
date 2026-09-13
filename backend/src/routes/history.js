// ================================================================
// FILE: backend/src/routes/history.js
// ================================================================
// backend/src/routes/history.js
const express = require("express");
const db = require("../db");
const axios = require("axios");
const { requireAuth } = require("../middleware/auth");
const { ML_SERVICE_URL, withRetry } = require("../utils/mlClient");

const router = express.Router();

// GET /api/history — previous searches / predictions
router.get("/history", requireAuth, async (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);

  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 200)
    : 50;
  try {
    const rows = await db.query(
      `SELECT fr.id as result_id, fr.route, fr.predicted_freight_rate_usd_per_ton,
              fr.risk_label, fr.risk_confidence, fr.recommended_vessel_type,
              fr.recommended_charter_window, fr.summary, fr.trend_points, fr.created_at,
              fr.feasible_vessel_types, fr.vessel_constraint_note,
              fr.origin_port_info, fr.destination_port_info,
              fr.port_turnaround_days, fr.idle_management_advice,
              fr.congestion_warning, fr.contracting_strategy,
              q.commodity, q.origin_port, q.destination_port, q.shipment_date, q.cargo_weight_tons,
              q.shipment_mode, q.contract_duration_months, q.total_program_tons
       FROM forecast_results fr
       JOIN forecast_requests q ON q.id = fr.request_id
       WHERE q.user_id = ?
       ORDER BY fr.created_at DESC
       LIMIT ?`,
      [req.user.id, limit]
    );
    const parseJsonField = (v) => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    };
    const parsed = rows.map((r) => ({
      ...r,
      trend_points: parseJsonField(r.trend_points),
      feasible_vessel_types: parseJsonField(r.feasible_vessel_types),
      origin_port_info: parseJsonField(r.origin_port_info),
      destination_port_info: parseJsonField(r.destination_port_info),
    }));
    res.json(parsed);
  } catch (err) {
    console.error("history query failed:", err.message);
    res.status(500).json({ error: "Could not fetch history" });
  }
});

// GET /api/dashboard-summary — aggregate data for charts
router.get("/dashboard-summary", async (req, res) => {
  try {
    const byRoute = await db.query(
      `SELECT route,
              COUNT(*) as forecast_count,
              AVG(predicted_freight_rate_usd_per_ton) as avg_rate,
              SUM(CASE WHEN risk_label = 'high' THEN 1 ELSE 0 END) as high_risk_count
       FROM forecast_results
       GROUP BY route
       ORDER BY forecast_count DESC`
    );

    const riskDistribution = await db.query(
      `SELECT risk_label, COUNT(*) as count
       FROM forecast_results
       GROUP BY risk_label`
    );

    let bdryHistory = [];

    try {
      const { data } = await withRetry(
        (timeout) => axios.get(`${ML_SERVICE_URL}/dashboard-summary`, { timeout }),
        { initialTimeout: 15000, retries: 1 }
      );

      bdryHistory = data.bdry_history_12m || [];
    } catch (err) {
      console.error("Could not load BDRY history:", err.message);
    }

    res.json({
      by_route: byRoute,
      risk_distribution: riskDistribution,
      bdry_history_12m: bdryHistory,
    });
  } catch (err) {
    console.error("dashboard-summary failed:", err.message);
    res.status(500).json({
      error: "Could not fetch dashboard summary",
    });
  }
});

// GET /api/alerts — a user's own alerts only. Previously had no auth at
// all and returned every user's alerts to any caller; now requires a
// valid session and scopes the query to the authenticated user.
router.get("/alerts", requireAuth, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("alerts query failed:", err.message);
    res.status(500).json({ error: "Could not fetch alerts" });
  }
});

module.exports = router;