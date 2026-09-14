# FreightSight Project Manual — Current MVP

## 1. Product purpose

FreightSight supports SIH26006 bulk-cargo procurement and vessel-chartering decisions. The product is intentionally organized around a single business flow rather than separate administration/data-management products.

## 2. Main frontend routes

- `/` — landing / product overview
- `/predict` — freight forecast + risk + vessel/port decision support
- `/compare` — compare loading origins
- `/idle-vessel` — AIS/idle-vessel intelligence
- `/coa-optimizer` — multi-voyage / COA optimizer
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
- `GET /api/ais/status`
- `GET /api/ais/route-features`
- `GET /api/ais/idle-vessels`
- `GET /api/history`
- `GET /api/dashboard-summary`
- `GET /api/alerts`
- `GET /api/forecast/:resultId/pdf`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

Dataset-upload, dataset-governance, model-promotion, Google-auth, and email-verification routes are intentionally not mounted in the current MVP.

## 4. Forecasting/data model

The ML service supports market-proxy and route-specific synthetic-MVP pathways. Responses distinguish the forecast basis and confidence level. The route/commodity coverage that lacks verified free public USD/t observations is not presented as real market pricing.

For Newcastle → Chennai → Iron Ore, the synthetic market-proxy series is kept separate from ordinary route-rate labels and is surfaced as `forecast_type: market_proxy`.

## 5. Decision-support layers

### Risk
A risk indicator accompanies the freight forecast. It should be interpreted as decision support, not as a guarantee of future market behavior.

### Vessel and port feasibility
The system filters vessel classes using cargo requirements and reference port constraints. These reference constraints are not a substitute for terminal/port-authority confirmation.

### Origin comparison
Origins can be compared using route/operational characteristics and forecast signals. The comparison is decision support, not a claim that free historical broker-rate labels exist for every origin.

### AIS / idle vessel intelligence
The ML service can use live AIS observations and stored operational history to estimate idle-vessel candidates, port proximity, sustained low speed, and repositioning alternatives.

### COA optimizer
The optimizer evaluates multi-voyage strategies using vessel capacity, voyage/schedule feasibility, contract duration, and an optional current spot benchmark. Savings should only be interpreted as economically meaningful when a current benchmark is supplied.

## 6. Authentication

The MVP uses local email/password authentication. Newly created accounts are immediately usable; the removed email-verification workflow is no longer part of the product.

## 7. Running the project

Create a backend database with `npm run init-db`, run the backend, run the ML service, then start the Vite frontend. Environment examples are under each service directory.

## 8. Data honesty rules

Never call synthetic route values “broker quotes” or “live market rates”. Keep `forecast_type`, data-confidence fields, and the synthetic-data notice visible wherever a synthetic route forecast is shown.

## 9. Changelog

- **2026-09 (this build):** Widened `forecast_results.vessel_constraint_note` and `alerts.message` from `VARCHAR(500)` to `TEXT` on both SQLite and MySQL schemas, fixing intermittent "Forecast was generated but could not be saved" errors when generated explanation text exceeded the old column limits. Fixed AIS `PositionReport` ingestion so AISStream's `NavigationalStatus` string enum is normalized to the numeric ITU-R code the `ais_positions` schema expects. Fixed an AIS collector connection leak that could exhaust AISStream's per-key concurrent-connection limit (previously surfaced as a `429` in `/ais/status`'s `last_error`).
- **2026-09-07 audit:** Full archive-level inspection (frontend, backend, ML service, data/model artifacts, API wiring, docs, tests). Fixed a frontend env-var mismatch (`VITE_API_BASE_URL` documented vs `VITE_API_URL` actually read), corrected stale route-model metadata about AIS integration, and refreshed project documentation. See `AUDIT_REPORT.md` for full findings.

Note: earlier drafts of `README.md` and `AUDIT_REPORT.md` referred to this section as "`PROJECT_MANUAL.md` §13" — the manual file is actually named `FreightSight_Project_Manual.md`; both other documents have been corrected to match.
