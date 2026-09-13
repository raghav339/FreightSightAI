// backend/test/helpers.js
// Shared fixture helpers for backend route tests. Each test file is
// responsible for cleaning up the rows it creates (see afterAll in each
// test file) so files can run --runInBand against the one shared
// freightsight.test.sqlite file without clobbering each other.
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../src/db");
const { JWT_SECRET } = require("../src/middleware/auth");

// Every fixture user/row created by these tests is tagged with this prefix
// so cleanup queries can target exactly (and only) test-created data.
const TEST_TAG = "freightsight-test";

async function createTestUser(overrides = {}) {
  const email = overrides.email || `${TEST_TAG}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const name = overrides.name || "Test User";
  const passwordHash = await bcrypt.hash(overrides.password || "test-password-123", 4);

  const result = await db.run(
    `INSERT INTO users (name, email, password_hash, is_verified) VALUES (?, ?, ?, 1)`,
    [name, email, passwordHash]
  );
  return { id: result.lastID, name, email };
}

function issueTestToken(user) {
  return jwt.sign({ id: user.id, email: user.email, is_verified: true }, JWT_SECRET, {
    expiresIn: "1h",
  });
}

async function insertForecastRequestAndResult({ userId, overrides = {} } = {}) {
  const reqInsert = await db.run(
    `INSERT INTO forecast_requests
     (commodity, origin_port, destination_port, shipment_date, cargo_weight_tons, shipment_mode, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      overrides.commodity || "Coal",
      overrides.origin_port || "Newcastle",
      overrides.destination_port || "Paradip",
      overrides.shipment_date || "2026-10-01",
      overrides.cargo_weight_tons || 75000,
      overrides.shipment_mode || "Bulk Carrier",
      userId ?? null,
    ]
  );

  const resultInsert = await db.run(
    `INSERT INTO forecast_results
     (request_id, route, predicted_freight_rate_usd_per_ton, risk_label, risk_confidence,
      recommended_vessel_type, recommended_charter_window, summary, trend_points,
      feasible_vessel_types, origin_port_info, destination_port_info,
      port_turnaround_days, idle_management_advice, congestion_warning, contracting_strategy,
      feature_importance, top_drivers, forecast_type, data_confidence, data_source_level,
      vessel_status, vessel_rejection_reason, rejected_vessel_types, forecast_curve)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reqInsert.lastID,
      overrides.route || "Newcastle-Paradip",
      overrides.predicted_freight_rate_usd_per_ton ?? 18.5,
      overrides.risk_label || "medium",
      overrides.risk_confidence ?? 0.72,
      overrides.recommended_vessel_type || "Panamax",
      overrides.recommended_charter_window || "Within 2 weeks",
      overrides.summary || `${TEST_TAG} fixture forecast`,
      JSON.stringify(overrides.trend_points || []),
      JSON.stringify(overrides.feasible_vessel_types || ["Panamax"]),
      JSON.stringify(overrides.origin_port_info || { max_draft_m: 15 }),
      JSON.stringify(overrides.destination_port_info || { max_draft_m: 14 }),
      overrides.port_turnaround_days ?? 3.5,
      overrides.idle_management_advice || null,
      overrides.congestion_warning || null,
      overrides.contracting_strategy || null,
      JSON.stringify(overrides.feature_importance || []),
      JSON.stringify(overrides.top_drivers || []),
      overrides.forecast_type || "market_proxy",
      overrides.data_confidence || "medium",
      overrides.data_source_level || "destination_commodity",
      overrides.vessel_status || "RECOMMENDED_VESSEL",
      overrides.vessel_rejection_reason || null,
      JSON.stringify(overrides.rejected_vessel_types || []),
      JSON.stringify(overrides.forecast_curve || []),
    ]
  );

  return { requestId: reqInsert.lastID, resultId: resultInsert.lastID };
}

async function insertAlert(overrides = {}) {
  const result = await db.run(
    `INSERT INTO alerts (route, alert_type, message) VALUES (?, ?, ?)`,
    [
      overrides.route || "Newcastle-Paradip",
      overrides.alert_type || "high_risk",
      overrides.message || `${TEST_TAG} fixture alert`,
    ]
  );
  return { id: result.lastID };
}

async function deleteUser(userId) {
  await db.run(`DELETE FROM users WHERE id = ?`, [userId]);
}

async function deleteForecast({ requestId, resultId }) {
  if (resultId) await db.run(`DELETE FROM forecast_results WHERE id = ?`, [resultId]);
  if (requestId) await db.run(`DELETE FROM forecast_requests WHERE id = ?`, [requestId]);
}

async function deleteAlert(alertId) {
  await db.run(`DELETE FROM alerts WHERE id = ?`, [alertId]);
}

module.exports = {
  TEST_TAG,
  createTestUser,
  issueTestToken,
  insertForecastRequestAndResult,
  insertAlert,
  deleteUser,
  deleteForecast,
  deleteAlert,
};
