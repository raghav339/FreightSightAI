# FreightSight Audit Report — 2026-09-07

> **Note:** this report is a point-in-time record of the audit run below. Several features shipped afterwards — Port Disruption Radar, the Port Substitution Engine, Disruption Intelligence (Simulate and Live modes), the Live Fleet Map, model calibration, and forecast/disruption PDF decision briefs — are not covered by the findings or test counts in this document. See the **2026-09-26 addendum** at the end of this file, and `docs/SIH26006_TRACEABILITY.md`, for current status.

## Scope

Full archive-level inspection of frontend, backend, ML service, model/data artifacts, API wiring, configuration examples, documentation, tests and service integration, as of the date above.

## Findings

### Fixed

1. **Frontend environment variable mismatch**
   - `frontend/.env.example` documented `VITE_API_BASE_URL`.
   - `frontend/src/api/client.js` actually reads `VITE_API_URL`.
   - Fixed the example to use `VITE_API_URL`.
   - This could otherwise cause a deployed frontend to ignore the configured backend URL and fall back to `/api`.

2. **Stale route-model metadata documentation**
   - `ml-service/models/route_freight_model_metadata.json` said direct AIS was not supplied, while the current code implements AISStream inference-time integration.
   - Updated metadata to reflect the actual implementation.

3. **Project documentation drift**
   - Updated `README.md`.
   - Added `FreightSight_Project_Manual.md`.
   - Updated `docs/SIH26006_TRACEABILITY.md` to reflect the ML verification result and the actual dependency-limited checks.

### No blocking defect found in executable ML logic

The ML service compiled successfully and all 64 ML tests passed when run file-by-file.

Direct FastAPI smoke tests also succeeded for:

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

Backend JavaScript syntax checks passed for the application, server, routes, middleware, database and utility source files.

### Important behavior verified

- Forecasting continues even when a requested vessel is physically infeasible.
- Vessel feasibility checks both origin and destination.
- Failed route-specific models are guarded by baseline comparison; a lane whose model doesn't beat naive persistence is refused outright (raises, surfaced as HTTP 400) rather than falling back to any other signal. There is no BDRY market-proxy fallback — that pipeline was removed entirely.
- Synthetic route freight is explicitly labelled rather than presented as observed broker data.
- Every origin x destination x commodity lane the app can route a request to has synthetic route-freight coverage (see `scripts/generate_synthetic_route_grid.py`), including Newcastle → Chennai → Iron Ore (route R8).
- Idle-vessel alternatives exclude the current port.
- Live AIS is optional and the system has a non-live fallback.
- Authenticated history is separated from public forecasting.

## Environment-limited verification

The supplied archive did not contain a usable frontend dependency installation, and the backend `node_modules` tree was incomplete.

Attempts to install npm dependencies could not complete within the execution environment. Consequently:

- `npm test` could not run because `cross-env`/Jest binaries were unavailable.
- `npm run build` could not run because frontend dependencies were unavailable.

These are verification-environment limitations, not claims that the missing suites pass.

## ML test results (post BDRY-removal refactor)

The BDRY forecast/risk-classifier pipeline (`train.py`, `route_model_h*.joblib`) was removed entirely; every forecast now comes from the route-freight model only. `test_risk_walk_forward_cv.py` and `test_fallback_hierarchy.py` tested that removed pipeline directly and were deleted rather than patched. Each file below passes individually; running the full `tests/` directory in one process can hit this machine's ~4GB RAM ceiling once enough model-loading test classes stack up in the same process — run per-file or in small groups.

| Test file | Passed |
|---|---:|
| `test_baseline_guardrail.py` | 7 |
| `test_coa_optimizer.py` | 3 (+ 1 pre-existing failure, unrelated to the BDRY removal — see below) |
| `test_compare_origins.py` | 8 |
| `test_idle_alternatives.py` | 7 |
| `test_idle_detector.py` | 5 |
| `test_port_utils.py` | 12 |
| `test_predict_integration.py` | 8 |
| `test_route_freight_model.py` | 3 |
| `test_route_model.py` | 3 |
| `test_synthetic_market_proxy.py` | 2 |
| **Total** | **58** |

## Data/model limitations

- Route-rate model training currently uses synthetic MVP route-rate observations (`verified_rows: 0`).
- The route model metadata contains 1,005 route/horizon combinations (335 lanes × 3 horizons); 1,004 pass the naive-persistence guardrail and 1 does not (`Port Hedland|Chennai|R5 H+2`, a pre-existing lane predating the full-grid generation).
- `test_coa_optimizer.py::test_cargo_weight_tons_supplied_drives_voyage_count` fails: a 90,000t lift at Newcastle rejects Capesize on origin-port draft (16.2m usable vs. 18.0m typical draft) and no smaller class reaches 90,000t capacity. This is entirely static port/vessel reference data (`port_infra_wpi_expanded.json`, `VESSEL_LIMIT_SPECS`) — unrelated to the BDRY-removal refactor and not yet root-caused.
- Historical PortWatch-derived operational features end in October 2024.
- Live AIS requires an AISStream API key.
- Port constraints are reference/estimated data and require current operational verification.
- Risk high-class representation is limited in the primary holdout.
- The product is decision support, not automated charter execution.

## Recommended final verification on a normal development machine

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

Then perform a browser smoke test of:

1. Login/register
2. Forecast
3. Compare Origins
4. Idle Vessel Finder
5. COA Optimizer
6. History
7. PDF export
8. English-only interface and decision text
9. AIS status with and without an API key

## Addendum — 2026-09-26

Full-project bug sweep covering everything added since the original audit above.

**Static/structural checks — all passed:**
- Python compilation across every file in `ml-service`
- Node syntax check across every file in `backend/src`
- esbuild bundle of the full frontend entry point — every relative import resolves; no broken paths
- Resolution of every relative `require()` in `backend/src`

**Executed test run:** the full ML test suite was actually run (`python -m unittest discover -s tests`) against the real, checked-in production port/vessel/route-freight data — **185/185 tests passed**. This required a minimal local stand-in for `pydantic` (no network access to install the real package in this environment); it supports plain attribute construction only, not pydantic's validation, so this is not a substitute for running the suite with the real dependencies installed, but it did let the actual business logic run end-to-end rather than just being read statically.

**Bug found and fixed:** `ModelBundle.predict` (`ml-service/app/utils.py`) left `vessel_rejection_reason` as `null` in the response whenever no `vessel_type` was requested and no vessel class fit both ports — even though a specific reason (e.g. a named port's draft/LOA/beam limit) was already computed and shown elsewhere in the same response (`vessel_constraint_note`, `summary`). `WhatIfPanel.jsx` and the backend's PDF export (`routes/pdf.js`) both specifically check `vessel_rejection_reason` and fall back to a generic "no vessel class fits both ports for this cargo" message when it's null — so this bug meant that fallback fired far more often than it needed to, hiding a reason the system had already worked out. Fixed by reusing the per-vessel-class rejection detail already computed for the recommended vessel class. All 185 ML tests still pass after the fix.

**Manually exercised end-to-end (not just read statically), against real data:** `predict` (forecast), `compare_origins`, `simulate_disruption`, and `port_substitution` — all produced correct, sane output.

**Field-name consistency spot checks (ML service response → Node consumers):** Port Substitution option fields (`rank`, `port`, `delay.total_days`, `freight.delta_usd_per_ton`) used by `disruptionBriefPdf.js`, and Disruption Live's `live_conditions.{conditions,coverage}` shape used by `DisruptionSimulator.jsx` — both match the actual ML service response exactly.

**Not covered by this addendum** (same environment limitations as the original audit): an actual `npm install` + Vite production build, an actual `npm install` + backend Jest run, and a live call against the real Open-Meteo API for Disruption Live mode. Run these on a normal internet-connected development machine before a release.

