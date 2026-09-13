// backend/src/db/initMysql.js
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
  const migrations = [
    ["forecast_requests", "contract_duration_months", "DECIMAL(6,2) NULL"],
    ["forecast_requests", "total_program_tons", "DECIMAL(14,2) NULL"],
    ["forecast_requests", "user_id", "INT NULL"],
    ["forecast_results", "recommended_vessel_reason", "TEXT NULL"],
    ["forecast_results", "port_data_warning", "TEXT NULL"],
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