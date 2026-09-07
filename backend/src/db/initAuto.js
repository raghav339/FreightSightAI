// backend/src/db/initAuto.js
// Database schema initializer used at SERVICE START, not during npm install/build.
// The Render build must remain independent of database availability. When the
// backend process starts, this module initializes the configured database once.
require("dotenv").config();
const path = require("path");

async function initializeAuto() {
  if ((process.env.DB_CLIENT || "sqlite") === "mysql") {
    const { main } = require("./initMysql");
    await main();
    return;
  }

  const { initializeSchema } = require("./initSqlite");
  const DB_PATH = path.join(__dirname, "..", "..", "freightsight.sqlite");
  const db = initializeSchema(DB_PATH);
  console.log(`SQLite DB ready at ${DB_PATH}`);
  db.close();
}

if (require.main === module) {
  initializeAuto().catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
}

module.exports = { initializeAuto };
