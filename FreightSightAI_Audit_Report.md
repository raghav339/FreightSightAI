# FreightSightAI — Updated Project Audit Report

**Audit date:** 2026-09-13  
**Audited archive:** `FreightSightAI(3).zip`  
**Project:** SIH 26006 — Intelligent Freight Forecasting Model for Optimized Vessel Chartering and Bulk Cargo Procurement

---

## 1. Executive Summary

The latest archive was re-audited after the previous FreightSightAI audit.

### Overall status

**Status: FUNCTIONAL MVP — NOT YET RELEASE-READY**

The core ML and application logic is substantially implemented and the important SIH 26006 workflow is present. The latest archive also contains several fixes from the previous audit, including:

- MySQL schema migration support for newer columns.
- Explicit synthetic/market-proxy labelling.
- Newcastle → Chennai → Iron Ore route support.
- Updated forecast metadata and freshness handling.
- AIS persistence/schema support.
- More complete forecast response fields.
- Route-model cargo/vessel inputs being passed through correctly.

However, the new audit found **6 failing ML tests out of 80**:

- **74 passed**
- **6 failed**

Five failures are caused by a stale/incompatible test fake used by the baseline-guardrail tests. One failure exposes a genuine behavior/test-contract issue: an exact destination+commodity lookup can currently receive `data_confidence = low` when the H+1 forecast is gated to naive persistence and its confidence becomes `0.0`.

There is also a **release-security issue**: the supplied archive contains a populated `backend/.env` file. Even though `.gitignore` excludes `.env`, the secret-bearing file should not be distributed in a project archive or committed to a repository.

---

# 2. Audit Scope

The following areas were inspected:

- Backend Node.js source
- Frontend source and configuration
- FastAPI ML service
- ML models and metadata
- Training/data files
- Route freight model
- Synthetic market-proxy implementation
- AIS integration
- MySQL schema and migrations
- Forecast API wiring
- COA optimizer
- Compare Origins
- Idle Vessel functionality
- Tests
- Environment/configuration files
- Documentation
- JavaScript syntax
- End-to-end ML test suite

The archive contained approximately 966 entries, with the `.git`, dependency trees and generated caches excluded from the executable source inspection.

---

# 3. Current Audit Results

| Area | Result |
|---|---|
| Backend JavaScript syntax | PASS |
| ML Python test suite | **74 PASS / 6 FAIL** |
| Route freight tests | PASS — 4/4 |
| Synthetic Newcastle → Chennai → Iron Ore tests | PASS — 2/2 |
| Forecast integration tests | 7/8 PASS |
| Baseline guardrail tests | 2/7 PASS |
| MySQL migration implementation | Present |
| AIS persistence implementation | Present |
| Synthetic route labelling | Present |
| Route cargo/vessel feature forwarding | Fixed/present |
| Frontend production build | NOT VERIFIED — dependencies absent |
| Backend Jest suite | NOT VERIFIED — dependencies absent |
| Security / archive hygiene | **FAIL — populated `.env` included** |

---

# 4. Findings

## F-01 — Populated `backend/.env` is included in the archive

**Severity: CRITICAL / RELEASE BLOCKER**

The supplied archive contains:

`backend/.env`

It contains populated environment variables including database configuration and JWT-related configuration.

The repository `.gitignore` correctly contains rules for `.env`, but the file is nevertheless present in the distributed archive.

### Why this matters

If the archive is uploaded to GitHub, shared with judges, submitted publicly, or otherwise distributed, credentials can be exposed.

### Required fix

Before final submission:

1. Remove `backend/.env` from the project archive.
2. Keep only `.env.example`.
3. Rotate any real database password/API key/JWT secret that was exposed in the archive.
4. Confirm `.env` is ignored by Git.
5. Check Git history if the real credentials were ever committed.

**Do not put real secrets into the final SIH submission ZIP.**

---

## F-02 — Five baseline-guardrail tests use an incompatible fake object

**Severity: HIGH — TEST SUITE DEFECT**

Five failures come from:

`ml-service/tests/test_baseline_guardrail.py`

The `_FakeRouteFreight` test double is intended to behave like `RouteFreightModel`, but its `predict()` implementation is incorrectly nested inside `__init__` rather than exposed as a class method.

The production code now correctly calls:

`route_freight.predict(...)`

with the request's:

- commodity
- cargo size
- vessel class

The fake therefore raises:

`AttributeError: '_FakeRouteFreight' object has no attribute 'predict'`

### Affected tests

- `ModelBundleNeverServesAFailingRouteModel::test_falls_back_when_baseline_result_is_unknown`
- `ModelBundleNeverServesAFailingRouteModel::test_falls_back_when_route_model_fails_baseline`
- `ModelBundleNeverServesAFailingRouteModel::test_uses_route_model_when_it_beats_baseline`
- `RouteModelNeverServesAFailingRouteModel::test_falls_back_when_route_model_fails_baseline`
- `RouteModelNeverServesAFailingRouteModel::test_uses_route_model_when_it_beats_baseline`

### Assessment

This is primarily a **test-maintenance problem**, not evidence that the production route model is broken.

### Required fix

Move `_FakeRouteFreight.predict()` out of `__init__` and define it as an actual class method with the same callable interface as the production model.

Then rerun the full suite.

---

## F-03 — Exact destination+commodity match can be reported as low confidence

**Severity: MEDIUM**

The test:

`test_data_confidence_matches_data_source_level_mapping`

currently fails.

For:

- destination: `Paradip`
- commodity: `Coal`

the lookup correctly resolves to:

`data_source_level = destination_commodity`

but the returned result can be:

`data_confidence = low`

because the H+1 forecast has:

- `confidence = 0.0`
- `model_beats_baseline = false`
- `gated_to_naive_persistence = true`

The current `_data_confidence()` logic intentionally lowers confidence when forecast uncertainty is sufficiently poor.

### Assessment

The behavior is internally explainable, but it conflicts with the current test contract:

> An exact destination+commodity match should not be reported as low confidence.

This needs a product decision.

### Recommended fix

Do **not** blindly force exact data matches to `high`.

Instead, distinguish:

- **data confidence** — quality/directness of the underlying data match
- **forecast/model confidence** — confidence in the actual prediction

For example:

`data_source_level = destination_commodity`

can remain:

`data_confidence = medium`

while the forecast separately reports:

`forecast_confidence = low`

This is clearer and avoids mixing data quality with model uncertainty.

---

# 5. Previous Audit Issues — Current Status

## P-01 — Frontend environment variable mismatch

**Status: FIXED**

`frontend/.env.example` now matches the frontend client variable used by the application.

---

## P-02 — Stale route-model metadata

**Status: FIXED / UPDATED**

The route-model documentation/metadata has been updated to reflect the current AIS and route-model implementation.

---

## P-03 — Documentation drift

**Status: FIXED / IMPROVED**

The archive contains updated:

- `README.md`
- `PROJECT_MANUAL.md`
- `FreightSight_Project_Manual.md`
- `docs/SIH26006_TRACEABILITY.md`

The documentation now explicitly explains the synthetic MVP route-rate architecture.

---

## P-04 — MySQL schema migration problem

**Status: IMPROVED / FIX IMPLEMENTED**

`backend/src/db/initMysql.js` now contains migration handling for newer fields, including forecast request/result and alert fields.

The implementation uses idempotent schema updates rather than simply dropping the existing database.

This addresses the earlier problem where an old Aiven database could be missing columns required by the current application.

---

## P-05 — Synthetic route rate incorrectly represented as observed data

**Status: FIXED**

The current implementation explicitly distinguishes synthetic/market-proxy data from verified observed freight data.

The documentation also states that the current route-rate training data is synthetic MVP data.

---

## P-06 — `latest_feature_date` was misleading

**Status: FIXED / IMPROVED**

The current response derives the latest feature date from training/test metadata instead of presenting an arbitrary or misleading date.

---

## P-07 — Route model did not receive request cargo/vessel information

**Status: FIXED**

The current code explicitly forwards:

- `cargo_size_t`
- normalized `vessel_class`
- commodity

to the route freight model.

This is an important functional correction because the prediction should respond to the user's actual shipment/vessel inputs rather than silently relying on the last historical observation.

---

# 6. SIH 26006 Core Functionality Verification

## 6.1 Newcastle → Chennai → Iron Ore

**Status: PASS**

The archive contains explicit support for:

**Newcastle → Chennai → Iron Ore**

as route **R8**.

Dedicated synthetic market-proxy tests are present and pass:

**2/2 tests passed.**

This is important because this was the intended synthetic MVP demonstration route.

---

## 6.2 Route freight model

**Status: PASS WITH DATA LIMITATION**

Dedicated route-freight tests:

**4/4 passed**

The route model is present and integrated into the forecasting flow.

However, the model's current training data is still synthetic MVP route-rate data rather than verified broker/market freight observations.

Therefore it should be presented to judges as:

> A route-level freight forecasting prototype trained on synthetic MVP observations, designed so verified commercial freight data can replace the synthetic training layer later.

It should **not** be presented as a model trained on real observed route freight rates.

---

## 6.3 Market proxy / BDRY fallback

**Status: IMPLEMENTED**

The application has a BDRY-based market-proxy fallback and baseline guardrail logic.

The intended hierarchy is now:

1. Use an eligible route-specific model when supported.
2. Compare against the naive persistence baseline.
3. Do not serve a route model that fails the guardrail.
4. Fall back to the market-proxy path.

The current baseline tests need their fake object repaired before the full guardrail suite can verify this cleanly.

---

## 6.4 AIS

**Status: IMPLEMENTED**

The archive contains:

- AIS integration
- AIS status endpoint
- AIS freshness handling
- AIS persistence support
- fallback behavior when live AIS is unavailable

Live AIS still requires the configured AISStream API key.

Therefore:

> AIS is an optional live-data enhancement, not a dependency required for the core forecast to function.

---

## 6.5 Vessel feasibility

**Status: IMPLEMENTED**

The project checks vessel feasibility at both the origin and destination side.

The system can distinguish cases such as:

- recommended vessel
- requested vessel feasible
- requested vessel not feasible
- no feasible vessel

This is aligned with the operational constraints described in SIH 26006.

---

## 6.6 Idle-vessel alternatives

**Status: IMPLEMENTED**

The idle-vessel workflow is present and contains logic to exclude the current port when searching for alternatives.

The feature therefore represents an operational decision-support workflow rather than simply displaying arbitrary vessels.

---

## 6.7 COA Optimizer

**Status: IMPLEMENTED**

The COA optimizer is present and covered by dedicated ML tests.

---

## 6.8 Compare Origins

**Status: IMPLEMENTED**

The Compare Origins functionality is present and tested.

The design separates the common market signal from origin-specific operational differences such as:

- vessel feasibility
- port conditions
- congestion
- operational suitability

---

# 7. Test Results

The full ML suite was executed against the supplied archive.

### Overall

**74 passed / 6 failed**

### Breakdown

| Test file | Result |
|---|---:|
| `test_baseline_guardrail.py` | **2 passed / 5 failed** |
| `test_coa_optimizer.py` | PASS |
| `test_compare_origins.py` | PASS |
| `test_fallback_hierarchy.py` | PASS |
| `test_idle_alternatives.py` | PASS |
| `test_idle_detector.py` | PASS |
| `test_port_utils.py` | PASS |
| `test_predict_integration.py` | **7 passed / 1 failed** |
| `test_risk_walk_forward_cv.py` | PASS |
| `test_route_freight_model.py` | PASS — 4/4 |
| `test_route_model.py` | PASS |
| `test_synthetic_market_proxy.py` | PASS — 2/2 |

### Interpretation

The ML service is **not currently a clean 100% test pass**.

However, the failures are concentrated:

- 5 are caused by the stale test double.
- 1 is a confidence-contract issue.

There was no broad failure across route freight, AIS, port utilities, COA, idle-vessel, comparison, or synthetic-route functionality.

---

# 8. Backend Verification

JavaScript syntax checking was performed against the available backend/application JavaScript source.

**Result: PASS**

No syntax errors were found in the inspected `.js` files.

### Important limitation

The archive does not contain usable installed `node_modules` for the backend/frontend.

Therefore:

- `npm test` was not independently executed.
- Backend Jest integration tests remain unverified in this environment.
- Frontend production build remains unverified in this environment.

This should not be interpreted as "the frontend/backend tests pass."

---

# 9. Frontend Verification

The frontend source and configuration were inspected.

The production build could not be completed from the archive because the required dependency installation was not available in the audit environment.

### Final machine verification required

```bash
cd frontend
npm install
npm run build
```

Then manually test:

1. Login/register
2. Forecast
3. Compare Origins
4. Idle Vessel Finder
5. COA Optimizer
6. History
7. PDF export
8. English-only UI
9. Forecast explanations and confidence labels
10. AIS status

---

# 10. Data and Model Limitations

These are not necessarily coding bugs, but they materially affect what the project should claim.

### Route freight training data

Current route-rate training is synthetic MVP data.

The model metadata indicates no verified observed route-rate rows for the current route-freight training layer.

### Historical operational data

Some historical operational inputs, particularly PortWatch-derived features, do not extend to the current date.

### Live AIS

Live AIS requires an AISStream API key.

### Port constraints

Port infrastructure/constraint information is reference/estimated data and should be operationally verified before real chartering decisions.

### Risk model

The high-risk class has limited representation in the primary holdout, so high-risk predictions should not be marketed as highly reliable.

### Business usage

The product is decision support.

It does not automatically execute charter contracts or purchase cargo.

---

# 11. Recommended Fix Priority

## P0 — Must fix before final submission

### 1. Remove secrets from archive

Remove:

`backend/.env`

Keep:

`backend/.env.example`

Rotate exposed credentials if they are real.

### 2. Repair `_FakeRouteFreight.predict()`

Move the fake's `predict()` method into the class body.

### 3. Resolve data-confidence semantics

Separate:

- data-source confidence
- forecast/model confidence

Preferably keep an exact data match at `medium` or `high` data confidence while separately reporting low forecast confidence when the model is gated to naive persistence.

---

# 12. P1 — Strongly Recommended

### 4. Run complete backend tests

On a normal development machine:

```bash
cd backend
npm install
npm test
```

### 5. Build frontend

```bash
cd frontend
npm install
npm run build
```

### 6. Run full ML suite again

```bash
cd ml-service
pip install -r requirements.txt
python -m pytest -q
```

Target:

**80 passed / 0 failed**

### 7. Perform deployed smoke testing

Verify the Render frontend → backend → ML service → MySQL/Aiven path using the production environment variables.

---

# 13. Final Assessment

### Current rating

**8.0/10 as an SIH 26006 MVP**

### Why it scores well

- Clear SIH 26006 alignment.
- Route freight forecasting is actually implemented.
- Synthetic route-rate methodology is explicitly documented.
- Newcastle → Chennai → Iron Ore is supported.
- Market-proxy fallback is implemented.
- Vessel feasibility is integrated.
- AIS functionality exists.
- Idle vessel detection/alternatives exist.
- COA and origin comparison workflows are implemented.
- MySQL persistence/migration work is substantially stronger than the previous audit.
- The codebase has meaningful automated ML tests.

### What prevents a higher score

1. Real verified route freight data is not yet available in the training layer.
2. Six automated tests currently fail.
3. The archive contains a populated `.env`.
4. Frontend and backend full test/build verification remains incomplete in the audit environment.
5. Forecast/data confidence semantics still need clarification.

### Final verdict

**The project is suitable for SIH presentation/demo after the P0 fixes, but the current archive should not be treated as the final release ZIP.**

The most important immediate action is:

> **Remove and rotate secrets → fix the stale test fake → clarify confidence semantics → rerun all 80 ML tests → run frontend/backend tests/build on the development machine → perform final Render smoke test.**
