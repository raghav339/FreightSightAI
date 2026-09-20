# FreightSight — SIH26006

FreightSight is a decision-support MVP for bulk-cargo procurement and vessel chartering.

Its main workflow is:

**forecast freight → assess risk → validate vessel/port feasibility → compare origins → choose charter timing/strategy → optimize multi-voyage/COA plans.**

## Recent fixes

See `FreightSight_Project_Manual.md` §13 (Changelog) for full detail. Latest:

- Widened `forecast_results.vessel_constraint_note` and `alerts.message` from `VARCHAR(500)` to `TEXT` — fixes intermittent "Forecast was generated but could not be saved" errors on MySQL caused by generated explanation text exceeding the old column limits.
- Fixed AIS `PositionReport` ingestion: AISStream's `NavigationalStatus` string enum is now normalized to the numeric ITU-R code the `ais_positions` schema expects, instead of failing every insert.
- Fixed an AIS collector connection leak that could exhaust AISStream's per-key concurrent-connection limit (surfaced as a `429` in `/ais/status`'s `last_error`).

## Project architecture

```text
FreightSight/
├── frontend/      React + Vite judge-facing web application
├── backend/       Node.js + Express API, auth, history, PDF export and API proxy
├── ml-service/    FastAPI/Python forecasting, risk, vessel/port, AIS and COA logic
└── docs/          traceability and project documentation
```

### Service flow

```text
Browser
   │
   ▼
React/Vite frontend
   │  /api/*
   ▼
Node/Express backend
   │
   ├── SQLite/MySQL ── users, forecasts, history, alerts
   │
   └── FastAPI ML service
          ├── forecast + risk
          ├── route freight model
          ├── origin comparison
          ├── vessel/port feasibility
          ├── idle-vessel alternatives
          ├── AIS intelligence
          └── COA optimization
```

## Features

- H+1 / H+2 / H+3 freight forecasting
- Explicit forecast basis, source level and confidence
- Synthetic route-freight support where verified public USD/t observations are unavailable
- Risk classification and forecast drivers (rule-based score; includes a small Brent-based fuel-cost-shock factor when fresh data is available)
- Vessel selection with **both-origin-and-destination** port feasibility checks
- Origin comparison
- AIS-enhanced route intelligence and idle-vessel detection
- COA / multi-voyage charter optimization
- What-if analysis
- Forecast history and alerts
- PDF forecast reports
- English-only decision-support interface

## Important transparency

The MVP deliberately distinguishes between observed/verified data and proxies.

- The checked-in route-freight model is currently trained on **synthetic MVP route-rate data** (`data/synthetic/route_freight_observations.csv`), covering every origin x destination x commodity lane the app can route a request to.
- `route_freight_model_metadata.json` records `verified_rows: 0` and `data_mode: synthetic_mvp`.
- There is no BDRY/AIS market-proxy fallback: a lane with no route-freight coverage, or whose held-out evaluation doesn't beat naive persistence, is refused outright (the API returns a 400) rather than silently substituted with an unrelated signal.
- Port dimensions/handling figures are reference data and must be verified with the current terminal/port authority before a real fixture.
- Live AIS requires an `AISSTREAM_API_KEY`; without it, the application falls back to historical/reference intelligence and clearly reports AIS as unavailable.

## Local setup

### 1. Backend

```bash
cd backend
npm install
npm run init-db
npm start
```

Default backend:

```text
http://localhost:5000
```

### 2. ML service

```bash
cd ml-service
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

Default ML service:

```text
http://localhost:8001
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal, normally:

```text
http://localhost:5173
```

Vite proxies `/api` to the local backend.

### Environment variables

#### `frontend/.env`

The frontend code reads **`VITE_API_URL`**.

```env
VITE_API_URL=http://localhost:5000/api
```

For local development this can normally be omitted because Vite's `/api` proxy is configured.

#### `backend/.env`

```env
PORT=5000
DB_CLIENT=sqlite
ML_SERVICE_URL=http://127.0.0.1:8001
FRONTEND_ORIGIN=http://localhost:5173
JWT_SECRET=replace-with-a-long-random-secret
```

Use MySQL instead of SQLite only when the deployment is configured for it.

#### `ml-service/.env`

```env
AISSTREAM_API_KEY=
AISSTREAM_DB=./data/production/aisstream_live.sqlite3
```

Never expose `AISSTREAM_API_KEY` through a `VITE_*` frontend variable.

## Judge/demo workflow

1. Start the ML service.
2. Start the backend.
3. Start the frontend.
4. Open **Predict**.
5. Select a supported origin/destination/commodity and shipment date.
6. Submit the forecast.
7. Review:
   - predicted freight rate
   - H+1/H+2/H+3 curve
   - risk
   - model/data confidence
   - vessel recommendation
   - port constraints
   - charter timing
   - contracting strategy
8. Use **Compare Origins**, **Idle Vessel Finder**, and **COA Optimizer** for planning workflows.
9. Sign in if you want forecast history/private PDF reports.
10. If AIS is configured, review live AIS status and route/idle-vessel signals.

## API surface

The backend exposes the main browser API under `/api`:

| Endpoint | Purpose |
|---|---|
| `POST /api/forecast` | Main forecast + risk + vessel/port decision |
| `POST /api/route-forecast` | Route-level synthetic freight forecast |
| `POST /api/compare-origins` | Compare loading origins |
| `POST /api/idle-alternatives` | Reposition an idle vessel |
| `POST /api/whatif` | Lightweight decision sensitivity |
| `POST /api/coa-optimize` | COA/multi-voyage optimization |
| `GET /api/history` | Authenticated forecast history |
| `GET /api/alerts` | Forecast alerts |
| `GET /api/routes` | Route/commodity metadata |
| `GET /api/vessels` | Vessel master data |
| `GET /api/ports` | Port constraint data |
| `GET /api/ais/status` | AIS collector status (connection health, message counts, last error) |
| `GET /api/ais/route-features` | AIS route features for an origin/destination pair |
| `GET /api/ais/idle-vessels` | AIS idle-vessel candidates; response includes a `count` of matching vessels for the given query params (not a running total — recomputed live per request) |
| `GET /api/ais/positions` | Latest known position for every vessel seen recently (one dot per vessel) — powers the Live Fleet map |
| `GET /api/ais/ports` | Every port FreightSight tracks live AIS activity for, with coordinates |
| `GET /api/ais/port-radar` | Port Disruption Radar for every tracked port: live AIS congestion vs each port's own normal ([docs/PORT_RADAR.md](docs/PORT_RADAR.md)) |
| `GET /api/ais/port-radar/:port` | Port Disruption Radar for one port |
| `GET /api/forecast/:id/pdf` | PDF forecast report |
| `GET /api/forecast/:id/decision-brief` | One-click Decision Brief PDF: forecast + what-if scenario (`?cargo_weight_tons=&contract_duration_months=`) + COA / loading-port comparison, reduced to one recommendation. Recomputed server-side; same visibility rules as `/pdf`; limited to 10 requests/min |
| `POST /api/auth/register` | Local account registration |
| `POST /api/auth/login` | Local login |
| `GET /api/auth/me` | Restore authenticated session |

The ML service mirrors the computational endpoints without the `/api` prefix.

## Testing and audit status

The current project was statically inspected and the Python/ML test suite was executed file-by-file.

### Passed

**64 ML tests passed**, covering:

- baseline guardrails
- COA optimizer
- origin comparison
- fallback hierarchy
- idle alternatives
- idle detector
- port feasibility
- prediction integration
- risk walk-forward checks
- route-freight model
- route model
- synthetic market proxy

Python compilation also passed for the ML service, and Node syntax checks passed for the backend source files.

### Environment-limited checks

The supplied archive did not have a usable frontend `node_modules` installation, and the backend `node_modules` tree was incomplete. `npm install/npm ci` could not finish within the available execution environment, so:

- the React production build could not be executed;
- the Jest backend suite could not be executed because `cross-env`/Jest binaries were absent.

This is an **environment/dependency limitation of the audit run**, not evidence that those suites pass. Run the commands below on a normal internet-connected development machine:

```bash
cd backend
npm install
npm test

cd ../frontend
npm install
npm run build

cd ../ml-service
pip install -r requirements.txt
python -m pytest -q
```

### Direct ML HTTP smoke test

The FastAPI app was also exercised directly with its test client. The following returned successful responses:

- `/health`
- `/meta`
- `/ports`
- `/route-freight/status`
- `/dashboard-summary`
- `/ais/status`
- `/forecast`
- `/recommend`
- `/compare-origins`
- `/idle-alternatives`

## Known limitations

1. **Synthetic route-rate data:** route USD/t models are MVP development models, not live broker fixtures.
2. **No market-proxy fallback:** an uncovered lane is refused (400), never silently answered with an unrelated market signal.
3. **AIS:** live AIS is optional and requires AISStream credentials.
4. **Port constraints:** several dimensions/handling values are reference or estimated values and require operational verification.
5. **Model validation:** route metadata shows 1,005 route/horizon models (335 lanes × 3 horizons), of which 1,004 beat naive persistence and 1 does not. The guardrail prevents failed route models from being silently served.
6. **Risk classes:** the high-risk class has limited representation in the primary holdout.
7. **Authentication:** the judge-facing MVP uses local email/password authentication; Google Sign-In and email verification are intentionally out of scope.
8. **Database:** the checked-in MVP does not depend on a populated production database. `npm run init-db` creates the local SQLite schema and vessel master.

## Documentation

- `FreightSight_Project_Manual.md` — detailed setup, workflows, troubleshooting, architecture and demo guide.
- `docs/SIH26006_TRACEABILITY.md` — requirement-to-implementation traceability and verification notes.
- `ml-service/data/README.md` — data organization and provenance.
- `ml-service/data/production/README.md` — production-data caveats.
- `ml-service/data/synthetic/README.md` — synthetic-data disclosure.


### Brent fuel-cost signal

The risk score has an optional sixth factor, `fuel_shock`, based on the 30-day move in Brent crude (weight 0.10, taken from volatility and rate-shock). `ml-service/app/brent.py` refreshes `data/production/brent_oil.csv` at startup and then daily from FRED (`DCOILBRENTEU`, no API key; data lags by a few days). Request handling only reads the local cache, so a failed download never affects forecasts. If the data is missing or older than 14 days the factor drops out and the score reverts to its original five factors. Each forecast's `risk_factors.brent` reports the as-of date, and `GET /brent/status` on the ML service shows cache health. Set `BRENT_ENABLED=false` to disable it. The score is a transparent heuristic, not a validated model.

### Persistent AIS storage (MySQL)

Live AIS `PositionReport` and `ShipStaticData` records are persisted in the same MySQL database used by the backend. This means AIS history survives ML-service/Render restarts and redeploys. The collector keeps the latest 30 days by default (`AIS_RETENTION_DAYS=30`).

