# FreightSight Project Manual

## 1. Purpose

FreightSight is a bulk-cargo procurement and vessel-chartering decision-support system for routes into India's East Coast ports.

It combines forecasting, risk analysis, vessel/port feasibility, origin comparison, AIS intelligence and contract planning in one workflow.

This document is the practical manual for running and demonstrating the project.

---

## 2. Components

### Frontend

**Technology:** React 18, Vite, React Router, Tailwind CSS, Recharts, Leaflet.

Responsibilities:

- user interface
- authentication state
- forecast forms/results
- charts
- route maps
- origin comparison
- idle-vessel planning
- COA optimization
- history
- PDF download

### Backend

**Technology:** Node.js + Express.

Responsibilities:

- browser-facing `/api/*` contract
- authentication/JWT
- SQLite/MySQL persistence
- forecast history
- alerts
- PDF generation
- proxying ML requests
- cold-start/retry handling
- rate limiting and validation

### ML service

**Technology:** Python + FastAPI + pandas + scikit-learn.

Responsibilities:

- forecast models
- route-freight models
- risk classification
- vessel/port feasibility
- origin comparison
- idle alternatives
- AIS processing
- COA optimization
- English-only decision-support text

---

## 3. Start order

Start services in this order:

```text
1. ML service :8001
2. Backend    :5000
3. Frontend   :5173
```

The backend depends on the ML service for model-backed endpoints.

### ML service

```bash
cd ml-service
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux/macOS
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

Health check:

```text
GET http://localhost:8001/health
```

Expected:

```json
{
  "status": "ok",
  "models_loaded": true
}
```

### Backend

```bash
cd backend
npm install
npm run init-db
npm start
```

Health check:

```text
GET http://localhost:5000/health
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## 4. Environment configuration

### Frontend

The client reads:

```env
VITE_API_URL=http://localhost:5000/api
```

The Vite development proxy also supports leaving this variable unset and using `/api`.

**Important:** `VITE_API_BASE_URL` is not read by the current frontend client. Use `VITE_API_URL`.

### Backend

Recommended local configuration:

```env
PORT=5000
DB_CLIENT=sqlite
ML_SERVICE_URL=http://127.0.0.1:8001
FRONTEND_ORIGIN=http://localhost:5173
JWT_SECRET=use-a-long-random-secret
```

For production, use a strong secret and HTTPS.

### AIS

Configure only on the ML service:

```env
AISSTREAM_API_KEY=your-key
AIS_DB_CLIENT=mysql
AIS_RETENTION_DAYS=30
MYSQL_HOST=...
MYSQL_PORT=3306
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_DATABASE=defaultdb
MYSQL_SSL=true
MYSQL_SSL_CA=
```

Do not place AIS credentials in frontend/Vite variables.

---

## 5. Main user workflows

### A. Forecast

1. Open **Predict**.
2. Choose commodity.
3. Choose origin and destination.
4. Choose shipment date.
5. Enter cargo weight.
6. Optionally choose vessel type.
7. Submit.
8. Review the forecast, risk, confidence, route curve, vessel status and port constraints.

The forecast does not stop merely because a requested vessel is infeasible. The system reports the vessel rejection separately and preserves the rate/risk result.

### B. Compare origins

Use **Compare Origins** when the cargo destination is fixed but the loading origin is negotiable.

The system ranks origins using:

- vessel feasibility
- estimated transit
- port turnaround
- congestion information
- forecast/risk context

When live AIS is unavailable, the UI/API clearly distinguishes static port congestion from live AIS congestion.

### C. Idle Vessel Finder

Use **Idle Vessel Finder** after a vessel becomes idle.

The system:

- excludes the current port from alternatives;
- filters physically incompatible loading ports where vessel information is available;
- estimates ballast distance/time;
- combines freight potential with ballast time;
- ranks the alternatives.

An AIS-idle candidate is an observational signal, **not proof that a vessel is commercially open for charter**.

### D. COA Optimizer

Use **COA Optimizer** for a short/mid-term multi-voyage program.

Provide:

- origin/destination
- cargo/program tonnage
- contract duration
- vessel choices
- spot benchmark when available

The optimizer returns a strategy and savings only when a current spot benchmark supports a monetary comparison.

### E. History and PDF

Forecast history is authenticated.

1. Register/login.
2. Run a forecast.
3. Open **History**.
4. Select a saved result.
5. Export its PDF.

Forecast reports use the project's English decision-support wording consistently.

---

## 6. Data/model interpretation

### Forecast model

The original/global forecast path uses BDRY as a dry-bulk market proxy and incorporates historical operational features.

It should be described as a **market-proxy forecast**, not as a direct broker quote.

### Route-freight model

The route-freight model uses:

```text
data/synthetic/route_freight_observations.csv
```

for the current MVP route-rate training data.

The checked-in metadata reports:

- 1,120 synthetic rows
- 8 route lanes
- 24 route/horizon model combinations
- 22 combinations beating naive persistence
- 2 combinations failing the baseline guardrail

The two failed combinations are not silently served as route-specific forecasts.

### Newcastle → Chennai → Iron Ore

The requested/demo lane is:

```text
Newcastle → Chennai
Commodity: Iron Ore
Route: R8
```

It is supported by the shared synthetic route-freight dataset/model artifacts and is explicitly labelled as synthetic MVP data.

### AIS

Historical route features are based on PortWatch-derived AIS operational aggregates.

Live AISStream can override inference-time operational features when configured.

No live AIS credential is bundled with the project.

---

## 7. Port and vessel feasibility

The system checks both:

```text
loading/origin port
        +
discharge/destination port
```

and evaluates:

- cargo capacity
- draft
- LOA
- beam

A port-data record is not a guarantee of current berth/channel acceptance.

If no vessel class is physically compatible, the system should communicate that clearly and suggest splitting cargo or using another compatible port.

---

## 8. API map

Browser-facing backend endpoints:

```text
GET  /api/health
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me

POST /api/forecast
POST /api/route-forecast
POST /api/whatif
POST /api/compare-origins
POST /api/idle-alternatives
POST /api/coa-optimize

GET  /api/routes
GET  /api/vessels
GET  /api/ports
GET  /api/history
GET  /api/alerts
GET  /api/dashboard-summary

GET  /api/ais/status
GET  /api/ais/route-features
GET  /api/ais/idle-vessels

GET  /api/forecast/:resultId/pdf
```

ML endpoints are the same computational endpoints without `/api`.

---

## 9. Troubleshooting

### Frontend says Network Error

Check:

1. backend is running on port 5000;
2. frontend is using `/api` or `VITE_API_URL=http://localhost:5000/api`;
3. `FRONTEND_ORIGIN` matches the frontend origin;
4. browser developer tools for the exact HTTP status.

### Backend says ML service is starting

Check:

```text
http://localhost:8001/health
```

If it is unavailable, start the ML service first.

### ML service says dependencies are missing

Run:

```bash
cd ml-service
pip install -r requirements.txt
```

### Forecast models unavailable

Verify these files exist:

```text
ml-service/models/forecast_model.joblib
ml-service/models/risk_model.joblib
ml-service/models/feature_encoder.joblib
ml-service/models/metadata.json
```

### AIS unavailable

This is expected unless:

```env
AISSTREAM_API_KEY=...
```

is configured on the ML service.

The application should continue using its non-live AIS fallback.

### "Forecast was generated but could not be saved"

The forecast itself succeeded (the ML service returned a valid result), but the backend failed to write the result to `forecast_results` — check the backend logs (Render → `freightsightai-backend` → Logs) for the exact SQL error.

The most common cause historically: on MySQL, a generated text field (`vessel_constraint_note`, or an `alerts.message` built from the forecast summary) exceeded its column's `VARCHAR` limit, and MySQL's default strict mode rejects the whole `INSERT` instead of truncating. Look for `Data too long for column '<name>'` in the log line. Both known offenders (`forecast_results.vessel_constraint_note` and `alerts.message`) were widened to `TEXT` in `schema.sql`, with a matching `ALTER TABLE ... MODIFY COLUMN` migration in `backend/src/db/index.js` that runs automatically on every backend boot — so an already-deployed database self-heals on redeploy, no manual SQL needed. If a *different* column name shows up in a fresh `Data too long` error, the same fix pattern applies: widen that column to `TEXT` in `schema.sql` and add the matching `MODIFY COLUMN` migration.

### `/ais/status` shows `position_messages: 0` while `messages`/`static_messages` climb

This means every `PositionReport` AIS message is failing to insert into `ais_positions`, while `ShipStaticData`/`StaticDataReport` messages save fine. Root cause: AISStream returns `NavigationalStatus` as a string enum (`"UnderWayUsingEngine"`, `"AtAnchor"`, etc.), not the raw 0–15 ITU-R numeric code the `ais_positions.nav_status INT` column (and `idle_detector.py`'s `NAV_STATUS_LABELS`) expect. `ml-service/app/ais_stream.py` now normalizes this via `_normalize_nav_status()` before every insert — a string→int lookup table that also passes numeric values through unchanged and falls back to `None` (instead of raising) for anything unrecognized.

### `/ais/status` shows a `last_error` like `"...429 Too Many Requests...concurrent connections per user exceeded"`

This is a self-inflicted connection leak, usually triggered by the bug above (or any other per-message error): the collector's reconnect loop only called `ws.close()` on a clean exit, so any exception while handling a message abandoned the websocket without closing it, then immediately reconnected — repeat that enough times and AISStream's per-API-key concurrent-connection cap gets exhausted. `_loop()` in `ais_stream.py` now guarantees `ws.close()` in a `finally` block on every exit path, and wraps per-message handling in its own try/except so one bad message logs to `last_error` instead of tearing down the whole connection. If you hit this, redeploy so the fix is live, then wait — clearing the leaked connections on AISStream's side is out of this app's control, so `last_error` may not clear immediately even after redeploying.

### History is empty

History requires an authenticated user. Register/login first.

### PDF export fails

Check:

- backend is running;
- the result ID exists;
- the result belongs to the intended authenticated user when applicable;
- backend dependencies include `pdfkit`.

---

## 10. Verification commands

### Python/ML

```bash
cd ml-service
python -m compileall -q .
python -m pytest -q
```

### Backend

```bash
cd backend
npm install
npm test
```

### Frontend

```bash
cd frontend
npm install
npm run build
```

---

## 11. Audit result for this project archive

The project was inspected after extraction.

### Passed checks

- ML Python compilation: **passed**
- Backend Node syntax checks: **passed**
- Direct FastAPI smoke checks: **passed**
- ML test files: **64/64 tests passed when executed individually**

Covered ML areas include:

- forecast integration
- route forecasting
- baseline guardrails
- risk validation
- port feasibility
- origin comparison
- idle alternatives
- AIS/idle detection logic
- COA optimization
- synthetic market proxy

### Checks not executable in the supplied runtime

The archive's frontend dependencies were not installed, and the backend `node_modules` tree was incomplete. Attempts to install dependencies could not finish in the restricted execution environment.

Therefore the following should still be run locally:

```bash
cd backend && npm install && npm test
cd ../frontend && npm install && npm run build
```

This manual does **not** claim those suites were executed successfully in the audit environment.

---

## 12. Known limitations to disclose during a mentor/judge demo

Do not describe synthetic route rates as live market quotes.

Use wording such as:

> "The route-specific USD/ton lane model is an MVP development model. We expose the data mode and confidence explicitly. Where verified route-rate observations are unavailable, the system falls back to a market proxy rather than pretending we have broker-grade live rates."

Also disclose:

- live AIS is optional;
- historical PortWatch AIS-derived data is not live tracking;
- port constraints are reference values requiring operational verification;
- route model guardrails can fall back to the global market proxy;
- this is a decision-support MVP, not an automated charter execution system.

---

## 13. Changelog

### 2026-09-08

- **Fixed:** `/predict` intermittently returning "Forecast was generated but could not be saved" on MySQL. Cause: `forecast_results.vessel_constraint_note` and `alerts.message` were `VARCHAR(500)`, but the generated vessel-substitution explanation (and the summary text embedded in high-risk alert messages) can exceed 500 characters, and MySQL strict mode rejects an oversized `INSERT` outright rather than truncating it. Both columns widened to `TEXT` in `backend/src/db/schema.sql`, with matching `ALTER TABLE ... MODIFY COLUMN` migrations added to the startup migration block in `backend/src/db/index.js` so already-deployed databases self-heal on next boot.
- **Fixed:** AIS `PositionReport` messages never persisting (`/ais/status` showing `position_messages: 0` indefinitely). Cause: AISStream returns `NavigationalStatus` as a string enum, not the raw ITU-R numeric code the `ais_positions.nav_status INT` column expects, so every insert failed. Added `_normalize_nav_status()` in `ml-service/app/ais_stream.py` to map known string values to their numeric code (and safely fall back to `None` for anything unrecognized).
- **Fixed:** AIS collector connection leak causing `last_error: "...429 Too Many Requests...concurrent connections per user exceeded"`. Cause: the reconnect loop only closed the websocket on a clean exit; any exception while handling a message (including the `nav_status` bug above) abandoned the socket without closing it, then reconnected immediately, eventually exhausting AISStream's per-key concurrent-connection limit. `_loop()` in `ais_stream.py` now guarantees `ws.close()` via a `finally` block on every exit path, and isolates per-message handling errors so one bad message no longer kills the connection.
