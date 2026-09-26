# FreightSight Project Manual — Current MVP

## 1. Product purpose

FreightSight supports SIH26006 bulk-cargo procurement and vessel-chartering decisions. The product is intentionally organized around a single business flow rather than separate administration/data-management products.

## 2. Main frontend routes

- `/` — landing / product overview
- `/predict` — freight forecast + risk + vessel/port decision support
- `/compare` — compare loading origins
- `/idle-vessel` — AIS/idle-vessel intelligence
- `/live-fleet` — live fleet map (latest known position per vessel)
- `/port-radar` — Port Disruption Radar, with the Port Substitution Engine surfaced per port
- `/disruption` — Disruption Intelligence (Simulate and Live modes)
- `/coa-optimizer` — multi-voyage / COA optimizer
- `/calibration` — model-performance / calibration figures
- `/history` — saved forecast history
- `/about` — product/data notes
- `/login`, `/signup` — local authentication

## 3. Core backend endpoints

- `POST /api/forecast`
- `POST /api/route-forecast`
- `POST /api/coa-optimize`
- `POST /api/compare-origins`
- `POST /api/idle-alternatives`
- `POST /api/whatif`
- `POST /api/port-substitution`
- `POST /api/disruption/simulate`
- `POST /api/disruption/live`
- `GET /api/disruption/event-types`
- `POST /api/disruption/decision-brief`
- `GET /api/ais/status`
- `GET /api/ais/route-features`
- `GET /api/ais/idle-vessels`
- `GET /api/ais/positions`
- `GET /api/ais/ports`
- `GET /api/ais/port-radar`
- `GET /api/ais/port-radar/:port`
- `GET /api/recent-voyages`
- `GET /api/history`
- `GET /api/dashboard-summary`
- `GET /api/alerts`
- `GET /api/calibration/summary`
- `GET /api/routes`
- `GET /api/vessels`
- `GET /api/ports`
- `GET /api/forecast/:resultId/pdf`
- `GET /api/forecast/:resultId/decision-brief`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

Dataset-upload, dataset-governance, model-promotion, Google-auth, and email-verification routes are intentionally not mounted in the current MVP.

## 4. Forecasting/data model

The ML service is route-freight-only: every forecast comes from `route_freight_model.py`, trained per origin x destination x commodity lane, either on verified production observations or on explicitly labelled synthetic MVP data (`forecast_type: synthetic_route` vs. `route_specific`). There is no separate BDRY/AIS market-proxy pathway — a lane with no route-freight coverage, or whose held-out evaluation doesn't beat naive persistence, is refused outright rather than answered with a fallback signal. Responses distinguish the forecast basis (`forecast_basis`, `forecast_source`) and confidence level (`data_confidence`, always `low` for the synthetic MVP dataset this project ships).

Newcastle → Chennai → Iron Ore (route R8) is one of 335 synthetic lanes covering every origin x destination x commodity combination the app can route a request to, surfaced as `forecast_type: synthetic_route`. Across those 335 lanes and 3 forecast horizons (1,005 route/horizon models), 1,004 beat naive persistence and 1 does not (`Port Hedland|Chennai|R5 H+2`); the guardrail refuses to silently serve a failed model.

An optional sixth risk factor, `fuel_shock`, uses the 30-day move in Brent crude (`ml-service/app/brent.py`, refreshed from FRED) when fresh data is available; it drops out cleanly if the cache is stale or missing.

## 5. Decision-support layers

### Risk
A risk indicator accompanies the freight forecast. It should be interpreted as decision support, not as a guarantee of future market behavior.

### Vessel and port feasibility
The system filters vessel classes using cargo requirements and reference port constraints, checked at **both** the origin and destination port. These reference constraints are not a substitute for terminal/port-authority confirmation.

### Origin comparison
Origins can be compared using route/operational characteristics and forecast signals. The comparison is decision support, not a claim that free historical broker-rate labels exist for every origin.

### AIS / idle vessel intelligence
The ML service can use live AIS observations and stored operational history to estimate idle-vessel candidates, port proximity, sustained low speed, and repositioning alternatives. The Live Fleet Map (`/live-fleet`) shows the latest known position for every recently seen vessel.

### Port Disruption Radar
Turns stored AIS history into an early-warning signal — is a tracked port abnormally congested right now compared with its own recent normal? Status is one of NORMAL / WATCH / ELEVATED / CRITICAL (or `INSUFFICIENT_DATA` when coverage is too thin to judge). See `docs/PORT_RADAR.md` for the full scoring method and its limitations.

### Port Substitution Engine
Answers "if this discharge port becomes unavailable, where should we go?" for any tracked port: a hard vessel-fit gate (draft/LOA/beam/cargo capacity at both ports), then a weighted score across freight impact, expected delay, congestion, distance, cargo handling and vessel headroom. Returns ranked options (PRIMARY / BACKUP / VIABLE / NOT_VIABLE) plus a map and plain-language recommendation. Logic lives in `ml-service/app/port_substitution.py`.

### Disruption Intelligence
Answers "what happens to this lane/port if a disruption hits, and should we wait or divert?" in two modes:

- **Simulate** — a hand-picked event type and severity (0-100 slider). If the disrupted port is a discharge port, it automatically calls the Port Substitution Engine and returns a wait-vs-divert `decision`.
- **Live** — severity is derived from current marine conditions (wind, waves, precipitation, visibility) fetched from WeatherAPI.com, never fabricated; the rest of the pipeline (lane pricing, wait-vs-divert decision, alternative ports) is the same code path as Simulate mode.

Both are surfaced on the `/disruption` page with a propagation diagram, and either result can be turned into a one-click PDF via `POST /api/disruption/decision-brief`.

### COA optimizer
The optimizer evaluates multi-voyage strategies using vessel capacity, voyage/schedule feasibility, contract duration, and an optional current spot benchmark. Savings should only be interpreted as economically meaningful when a current benchmark is supplied.

### Model calibration
The `/calibration` page and `GET /api/calibration/summary` surface model-performance/calibration figures for the checked-in route-freight models.

## 6. Authentication

The MVP uses local email/password authentication. Newly created accounts are immediately usable; the removed email-verification workflow is no longer part of the product.

## 7. Running the project

Create a backend database with `npm run init-db`, run the backend, run the ML service, then start the Vite frontend. Environment examples are under each service directory — see `README.md` for exact commands and environment variables.

## 8. Data honesty rules

Never call synthetic route values "broker quotes" or "live market rates". Keep `forecast_type`, data-confidence fields, and the synthetic-data notice visible wherever a synthetic route forecast is shown. The same rule applies to Port Disruption Radar output (label as `db_client`-aware, since a local SQLite instance may hold seeded/simulated AIS history) and to Disruption Intelligence's Simulate vs. Live labelling.
