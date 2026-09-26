# FreightSight — SIH26006

FreightSight is a decision-support MVP for bulk-cargo procurement and vessel chartering.

Its main workflow is:

**forecast freight → assess risk → validate vessel/port feasibility → compare origins → choose charter timing/strategy → optimize multi-voyage/COA plans.**

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
          ├── port disruption radar
          ├── port substitution engine
          ├── disruption intelligence (simulate + live)
          └── COA optimization
```

## Features

- H+1 / H+2 / H+3 freight forecasting
- Explicit forecast basis, source level and confidence
- Synthetic route-freight support where verified public USD/t observations are unavailable
- Risk classification and forecast drivers (rule-based score; includes a small Brent-based fuel-cost-shock factor when fresh data is available)
- Vessel selection with **both-origin-and-destination** port feasibility checks
- Origin comparison
- AIS-enhanced route intelligence, idle-vessel detection and a live fleet map
- Port Disruption Radar — live AIS congestion vs. each port's own normal (`docs/PORT_RADAR.md`)
- Port Substitution Engine — ranked alternate discharge ports when one becomes unavailable
- Disruption Intelligence — Simulate (hand-picked event/severity) and Live (current marine conditions) wait-vs-divert decisions, with one-click PDF decision briefs
- COA / multi-voyage charter optimization
- What-if analysis
- Forecast history, alerts and a model-calibration/performance view
- PDF forecast reports and disruption decision briefs
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
10. If AIS is configured, review **Live Fleet Map**, **Port Radar** and route/idle-vessel signals.
11. Open **Disruption** to simulate a port event (or switch to Live mode for current marine conditions) and see the propagation chain, wait-vs-divert call, and ranked alternative ports — with an optional one-click PDF decision brief.
12. Open **Calibration** to review model-performance/calibration figures.

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
| `POST /api/port-substitution` | Ranked alternate discharge ports if one becomes unavailable |
| `POST /api/disruption/simulate` | Disruption Intelligence, Simulate mode (hand-picked event type/severity) |
| `POST /api/disruption/live` | Disruption Intelligence, Live mode (current marine conditions at a port) |
| `GET /api/disruption/event-types` | Event types available to Simulate mode |
| `POST /api/disruption/decision-brief` | One-click PDF: Simulate or Live disruption result, wait-vs-divert call, best alternative port |
| `GET /api/recent-voyages` | Recently forecast voyages (for dashboard/landing widgets) |
| `GET /api/dashboard-summary` | Aggregate figures for the landing/dashboard view |
| `GET /api/calibration/summary` | Model-performance/calibration summary |
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

The ML test suite currently has **185 test functions across 18 files** under `ml-service/tests/`, covering:

- baseline guardrails, COA optimizer, origin comparison, idle alternatives, idle detector
- port feasibility (`test_port_utils.py`), route-freight model, route model, synthetic market proxy
- Brent fuel-cost signal (`test_brent.py`)
- Port Disruption Radar (`test_port_radar.py`)
- Port Substitution Engine (`test_port_substitution.py`)
- Disruption Intelligence — pure logic (`test_disruption_engine.py`) and end-to-end wiring against real port/lane data (`test_disruption_wiring.py`)
- Live/marine-weather disruption mode (`test_marine_weather.py`, `test_live_disruption.py`)

All 185 currently pass (see `AUDIT_REPORT.md`'s 2026-09-26 addendum for the run that verified this).

The backend has a Jest suite under `backend/test/` (see `backend/test/README.md` for a per-file breakdown) covering history, alerts, PDF export, port radar proxying, forecast/disruption decision briefs, and what-if.

Run the full suites on a normal, internet-connected development machine with:

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

For a point-in-time record of an actual test/audit run (pass counts, smoke-test results, known failures), see `AUDIT_REPORT.md` and `docs/SIH26006_TRACEABILITY.md`.

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
- `docs/PORT_RADAR.md` — how the Port Disruption Radar status is computed, and its known limitations.
- `AUDIT_REPORT.md` — point-in-time record of a full inspection and test run.
- `ml-service/data/README.md` — data organization and provenance.
- `ml-service/data/production/README.md` — production-data caveats.
- `ml-service/data/synthetic/README.md` — synthetic-data disclosure.
- `backend/test/README.md`, `ml-service/tests/README.md` — per-file test-suite breakdowns.


### Route-freight model files and memory

The 1,005 route/horizon models are stored as one small file per lane in `ml-service/models/lanes/` (plus `index.json`). The service loads a lane's models only when that lane is requested and keeps the 24 most recently used in memory (`ROUTE_MODEL_CACHE_LANES` to change this). Measured on this project, the service stays around 210-250 MB RSS instead of about 1.3 GB, so it fits Render's 512 MB free tier. Predictions are identical to the previous all-in-memory loading.

After retraining (`python scripts/train_route_freight_grid.py` or `scripts/train_route_freight.py`), the scripts re-pack the result into `models/lanes/` automatically. If you call `route_freight_model.train()` directly, run `export_lane_files("models", remove_monolithic=True)` afterwards; the loader also still works with the old `route_freight_model_h{1,2,3}.joblib` files when `models/lanes/` is absent.

### Brent fuel-cost signal

The risk score has an optional sixth factor, `fuel_shock`, based on the 30-day move in Brent crude (weight 0.10, taken from volatility and rate-shock). `ml-service/app/brent.py` refreshes `data/production/brent_oil.csv` at startup and then daily from FRED (`DCOILBRENTEU`, no API key; data lags by a few days). Request handling only reads the local cache, so a failed download never affects forecasts. If the data is missing or older than 14 days the factor drops out and the score reverts to its original five factors. Each forecast's `risk_factors.brent` reports the as-of date, and `GET /brent/status` on the ML service shows cache health. Set `BRENT_ENABLED=false` to disable it. The score is a transparent heuristic, not a validated model.

### Persistent AIS storage (MySQL)

Live AIS `PositionReport` and `ShipStaticData` records are persisted in the same MySQL database used by the backend. This means AIS history survives ML-service/Render restarts and redeploys. The collector keeps the latest 30 days by default (`AIS_RETENTION_DAYS=30`).


## Performance notes (compare-origins / idle-alternatives)

- `ml-service` memoizes lane forecasts (10 min) and whole compare/idle answers (2 min), and pre-computes every lane's forecast for this and next month in the background at startup. Set `PREWARM_FORECASTS=0` to disable the pre-compute on very small instances.
- The backend caches identical `/compare-origins` and `/idle-alternatives` requests for 2 minutes (`DISABLE_RESPONSE_CACHE=1` turns it off; it is always off under `NODE_ENV=test`).
- AIS idle-vessel scans are cached for 20 s and per-port congestion for 60 s.

## Port Substitution Engine

`POST /port-substitution` (ml-service) / `POST /api/port-substitution` (backend) answers "if this discharge port becomes unavailable, where should we go?" for any tracked port.

- Request: `{ failed_port, cargo_weight_tons?, commodity?, origin_port?, shipment_date?, vessel_type?, max_distance_nm? }`. Only `failed_port` is required; adding a loading port + commodity brings in freight-rate impact.
- Logic lives in `ml-service/app/port_substitution.py` (pure, unit-tested — see `tests/test_port_substitution.py`): a hard vessel-fit gate (draft/LOA/beam/cargo capacity at both ports), then a weighted score across freight impact, expected delay, congestion, distance, cargo handling and vessel headroom.
- Response includes a ranked `options` list (PRIMARY / BACKUP / VIABLE / NOT_VIABLE), a `map` (nodes/edges) for the UI, a plain-language `recommendation`, and `assumptions` describing what is and isn't modeled (no port dues, no onward inland transport cost, no multi-ship diversion congestion; delay figures are labelled planning assumptions, not measured).
- Frontend: `PortSubstitutionPanel` renders automatically under the selected port on the Port Radar page, with a lightweight SVG `SubstitutionMap`.

## Disruption Intelligence

`POST /disruption/simulate` (Simulate mode) and `POST /disruption/live` (Live mode) on the ml-service — mirrored as `POST /api/disruption/simulate` / `POST /api/disruption/live` on the backend — both answer "what happens to this lane/port if a disruption hits, and should we wait or divert?" `GET /disruption/event-types` lists the event types available to Simulate mode, and `POST /api/disruption/decision-brief` turns either mode's result into a one-click PDF.

**Simulate mode** — request: `{ event_type, port, severity (0-100), duration_days?, origin_port?, destination_port?, commodity?, shipment_date?, cargo_weight_tons?, stockpile_buffer_days?, include_alternatives? }`. Only `event_type`, `port`, `severity` are required. `ModelBundle.simulate_disruption` (`ml-service/app/utils.py`) resolves the port's role (origin/destination) from the project's own port lists rather than just from having infrastructure data on file. If a full lane (origin + destination + commodity) is known, the disruption's freight-pressure percentage is applied as an uplift on top of the existing route forecast — it does not re-run the forecast model. If the disrupted port is a discharge port, it automatically calls the Port Substitution Engine treating that port as unavailable, and returns a `decision` block comparing "wait it out" vs. the best ranked alternative; for a loading port, no alternative call is made (that's `/compare-origins`'s job) and the response says so explicitly. Source is reported as `"simulated"`. Tests: `tests/test_disruption_engine.py` (pure logic) and `tests/test_disruption_wiring.py` (run against the real port master and lane models).

**Live mode** — same response shape as Simulate, minus `event_type`/`severity` in the request; severity instead comes from current marine conditions. `ml-service/app/marine_weather.py` fetches current wind, precipitation, visibility and wave height, swell, period (WeatherAPI.com's `marine.json` API, one call, requires `WEATHERAPI_KEY`) for a port's coordinates using only the standard library (`urllib`), converting them into a 0-1 severity score against labelled reference points (storm-force wind ~89 km/h, WMO "very rough" sea ~6 m, "violent" rain ~15 mm/h, good visibility 10 km). **Never fabricates a reading** — if the call fails, the key is missing, or a port has no coordinates on file, the response is `severity: None` / `status: "unavailable"` and `ModelBundle.live_disruption` raises a clear error rather than defaulting to "calm." Always uses the `extreme_weather` event profile and labels `source: "live"`; the rest of the pipeline (lane pricing, wait-vs-divert decision, Port Substitution alternatives) shares the exact same code path as Simulate mode (`ModelBundle._build_disruption_response`). Tests (`tests/test_marine_weather.py`, `tests/test_live_disruption.py`) mock the HTTP layer — before relying on this for a demo, make one real call against a real port and confirm WeatherAPI's response field names still match `_HOUR_FIELDS` in `marine_weather.py` (external APIs occasionally rename fields). (Previously used Open-Meteo, a free keyless source; switched to WeatherAPI.com because Open-Meteo's rate limiting is by shared outbound IP, and on Render that IP is shared with other tenants — a limit this app has no way to control.)

**Frontend** — the `/disruption` page (navbar: "Disruption") has a Simulate/Live toggle. Simulate shows event type, affected port, a continuous 0-100 severity slider, optional duration/stockpile buffer, and an optional lane section that unlocks freight-impact numbers. Live hides the event-type/severity controls and adds a "Live marine conditions" card. Both render a vertical propagation diagram (`components/PropagationChain.jsx`), a freight-impact card when a full lane is given, a "wait it out vs. divert" comparison card for discharge-port disruptions, and — for discharge-port disruptions — the ranked alternatives from the Port Substitution Engine (map + top 3), linking through to the full analysis on the Port Radar page. The page renders exactly what the API returns; it computes nothing itself beyond basic number formatting.
