// backend/src/db/index.js
// Unified DB layer. Defaults to SQLite (zero setup, great for the hackathon
// demo). Set DB_CLIENT=mysql in .env + fill in MYSQL_* vars to point this at
// a real MySQL server using the schema in schema.sql — no route code changes
// needed, since every route uses db.query()/db.run() from this file.
require("dotenv").config();
const path = require("path");

const CLIENT = process.env.DB_CLIENT || "sqlite";

let query, run;

if (CLIENT === "mysql") {
  const mysql = require("mysql2/promise");

  // Hosted MySQL providers (Aiven, PlanetScale, etc.) require TLS and use a
  // non-default port. Set MYSQL_PORT + MYSQL_SSL=true (and optionally
  // MYSQL_SSL_CA with the provider's CA certificate contents) in .env for
  // those; local/plain MySQL keeps working unchanged since these all have
  // safe defaults.
  const useSsl = /^true$/i.test(process.env.MYSQL_SSL || "");

  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "freightsight",
    waitForConnections: true,
    connectionLimit: 10,
    ssl: useSsl
      ? {
          // If a CA cert is provided, verify against it (safest). Otherwise
          // still encrypt the connection but skip hostname/CA verification —
          // fine for a quick setup, but prefer supplying MYSQL_SSL_CA.
          ca: process.env.MYSQL_SSL_CA || undefined,
          rejectUnauthorized: !!process.env.MYSQL_SSL_CA,
        }
      : undefined,
  });

  query = async (sql, params = []) => {
    const [rows] = await pool.query(sql, params);
    return rows;
  };

  run = async (sql, params = []) => {
    const [result] = await pool.query(sql, params);
    return { lastID: result.insertId, changes: result.affectedRows };
  };

  const MYSQL_COLUMN_MIGRATIONS = [
    "ALTER TABLE forecast_results ADD COLUMN recommended_vessel_reason TEXT",
    "ALTER TABLE forecast_results ADD COLUMN port_data_warning TEXT",
  ];
  (async () => {
    for (const sql of MYSQL_COLUMN_MIGRATIONS) {
      try {
        await pool.query(sql);
      } catch (err) {
        if (err.code !== "ER_DUP_FIELDNAME") {
          console.error(`MySQL migration failed (${sql}):`, err.message);
        }
      }
    }

    try {
      await pool.query(
        "ALTER TABLE forecast_results MODIFY COLUMN vessel_constraint_note TEXT"
      );
    } catch (err) {
      console.error("MySQL migration failed (widen vessel_constraint_note):", err.message);
    }
    
    try {
      await pool.query("ALTER TABLE alerts MODIFY COLUMN message TEXT NOT NULL");
    } catch (err) {
      console.error("MySQL migration failed (widen alerts.message):", err.message);
    }
  })();
} else {
  const Database = require("better-sqlite3");

  const dbFilename =
    process.env.NODE_ENV === "test" ? "freightsight.test.sqlite" : "freightsight.sqlite";
  const dbPath = path.join(__dirname, "..", "..", dbFilename);
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  try {
    sqlite.exec("ALTER TABLE forecast_results ADD COLUMN recommended_vessel_reason TEXT");
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
  try {
    sqlite.exec("ALTER TABLE forecast_results ADD COLUMN port_data_warning TEXT");
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }

  // normalize `?` placeholders (both drivers use the same style, so no rewrite needed)
  query = async (sql, params = []) => {
    const stmt = sqlite.prepare(sql);
    return stmt.all(...params);
  };

  run = async (sql, params = []) => {
    const stmt = sqlite.prepare(sql);
    const info = stmt.run(...params);
    return { lastID: info.lastInsertRowid, changes: info.changes };
  };
}

module.exports = { query, run, CLIENT };