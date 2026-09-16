# SIH26006 Traceability — Current MVP

## Verification status

This audit was performed against the supplied FreightSight project archive.

- ML service Python compilation: **passed**
- Backend Node syntax checks: **passed**
- Direct FastAPI endpoint smoke test: **passed**
- ML automated tests: **64/64 passed when executed file-by-file**
- Frontend production build: **not executed** because frontend dependencies were unavailable in the supplied runtime and package installation could not complete.
- Backend Jest suite: **not executed** because the supplied backend `node_modules` tree was incomplete (`cross-env`/Jest binaries were unavailable).

The last two items are environment-limited checks and should be run on a normal development machine after `npm install`.

## Requirement map

| Requirement area | Implementation | Verification |
|---|---|---|
| Freight forecasting | `POST /api/forecast`, `ml-service/app/utils.py` + model artifacts | **verified** by prediction integration tests + direct `/forecast` smoke test |
| H+1/H+2/H+3 outlook | forecast curve + route model artifacts | **verified** by integration/model tests |
| Market-proxy transparency | `forecast_type`, `data_confidence`, `data_source_level`, UI/API fields | **verified** in ML tests and direct forecast response |
| Newcastle → Chennai → Iron Ore | R8 in synthetic route-freight data/model | **verified** by synthetic market-proxy tests |
| Risk assessment | `risk_model.joblib` + response risk fields | **verified** by risk walk-forward tests + forecast smoke test |
| Explainability | `feature_importance`, `top_drivers` | **logic present; UI build not executed in this environment** |
| Vessel selection | `port_utils.py` + forecast response | **verified** by port and integration tests |
| Origin + destination feasibility | `feasible_vessels_both_ports()` | **verified** by port/integration tests |
| Origin comparison | `POST /api/compare-origins` | **verified** by 8 comparison tests + direct endpoint smoke test |
| Idle-vessel alternatives | `idle_alternatives()` | **verified** by idle-alternative tests + direct endpoint smoke test |
| AIS route features | `ais_stream.py` + `/api/ais/route-features` | **collector logic present; live feed depends on AISStream key** |
| AIS idle detection | `idle_detector.py` | **verified** by idle-detector tests |
| COA optimization | `coa_optimizer.py` + `/api/coa-optimize` | **verified** by optimizer test + direct endpoint smoke test |
| What-if | `/api/whatif` delegating to forecast decision logic | **core logic covered; backend Jest not executable in supplied runtime** |
| History | `/api/history` + DB | **implementation inspected; backend Jest not executable in supplied runtime** |
| Alerts | `/api/alerts` + DB | **implementation inspected; backend Jest not executable in supplied runtime** |
| PDF export | `/api/forecast/:resultId/pdf` | **implementation inspected; backend Jest not executable in supplied runtime** |
| Authentication | register/login/me + JWT | **implementation inspected; backend Jest not executable in supplied runtime** |

## Test breakdown

The 64 passing ML tests cover:

- baseline guardrails — 7
- COA optimizer — 1
- compare origins — 8
- fallback hierarchy — 4
- idle alternatives — 6
- idle detector — 5
- port utilities — 12
- prediction integration — 8
- risk walk-forward CV — 5
- route-freight model — 3
- route model — 3
- synthetic market proxy — 2

## Important data/model limitations

1. Current route USD/t observations are synthetic MVP data, not broker quotes.
2. Route model metadata records 1,120 synthetic rows and 0 verified rows.
3. Of 24 route/horizon model combinations, 22 beat naive persistence and 2 do not. The application has a guardrail that prevents failed route models from being silently served.
4. Historical PortWatch-derived route features end at October 2024. Live AISStream can provide inference-time operational updates when configured.
5. Port dimensions and handling rates are reference/estimated data and require operational verification.
6. Risk high-class representation is limited in the primary holdout.
7. Authentication is local email/password in the current judge-facing MVP.

## Environment verification commands

```bash
# Backend
cd backend
npm install
npm test

# Frontend
cd ../frontend
npm install
npm run build

# ML
cd ../ml-service
pip install -r requirements.txt
python -m pytest -q
```
