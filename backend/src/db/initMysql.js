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

  for (const [vessel_type, min_capacity_tons, max_capacity_tons] of DEFAULT_VESSELS) {
    await connection.query(
      "INSERT IGNORE INTO vessel_master (vessel_type, min_capacity_tons, max_capacity_tons) VALUES (?, ?, ?)",
      [vessel_type, min_capacity_tons, max_capacity_tons]
    );
  }

  console.log(`MySQL schema ready on ${process.env.MYSQL_HOST}/${database}`);
  await connection.end();
}

main().catch((err) => {
  console.error("Failed to initialize MySQL schema:", err);
  process.exit(1);
});