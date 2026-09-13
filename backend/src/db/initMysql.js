// backend/src/db/initMysql.js
// Applies schema.sql to a real MySQL server (e.g. a free Aiven MySQL
// instance) using the same mysql2 driver already used by db/index.js.
// Run once per fresh database: `npm run init-mysql-db`
// Requires MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE
// (+ MYSQL_SSL / MYSQL_SSL_CA if the provider requires TLS) in the
// environment or backend/.env.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const DEFAULT_VESSELS = [
  ["Handysize", 10000, 45000],
  ["Supramax", 45001, 80000],
  ["Panamax", 80001, 120000],
  ["Capesize", 120001, 220000],
];

async function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  let schemaSql = fs.readFileSync(schemaPath, "utf8");

  const database = process.env.MYSQL_DATABASE || "freightsight";

  // schema.sql hardcodes `CREATE DATABASE IF NOT EXISTS freightsight; USE
  // freightsight;` for a plain local MySQL setup. Hosted free-tier providers
  // (Aiven, etc.) instead give you one pre-created database (commonly
  // `defaultdb`) and won't let you create another, so strip those two lines
  // and target whatever MYSQL_DATABASE is actually configured to.
  schemaSql = schemaSql
    .replace(/^\s*CREATE DATABASE.*$/im, "")
    .replace(/^\s*USE\s+\S+;\s*$/im, "");

  const useSsl = /^true$/i.test(process.env.MYSQL_SSL || "");

  // multipleStatements is needed here only to run schema.sql's semicolon-
  // separated CREATE TABLE statements in one go; the app's normal pool in
  // db/index.js intentionally leaves this off.
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database,
    multipleStatements: true,
    ssl: useSsl
      ? {
          ca: process.env.MYSQL_SSL_CA || undefined,
          rejectUnauthorized: !!process.env.MYSQL_SSL_CA,
        }
      : undefined,
  });

  console.log(`Applying schema.sql to ${database} ...`);
  await connection.query(schemaSql);

  // Existing production databases are not changed by `CREATE TABLE IF NOT EXISTS`.
  // Keep the startup migration idempotent so new application fields are added
  // without requiring the user to drop/recreate the database.
  //
  // Keep this in sync with MYSQL_COLUMN_MIGRATIONS in db/index.js (the
  // on-every-boot equivalent) and with schema.sql: any column added to one
  // needs an entry in both, or an old Aiven/MySQL database will start
  // throwing "Unknown column" on /forecast, history, PDF export, or alerts.
  const migrations = [
    // --- user ownership: forecasts tied to a logged-in account ---
    ["forecast_requests", "user_id", "INT NULL"],
    // --- COA (Charter-of-Affreightment) multi-voyage contracting inputs ---
    ["forecast_requests", "contract_duration_months", "DECIMAL(6,2) NULL"],
    ["forecast_requests", "total_program_tons", "DECIMAL(14,2) NULL"],
    // --- route/forecast metadata: proxy vs. route-specific transparency ---
    ["forecast_results", "forecast_type", "VARCHAR(30) NULL"],
    ["forecast_results", "data_confidence", "VARCHAR(20) NULL"],
    ["forecast_results", "data_source_level", "VARCHAR(30) NULL"],
    // --- explainability: why the model produced this forecast ---
    ["forecast_results", "feature_importance", "JSON NULL"],
    ["forecast_results", "top_drivers", "JSON NULL"],
    // --- genuine multi-horizon forecast curve (H+1/H+2/H+3) ---
    ["forecast_results", "forecast_curve", "JSON NULL"],
    // --- both-port vessel feasibility outcome ---
    ["forecast_results", "vessel_status", "VARCHAR(60) NULL"],
    ["forecast_results", "vessel_rejection_reason", "VARCHAR(300) NULL"],
    ["forecast_results", "rejected_vessel_types", "JSON NULL"],
    // --- decision-quality vessel explanation + port-data disclaimer ---
    ["forecast_results", "recommended_vessel_reason", "TEXT NULL"],
    ["forecast_results", "port_data_warning", "TEXT NULL"],
    // --- alert ownership: scope alerts to the user who triggered them ---
    ["alerts", "user_id", "INT NULL"],
  ];

  for (const [tableName, columnName, definition] of migrations) {
    try {
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS count
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [database, tableName, columnName]
      );
      if (Number(rows[0]?.count || 0) === 0) {
        await connection.query(
          `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`
        );
        console.log(`Added missing MySQL column ${tableName}.${columnName}`);
      }
    } catch (err) {
      // Another instance may have added the column between the information_schema
      // check and ALTER TABLE. Treat duplicate-column errors as success.
      if (err.code !== "ER_DUP_FIELDNAME") throw err;
    }
  }

  // FK constraints for the user-ownership columns above. Added separately
  // from the column migration (and only after it, since the column must
  // exist first) so a database that already has the column from an
  // earlier partial deploy — but not the constraint — still ends up fully
  // migrated instead of one failure skipping the other.
  const fkMigrations = [
    [
      "forecast_requests",
      "fk_forecast_requests_user_id",
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL",
    ],
    [
      "alerts",
      "fk_alerts_user_id",
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    ],
  ];

  for (const [tableName, constraintName, definition] of fkMigrations) {
    try {
      await connection.query(
        `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${constraintName}\` ${definition}`
      );
      console.log(`Added missing MySQL FK ${constraintName} on ${tableName}`);
    } catch (err) {
      // ER_FK_DUP_NAME (1826) / ER_DUP_KEYNAME once already applied.
      if (err.code !== "ER_FK_DUP_NAME" && err.code !== "ER_DUP_KEYNAME") throw err;
    }
  }

  for (const [vessel_type, min_capacity_tons, max_capacity_tons] of DEFAULT_VESSELS) {
    await connection.query(
      "INSERT IGNORE INTO vessel_master (vessel_type, min_capacity_tons, max_capacity_tons) VALUES (?, ?, ?)",
      [vessel_type, min_capacity_tons, max_capacity_tons]
    );
  }

  console.log(`MySQL schema ready on ${process.env.MYSQL_HOST}/${database}`);
  await connection.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed to initialize MySQL schema:", err);
    process.exit(1);
  });
}

module.exports = { main };