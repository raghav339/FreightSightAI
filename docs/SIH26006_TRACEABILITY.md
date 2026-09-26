# SIH26006 Traceability — Current MVP

## Verification status

- ML service Python compilation: **passed**
- Backend Node syntax checks: **passed**
- Direct FastAPI endpoint smoke test: **passed** (see `AUDIT_REPORT.md` for the exact endpoint list from the last full run)
- ML automated tests: the suite has grown to **185 test functions across 18 files** under `ml-service/tests/` (see the breakdown below); `AUDIT_REPORT.md` records the last executed pass/fail counts, which predate the newer disruption/port-substitution/live-mode files and should be re-run before relying on them
- Frontend production build / backend Jest suite: run these on a normal development machine after `npm install` — see the commands at the end of this document

Environment-dependent checks (frontend build, backend Jest, a live Open-Meteo call for Disruption Live mode) require a normal internet-connected development machine and are not re-verified by this document itself.

## Requirement map

| Requirement area | Implementation | Verification |
|---|---|---|
| Freight forecasting | `POST /api/forecast`, `ml-service/app/utils.py` + model artifacts | **verified** by prediction integration tests + direct `/forecast` smoke test |
| H+1/H+2/H+3 outlook | forecast curve + route model artifacts | **verified** by integration/model tests |
| Forecast transparency | `forecast_type`, `data_confidence`, `data_source_level`, UI/API fields — always route-freight-based, never a BDRY market-proxy signal | **verified** in ML tests and direct forecast response |
| Newcastle → Chennai → Iron Ore | R8 in synthetic route-freight data/model | **verified** by synthetic route-freight tests |
| Risk assessment | Deterministic rule-based score (volatility, rate shock, trend deviation, port congestion, data uncertainty) computed from the route-freight forecast — see `ModelBundle._derive_risk` in `ml-service/app/utils.py` | **verified** by baseline-guardrail + prediction-integration tests + forecast smoke test |
| Explainability | `feature_importance`, `top_drivers` | **logic present; UI build not executed in this environment** |
| Vessel selection | `port_utils.py` + forecast response | **verified** by port and integration tests |
| Origin + destination feasibility | `feasible_vessels_both_ports()` | **verified** by port/integration tests |
| Origin comparison | `POST /api/compare-origins` | **verified** by 8 comparison tests + direct endpoint smoke test |
| Idle-vessel alternatives | `idle_alternatives()` | **verified** by idle-alternative tests + direct endpoint smoke test |
| AIS route features | `ais_stream.py` + `/api/ais/route-features` | **collector logic present; live feed depends on AISStream key** |
| AIS idle detection | `idle_detector.py` | **verified** by idle-detector tests |
| Live fleet map | `/api/ais/positions` + `LiveFleetMap.jsx` | **implementation inspected; backend Jest not part of the ML pytest run** |
| Port Disruption Radar | `port_radar.py` + `/api/ais/port-radar[/:port]` | **verified** by `test_port_radar.py` (classification/scoring + real SQL against a seeded SQLite DB) and `backend/test/aisPortRadar.test.js` |
| Port Substitution Engine | `port_substitution.py` + `/api/port-substitution` | **verified** by `test_port_substitution.py` |
| Disruption Intelligence — Simulate | `utils.py::simulate_disruption` + `/api/disruption/simulate` | **verified** by `test_disruption_engine.py` (pure logic) and `test_disruption_wiring.py` (real port/lane data) |
| Disruption Intelligence — Live | `marine_weather.py` + `/api/disruption/live` | **logic verified** by `test_marine_weather.py` / `test_live_disruption.py` (HTTP layer mocked — not exercised against the real Open-Meteo API in this environment) |
| Disruption decision brief (PDF) | `/api/disruption/decision-brief` | **verified** by `backend/test/disruptionBriefLogic.test.js` and `disruptionBriefRoute.test.js` |
| Forecast decision brief (PDF) | `/api/forecast/:resultId/decision-brief` | **verified** by `backend/test/decisionBriefLogic.test.js` and `decisionBriefRoute.test.js` |
| Model calibration | `/api/calibration/summary` + `/calibration` page | **implementation inspected; not covered by an automated test file** |
| COA optimization | `coa_optimizer.py` + `/api/coa-optimize` | **verified** by optimizer test + direct endpoint smoke test |
| What-if | `/api/whatif` delegating to forecast decision logic | **verified** by `backend/test/whatif.test.js` |
| History | `/api/history` + DB | **verified** by `backend/test/history.test.js` |
| Alerts | `/api/alerts` + DB | **verified** by `backend/test/alerts.test.js` |
| PDF export | `/api/forecast/:resultId/pdf` | **verified** by `backend/test/pdfExport.test.js` |
| Authentication | register/login/me + JWT | **implementation inspected; no dedicated auth test file yet** |

## Test inventory

The ML test suite currently has **185 test functions across 18 files** under `ml-service/tests/` (static count; see `AUDIT_REPORT.md` for the last executed pass/fail results):

| Test file | Test functions |
|---|---:|
| `test_baseline_guardrail.py` | 7 |
| `test_brent.py` | 11 |
| `test_coa_optimizer.py` | 7 |
| `test_compare_origins.py` | 10 |
| `test_disruption_engine.py` | 24 |
| `test_disruption_wiring.py` | 15 |
| `test_idle_alternatives.py` | 7 |
| `test_idle_detector.py` | 5 |
| `test_lazy_models.py` | 4 |
| `test_live_disruption.py` | 10 |
| `test_marine_weather.py` | 12 |
| `test_port_radar.py` | 29 |
| `test_port_substitution.py` | 14 |
| `test_port_utils.py` | 14 |
| `test_predict_integration.py` | 8 |
| `test_route_freight_model.py` | 3 |
| `test_route_model.py` | 3 |
| `test_synthetic_market_proxy.py` | 2 |
| **Total** | **185** |

The backend has a Jest suite under `backend/test/` — see `backend/test/README.md` for a per-file description covering history, alerts, PDF export, port radar proxying, forecast/disruption decision briefs, and what-if.

## Important data/model limitations

1. Current route USD/t observations are synthetic MVP data, not broker quotes.
2. Route model metadata records 46,900 synthetic rows (335 lanes × ~140 months) and 0 verified rows.
3. Of 1,005 route/horizon model combinations (335 lanes × 3 horizons), 1,004 beat naive persistence and 1 does not. The application has a guardrail that prevents failed route models from being silently served — it raises rather than falling back to any other signal.
4. Live AISStream can provide inference-time operational updates when configured.
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
