# Backend route tests

Run with:

    cd backend
    npm install
    npm test

`npm test` runs `NODE_ENV=test jest --runInBand`. Serial execution
(`--runInBand`) is intentional: all test files share one isolated SQLite
file (`backend/freightsight.test.sqlite`, separate from the dev
`freightsight.sqlite` — see `src/db/index.js`), and each file cleans up
only the fixture rows it created.

- `globalSetup.js` — runs once before any test file: wipes and rebuilds
  the test SQLite schema from `src/db/initSqlite.js`'s shared
  `initializeSchema()`.
- `setupEnv.js` — pins `NODE_ENV`, `DB_CLIENT`, and a fixed `JWT_SECRET`
  before each test file's modules load, so every file signs/verifies
  tokens with the same secret without depending on the random
  dev-fallback secret in `src/middleware/auth.js`.
- `helpers.js` — shared fixture creation/cleanup (test users, forecast
  request+result pairs, alerts).
- `history.test.js` — `GET /api/history`: auth required, users only see
  their own rows, JSON columns are parsed back into objects/arrays,
  `?limit=` is honored, and a DB failure returns a clean 500.
- `alerts.test.js` — `GET /api/alerts`: no auth required, returns the
  fixture alert most-recent-first, capped at 50, clean 500 on DB failure.
- `pdfExport.test.js` — `GET /api/forecast/:resultId/pdf`: no auth required,
  400 on a non-numeric id, 404 for someone else's forecast or a
  nonexistent one, a real streamed `%PDF-...` document for the owner,
  anonymous downloads for forecasts made signed-out (by anyone, signed in
  or not), with a consistent English report.
- `whatif.test.js` — `POST /api/whatif`: validates required fields,
  confirms it proxies to ml-service's `/recommend` (which runs the same
  underlying `ModelBundle.predict()` as `/forecast` — see
  `ml-service/app/main.py`) with the request forwarded intact, returns
  the ml-service response unchanged, never writes to the DB, and
  surfaces ml-service errors (502 unreachable / 400 with validation
  detail) cleanly. `axios` is mocked — there's no live ml-service in the
  test environment.

## A note on this environment

These tests were written and syntax-checked here, but this sandbox has no
network access, so `npm install` (jest, supertest, cross-env,
better-sqlite3) could not actually be run to execute them end-to-end.
Please run `npm test` after installing — if anything fails, report it
back and it can be fixed directly.
