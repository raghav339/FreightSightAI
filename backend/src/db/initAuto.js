// backend/src/db/initAuto.js
// Runs the right schema initializer for whatever DB_CLIENT is configured,
// so the Render build command (`npm run init-db`) doesn't need to change
// when switching between sqlite and mysql.
require("dotenv").config();
const path = require("path");

if ((process.env.DB_CLIENT || "sqlite") === "mysql") {
  // initMysql.js runs its main() unconditionally on load, so requiring it
  // is enough to trigger initialization.
  require("./initMysql");
} else {
  // initSqlite.js only auto-runs its CLI block when executed directly
  // (require.main === module), which is never true when it's require()'d
  // from here — so call the exported initializer explicitly instead.
  const { initializeSchema } = require("./initSqlite");
  const DB_PATH = path.join(__dirname, "..", "..", "freightsight.sqlite");
  const db = initializeSchema(DB_PATH);
  console.log(`SQLite DB ready at ${DB_PATH}`);
  db.close();
}