// backend/src/utils/forecastLookup.js
//
// Single place that loads a saved forecast (forecast_results joined to its
// forecast_requests row) and decides who may see it. Shared by the one-page
// forecast PDF (routes/pdf.js) and the Decision Brief
// (routes/decisionBrief.js) so both apply exactly the same visibility rule:
//
//   - a forecast made while signed in (q.user_id set) is private to its owner;
//   - a forecast made anonymously (q.user_id IS NULL) has no owner to restrict
//     to, so anyone with the link can read it (same as the forecast itself).
//
// NOTE: db.query is looked up on the module object at call time (not
// destructured) so tests that replace db.query with a mock keep working.
const db = require("../db");

async function loadForecastRow(resultId, userId) {
  const rows = await db.query(
    `SELECT fr.*, q.commodity, q.origin_port, q.destination_port, q.shipment_date,
            q.cargo_weight_tons, q.shipment_mode, q.contract_duration_months, q.total_program_tons
     FROM forecast_results fr
     JOIN forecast_requests q ON q.id = fr.request_id
     WHERE fr.id = ? AND (q.user_id = ? OR q.user_id IS NULL)`,
    [resultId, userId ?? -1]
  );
  return rows[0];
}

function parseJsonField(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// MySQL returns DATE columns as JS Date objects and DECIMAL columns as
// strings; SQLite returns plain strings/numbers. Normalise both to what the
// ml-service expects (YYYY-MM-DD string, real numbers).
function toIsoDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? "").slice(0, 10);
}

function normalizeForecastRow(row) {
  return {
    record_id: row.id,
    route: row.route,
    commodity: row.commodity,
    origin_port: row.origin_port,
    destination_port: row.destination_port,
    shipment_date: toIsoDate(row.shipment_date),
    base_cargo_tons: num(row.cargo_weight_tons),
    base_duration_months: num(row.contract_duration_months) ?? 0,
    total_program_tons: num(row.total_program_tons),
    rate_usd_per_ton: num(row.predicted_freight_rate_usd_per_ton),
    risk_label: row.risk_label,
    risk_confidence: num(row.risk_confidence),
    recommended_vessel_type: row.recommended_vessel_type,
    charter_window: row.recommended_charter_window,
    summary: row.summary,
    vessel_status: row.vessel_status,
    vessel_rejection_reason: row.vessel_rejection_reason,
    port_turnaround_days: num(row.port_turnaround_days),
    congestion_warning: row.congestion_warning,
    forecast_type: row.forecast_type,
    data_confidence: row.data_confidence,
    data_source_level: row.data_source_level,
    forecast_curve: parseJsonField(row.forecast_curve, []),
  };
}

module.exports = { loadForecastRow, normalizeForecastRow, parseJsonField, toIsoDate };
