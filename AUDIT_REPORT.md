# FreightSight Audit Report — 2026-09-07

> **Refresh note (this pass):** Re-checked against the current archive. Python compilation (33 files) and Node syntax checks were re-verified and still pass. The ML test *count* has grown from 64 to 68 since the original audit date (see the corrected table below) — the filename/manual-name inconsistencies noted in the original findings have also been corrected here. Full `pytest`/`npm test`/`npm run build` execution could not be re-run in this environment (no network access to install pinned dependencies); this remains the same environment-limitation the original audit disclosed.

## Scope

Full archive-level inspection of frontend, backend, ML service, model/data artifacts, API wiring, configuration examples, documentation, tests and service integration.

## Findings

### Fixed

1. **Frontend environment variable mismatch**
   - `frontend/.env.example` documented `VITE_API_BASE_URL`.
   - `frontend/src/api/client.js` actually reads `VITE_API_URL`.
   - Fixed the example to use `VITE_API_URL`.
   - This could otherwise cause a deployed frontend to ignore the configured backend URL and fall back to `/api`.

2. **Stale route-model metadata documentation**
   - `ml-service/models/route_model_metadata.json` said direct AIS was not supplied, while the current code implements AISStream inference-time integration.
   - Updated metadata to reflect the actual implementation.

3. **Project documentation drift**
   - Updated `README.md`.
   - Added `FreightSight_Project_Manual.md`.
   - Updated `docs/SIH26006_TRACEABILITY.md` to reflect the ML verification result and the actual dependency-limited checks.

### No blocking defect found in executable ML logic

The ML service compiled successfully (33/33 `.py` files, re-verified in this refresh) and Node syntax checks passed for every backend source file. At the original audit date, 64 ML tests were recorded as passing file-by-file. **This refresh found the suite has since grown to 68 tests** (`test_coa_optimizer.py` and `test_idle_alternatives.py` each gained tests) — see the corrected table below. This refresh confirmed the count and that the ML service still compiles cleanly; it could not re-execute `pytest` itself, because this verification environment has no network access to install the pinned dependencies (`fastapi==0.115.0`, etc.). Re-run the suite on a connected machine to confirm all 68 currently pass.

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
- Failed route-specific models are guarded by baseline comparison and can fall back to the BDRY market proxy.
- Synthetic route freight is explicitly labelled rather than presented as observed broker data.
- Newcastle → Chennai → Iron Ore is supported as route R8.
- Idle-vessel alternatives exclude the current port.
- Live AIS is optional and the system has a non-live fallback.
- Authenticated history is separated from public forecasting.

## Environment-limited verification

The supplied archive did not contain a usable frontend dependency installation, and the backend `node_modules` tree was incomplete.

Attempts to install npm dependencies could not complete within the execution environment. Consequently:

- `npm test` could not run because `cross-env`/Jest binaries were unavailable.
- `npm run build` could not run because frontend dependencies were unavailable.

These are verification-environment limitations, not claims that the missing suites pass.

## ML test results

| Test file | Test count (2026-09-07 audit) | Test count (this refresh) |
|---|---:|---:|
| `test_baseline_guardrail.py` | 7 | 7 |
| `test_coa_optimizer.py` | 1 | 4 |
| `test_compare_origins.py` | 8 | 8 |
| `test_fallback_hierarchy.py` | 4 | 4 |
| `test_idle_alternatives.py` | 6 | 7 |
| `test_idle_detector.py` | 5 | 5 |
| `test_port_utils.py` | 12 | 12 |
| `test_predict_integration.py` | 8 | 8 |
| `test_risk_walk_forward_cv.py` | 5 | 5 |
| `test_route_freight_model.py` | 3 | 3 |
| `test_route_model.py` | 3 | 3 |
| `test_synthetic_market_proxy.py` | 2 | 2 |
| **Total** | **64** | **68** |

The "this refresh" column was obtained by statically counting `def test_...` methods in each file in the current archive, since this environment could not install dependencies to run `pytest` directly. It is a verified *count*, not a fresh pass/fail execution — run the suite on a connected machine to confirm all 68 pass.

## Data/model limitations

- Route-rate model training currently uses synthetic MVP route-rate observations (`verified_rows: 0`).
- The route model metadata contains 24 route/horizon combinations; 22 pass the naive-persistence guardrail and 2 fail it.
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
