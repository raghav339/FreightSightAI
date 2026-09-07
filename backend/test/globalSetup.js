// backend/test/globalSetup.js
// Runs ONCE before any test file, in a separate process from the tests
// themselves (that's how Jest's globalSetup works) — so this cannot share
// the require-cache'd db connection the test files use. It only needs to
// make sure the on-disk schema exists before anything else touches it.
const fs = require("fs");
const path = require("path");

module.exports = async () => {
  process.env.NODE_ENV = "test";
  process.env.DB_CLIENT = "sqlite";

  const dbPath = path.join(__dirname, "..", "freightsight.test.sqlite");
  // Start from a clean slate each test run so leftover rows from a
  // previous interrupted run (e.g. a crashed test) can't cause unique-
  // constraint failures (duplicate emails) or skew count-based assertions.
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const { initializeSchema } = require("../src/db/initSqlite");
  const db = initializeSchema(dbPath);
  db.close();
};
