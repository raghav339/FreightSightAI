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

  // Lightweight migrations: schema.sql's CREATE TABLE IF NOT EXISTS only
  // applies new columns to a brand-new database, so a database that was
  // already initialized before these columns existed needs them added
  // explicitly. Safe to run on every boot — ER_DUP_FIELDNAME (1060) is
  // caught and ignored once a column is already there.
  //
  // Keep this in sync with COLUMN_MIGRATIONS below (the SQLite equivalent)
  // and with schema.sql: any column added to one needs an entry in both,
  // or an old Aiven/MySQL database will start throwing "Unknown column"
  // on /forecast, history, PDF export, or alerts once a route touches it.
  const MYSQL_COLUMN_MIGRATIONS = [
    // --- user ownership: forecasts tied to a logged-in account ---
    "ALTER TABLE forecast_requests ADD COLUMN user_id INT NULL",
    // --- COA (Charter-of-Affreightment) multi-voyage contracting inputs ---
    "ALTER TABLE forecast_requests ADD COLUMN contract_duration_months DECIMAL(6,2) NULL",
    "ALTER TABLE forecast_requests ADD COLUMN total_program_tons DECIMAL(14,2) NULL",
    // --- route/forecast metadata: proxy vs. route-specific transparency ---
    "ALTER TABLE forecast_results ADD COLUMN forecast_type VARCHAR(30)",
    "ALTER TABLE forecast_results ADD COLUMN data_confidence VARCHAR(20)",
    "ALTER TABLE forecast_results ADD COLUMN data_source_level VARCHAR(30)",
    // --- explainability: why the model produced this forecast ---
    "ALTER TABLE forecast_results ADD COLUMN feature_importance JSON",
    "ALTER TABLE forecast_results ADD COLUMN top_drivers JSON",
    // --- genuine multi-horizon forecast curve (H+1/H+2/H+3) ---
    "ALTER TABLE forecast_results ADD COLUMN forecast_curve JSON",
    // --- both-port vessel feasibility outcome ---
    "ALTER TABLE forecast_results ADD COLUMN vessel_status VARCHAR(60)",
    "ALTER TABLE forecast_results ADD COLUMN vessel_rejection_reason VARCHAR(300)",
    "ALTER TABLE forecast_results ADD COLUMN rejected_vessel_types JSON",
    // --- decision-quality vessel explanation + port-data disclaimer ---
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
    // vessel_constraint_note was VARCHAR(500) — the generated vessel-
    // substitution explanation can exceed that, and MySQL strict mode
    // rejects the whole INSERT instead of truncating, which is why
    // /forecast was returning "generated but could not be saved" for
    // many routes. MODIFY COLUMN is safe to re-run on every boot.
    try {
      await pool.query(
        "ALTER TABLE forecast_results MODIFY COLUMN vessel_constraint_note TEXT"
      );
    } catch (err) {
      console.error("MySQL migration failed (widen vessel_constraint_note):", err.message);
    }
    // alerts.message was VARCHAR(500) — the high_risk alert embeds the
    // full forecast summary (which can itself embed the vessel
    // explanation), which was overflowing it the same way.
    try {
      await pool.query("ALTER TABLE alerts MODIFY COLUMN message TEXT NOT NULL");
    } catch (err) {
      console.error("MySQL migration failed (widen alerts.message):", err.message);
    }
    // alerts.user_id — added so alerts can be scoped to the user who
    // triggered them instead of GET /api/alerts returning every user's
    // alerts to anyone. Two separate statements (column, then FK) so a
    // database that already has the column but not the constraint (or
    // vice versa, from a partially-applied earlier deploy) still ends up
    // fully migrated instead of one failure skipping the other.
    try {
      await pool.query("ALTER TABLE alerts ADD COLUMN user_id INT");
    } catch (err) {
      if (err.code !== "ER_DUP_FIELDNAME") {
        console.error("MySQL migration failed (add alerts.user_id):", err.message);
      }
    }
    try {
      await pool.query(
        "ALTER TABLE alerts ADD CONSTRAINT fk_alerts_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"
      );
    } catch (err) {
      // ER_FK_DUP_NAME (1826) / ER_DUP_KEYNAME once already applied.
      if (err.code !== "ER_FK_DUP_NAME" && err.code !== "ER_DUP_KEYNAME") {
        console.error("MySQL migration failed (FK alerts.user_id):", err.message);
      }
    }
    // forecast_requests.user_id — same FK as schema.sql, added separately
    // from the ADD COLUMN above so a database that already has the column
    // (from an earlier partial deploy) but not the constraint still gets
    // fully migrated instead of one failure skipping the other.
    try {
      await pool.query(
        "ALTER TABLE forecast_requests ADD CONSTRAINT fk_forecast_requests_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL"
      );
    } catch (err) {
      if (err.code !== "ER_FK_DUP_NAME" && err.code !== "ER_DUP_KEYNAME") {
        console.error(
          "MySQL migration failed (FK forecast_requests.user_id):",
          err.message
        );
      }
    }
  })();
} else {
  const { initializeSchema } = require("./initSqlite");
  // Tests get their own SQLite file so `npm test` never reads/writes the
  // dev database (freightsight.sqlite) that `npm run dev` uses.
  const dbFilename =
    process.env.NODE_ENV === "test" ? "freightsight.test.sqlite" : "freightsight.sqlite";
  const dbPath = path.join(__dirname, "..", "..", dbFilename);

  // IMPORTANT — startup ordering: this module is require()'d as soon as any
  // route file loads (forecast.js, history.js, ...), which happens in
  // app.js BEFORE server.js gets a chance to call initAuto(). On a brand-new
  // database file that means NOTHING has created a single table yet at the
  // moment this file runs. initializeSchema() opens the DB *and* runs
  // `CREATE TABLE IF NOT EXISTS` for the full schema (+ default vessel
  // rows), so the base schema is always guaranteed to exist before the
  // migrations below touch it. It's a cheap no-op on an already-initialized
  // database, so it's safe to also call it again later from initAuto().
  // Do NOT replace this with a bare `new Database(dbPath)` — that was the
  // bug: it silently created an empty .sqlite file with zero tables, and
  // the very next line's ALTER TABLE crashed with "no such table:
  // forecast_results" before the server ever finished booting.
  const sqlite = initializeSchema(dbPath);

  // Safe, idempotent column migrations for databases created before these
  // fields existed. ensureColumn() checks pragma table_info() first instead
  // of firing an unconditional ALTER TABLE and hoping the error message
  // matches "duplicate column name" — so it's always safe to re-run,
  // preserves every existing row untouched, and never depends on parsing a
  // specific driver error string/code.
  function ensureColumn(table, column, definition) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // Every column added to SCHEMA_SQL (initSqlite.js) after the tables were
  // first created, in the order the app started depending on them. A
  // brand-new database gets all of these for free from CREATE TABLE IF NOT
  // EXISTS — this list exists purely so a database from an OLDER deploy
  // (which already has forecast_requests/forecast_results, just without
  // some of these columns) is brought up to the current schema in place,
  // without dropping or recreating the table and losing forecast history.
  // Keep this in sync with SCHEMA_SQL: any new column added there also
  // needs an entry here, or old databases will start throwing "no such
  // column" once a route tries to read/write it.
  const COLUMN_MIGRATIONS = [
    // --- user ownership: forecasts tied to a logged-in account ---
    ["forecast_requests", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
    // --- COA (Charter-of-Affreightment) multi-voyage contracting inputs ---
    ["forecast_requests", "contract_duration_months", "REAL"],
    ["forecast_requests", "total_program_tons", "REAL"],
    // --- route/forecast metadata: proxy vs. route-specific transparency ---
    ["forecast_results", "forecast_type", "TEXT"],
    ["forecast_results", "data_confidence", "TEXT"],
    ["forecast_results", "data_source_level", "TEXT"],
    // --- explainability: why the model produced this forecast ---
    ["forecast_results", "feature_importance", "TEXT"],
    ["forecast_results", "top_drivers", "TEXT"],
    // --- genuine multi-horizon forecast curve (H+1/H+2/H+3) ---
    ["forecast_results", "forecast_curve", "TEXT"],
    // --- both-port vessel feasibility outcome ---
    ["forecast_results", "vessel_status", "TEXT"],
    ["forecast_results", "vessel_rejection_reason", "TEXT"],
    ["forecast_results", "rejected_vessel_types", "TEXT"],
    // --- decision-quality vessel explanation + port-data disclaimer ---
    ["forecast_results", "recommended_vessel_reason", "TEXT"],
    ["forecast_results", "port_data_warning", "TEXT"],
    // --- alert ownership: scope alerts to the user who triggered them ---
    ["alerts", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE"],
  ];

  for (const [table, column, definition] of COLUMN_MIGRATIONS) {
    ensureColumn(table, column, definition);
  }

  // Indexes for the lookups the routes actually do (a user's own history,
  // a request's result, an alert's originating result). `CREATE INDEX IF
  // NOT EXISTS` is itself idempotent, so — unlike columns — no separate
  // "does it already exist" check is needed here; adding an index never
  // touches existing rows either.
  const INDEX_MIGRATIONS = [
    "CREATE INDEX IF NOT EXISTS idx_forecast_requests_user_id ON forecast_requests(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_forecast_results_request_id ON forecast_results(request_id)",
    "CREATE INDEX IF NOT EXISTS idx_alerts_forecast_result_id ON alerts(forecast_result_id)",
    "CREATE INDEX IF NOT EXISTS idx_alerts_route ON alerts(route)",
    "CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id)",
  ];

  for (const sql of INDEX_MIGRATIONS) {
    sqlite.exec(sql);
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