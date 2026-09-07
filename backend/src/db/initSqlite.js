// FreightSight AI — zero-setup SQLite initializer for the core SIH26006 MVP.
// The MVP database intentionally contains only authentication, forecast
// history/results, reference vessel/route data, and alerts.
//
// Schema creation is exposed as initializeSchema(dbPath) so both the CLI
// entry point below (`npm run init-db`) and the test suite (which points
// it at a separate freightsight.test.sqlite file — see db/index.js) can
// share exactly one definition of the schema.
const path = require("path");
const Database = require("better-sqlite3");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_verified INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS route_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route TEXT NOT NULL UNIQUE,
  origin_port TEXT NOT NULL,
  destination_port TEXT NOT NULL,
  distance_km REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vessel_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vessel_type TEXT NOT NULL UNIQUE,
  min_capacity_tons INTEGER,
  max_capacity_tons INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forecast_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commodity TEXT NOT NULL DEFAULT 'Bulk Minerals & Ores',
  origin_port TEXT NOT NULL,
  destination_port TEXT NOT NULL,
  shipment_date TEXT NOT NULL,
  cargo_weight_tons REAL NOT NULL,
  cargo_volume_cbm REAL,
  shipment_mode TEXT NOT NULL,
  vessel_type TEXT,
  distance_km REAL,
  delay_days REAL DEFAULT 0,
  contract_duration_months REAL,
  total_program_tons REAL,
  user_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS forecast_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  route TEXT NOT NULL,
  predicted_freight_rate_usd_per_ton REAL NOT NULL,
  risk_label TEXT NOT NULL CHECK (risk_label IN ('low','medium','high')),
  risk_confidence REAL,
  recommended_vessel_type TEXT,
  recommended_charter_window TEXT,
  summary TEXT,
  trend_points TEXT,
  feasible_vessel_types TEXT,
  vessel_constraint_note TEXT,
  origin_port_info TEXT,
  destination_port_info TEXT,
  port_turnaround_days REAL,
  idle_management_advice TEXT,
  congestion_warning TEXT,
  contracting_strategy TEXT,
  feature_importance TEXT,
  top_drivers TEXT,
  forecast_type TEXT,
  data_confidence TEXT,
  data_source_level TEXT,
  vessel_status TEXT,
  vessel_rejection_reason TEXT,
  rejected_vessel_types TEXT,
  forecast_curve TEXT,
  -- Decision-quality vessel explanation and port-data disclaimer computed by the ML service.
  recommended_vessel_reason TEXT,
  port_data_warning TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES forecast_requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route TEXT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('high_risk','price_spike','volatility')),
  message TEXT NOT NULL,
  forecast_result_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (forecast_result_id) REFERENCES forecast_results(id) ON DELETE SET NULL
);
`;

const DEFAULT_VESSELS = [
  ["Handysize", 10000, 45000],
  ["Supramax", 45001, 80000],
  ["Panamax", 80001, 120000],
  ["Capesize", 120001, 220000],
];

function initializeSchema(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  const insertVessel = db.prepare(
    "INSERT OR IGNORE INTO vessel_master (vessel_type, min_capacity_tons, max_capacity_tons) VALUES (?, ?, ?)"
  );
  for (const vessel of DEFAULT_VESSELS) insertVessel.run(...vessel);

  return db;
}

module.exports = { initializeSchema, SCHEMA_SQL };

if (require.main === module) {
  const DB_PATH = path.join(__dirname, "..", "..", "freightsight.sqlite");
  const db = initializeSchema(DB_PATH);
  console.log(`SQLite DB ready at ${DB_PATH}`);
  db.close();
}