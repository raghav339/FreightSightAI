-- ================================================================
-- FILE: backend/src/db/schema.sql
-- ================================================================
-- backend/src/db/schema.sql
-- FreightSight AI — MySQL schema
-- Run this against a MySQL 8+ database, e.g.:
--   mysql -u root -p < src/db/schema.sql
-- (The dev/demo server can also run on SQLite — see initSqlite.js — but this
-- file is the schema to use for a real MySQL deployment.)
--
-- NOTE: CREATE TABLE IF NOT EXISTS only applies new columns (like
-- (SQLite deployments get this automatically — see the migration in db/index.js.)

CREATE DATABASE IF NOT EXISTS freightsight;
USE freightsight;

-- Accounts used by the authenticated forecasting history/report workflow.
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_verified TINYINT(1) NOT NULL DEFAULT 1,
  -- Retained for backward compatibility with existing demo databases;
  -- the current MVP uses local password authentication only.
  role VARCHAR(16) NOT NULL DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS route_master (
  id INT AUTO_INCREMENT PRIMARY KEY,
  route VARCHAR(255) NOT NULL UNIQUE,
  origin_port VARCHAR(120) NOT NULL,
  destination_port VARCHAR(120) NOT NULL,
  distance_km DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vessel_master (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vessel_type VARCHAR(80) NOT NULL UNIQUE,
  min_capacity_tons INT,
  max_capacity_tons INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forecast_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  commodity VARCHAR(80) NOT NULL,
  origin_port VARCHAR(120) NOT NULL,
  destination_port VARCHAR(120) NOT NULL,
  shipment_date DATE NOT NULL,
  cargo_weight_tons DECIMAL(12,2) NOT NULL,
  cargo_volume_cbm DECIMAL(12,2),
  shipment_mode VARCHAR(60) NOT NULL,
  vessel_type VARCHAR(60),
  distance_km DECIMAL(10,2),
  delay_days DECIMAL(6,2) DEFAULT 0,
  -- Objective: plan short/mid-term multi-voyage (COA) contracts, not just one-off spot fixtures
  contract_duration_months DECIMAL(6,2),
  total_program_tons DECIMAL(14,2),
  user_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS forecast_results (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  route VARCHAR(255) NOT NULL,
  predicted_freight_rate_usd_per_ton DECIMAL(10,2) NOT NULL,
  risk_label ENUM('low', 'medium', 'high') NOT NULL,
  risk_confidence DECIMAL(5,3),
  recommended_vessel_type VARCHAR(60),
  recommended_charter_window VARCHAR(255),
  summary TEXT,
  trend_points JSON,
  -- (b) Vessel Type Optimization — port-infrastructure-aware
  feasible_vessel_types JSON,
  -- Was VARCHAR(500): the generated vessel-substitution explanation
  -- (over-capacity + draft-exceeds-port-depth + timing note) can run
  -- 500-600+ chars, which MySQL strict mode rejects instead of
  -- truncating. Widened to TEXT — see the matching migration in
  -- db/index.js for already-deployed databases.
  vessel_constraint_note TEXT,
  origin_port_info JSON,
  destination_port_info JSON,
  -- (c) Idle Scenario Management
  port_turnaround_days DECIMAL(8,2),
  idle_management_advice VARCHAR(600),
  -- (d) Risk Mitigation / early warning
  congestion_warning VARCHAR(600),
  -- Objective: spot -> short/mid-term multi-voyage contracting
  contracting_strategy VARCHAR(700),
  -- (3) Explainability — why the model produced this forecast
  feature_importance JSON,
  top_drivers JSON,
  -- (Phase 2/3) proxy vs route-specific transparency
  forecast_type VARCHAR(30),
  data_confidence VARCHAR(20),
  data_source_level VARCHAR(30),
  -- (Phase 6) both-port vessel feasibility outcome
  vessel_status VARCHAR(60),
  vessel_rejection_reason VARCHAR(300),
  rejected_vessel_types JSON,
  -- (Phase 4) genuine multi-horizon forecast curve (H+1/H+2/H+3)
  forecast_curve JSON,
  -- disclaimer computed by the ML service — see routes/forecast.js.
  recommended_vessel_reason TEXT,
  port_data_warning TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES forecast_requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alerts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  route VARCHAR(255) NOT NULL,
  alert_type ENUM('high_risk', 'price_spike', 'volatility') NOT NULL,
  -- Was VARCHAR(500): the high_risk alert embeds the full forecast
  -- summary (which itself can embed the vessel-substitution explanation),
  -- easily exceeding 500 chars. Widened to TEXT — see the matching
  -- migration in db/index.js for already-deployed databases.
  message TEXT NOT NULL,
  forecast_result_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (forecast_result_id) REFERENCES forecast_results(id) ON DELETE SET NULL
);


-- Live AIS history. The ML service writes these records directly to the
-- same MySQL database so AIS data survives Render/ML-service restarts.
CREATE TABLE IF NOT EXISTS ais_positions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  received_at DATETIME(6) NOT NULL,
  ais_timestamp INT NULL,
  mmsi VARCHAR(20) NOT NULL,
  ship_name VARCHAR(255) NULL,
  lat DOUBLE NULL,
  lon DOUBLE NULL,
  sog DOUBLE NULL,
  cog DOUBLE NULL,
  heading DOUBLE NULL,
  nav_status INT NULL,
  port_near VARCHAR(120) NULL,
  port_distance_nm DOUBLE NULL,
  ship_type INT NULL,
  INDEX idx_ais_positions_time (received_at),
  INDEX idx_ais_positions_port (port_near, received_at),
  INDEX idx_ais_positions_mmsi (mmsi, received_at),
  INDEX idx_ais_positions_idle (port_near, sog, received_at),
  INDEX idx_ais_positions_port_distance (port_near, port_distance_nm, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ais_static (
  mmsi VARCHAR(20) PRIMARY KEY,
  updated_at DATETIME(6) NOT NULL,
  ship_name VARCHAR(255) NULL,
  ship_type INT NULL,
  imo VARCHAR(20) NULL,
  callsign VARCHAR(32) NULL,
  destination VARCHAR(255) NULL,
  draught_m DOUBLE NULL,
  length_m DOUBLE NULL,
  beam_m DOUBLE NULL,
  INDEX idx_ais_static_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
