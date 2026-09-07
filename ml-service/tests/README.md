# ML-service tests

Run with (no `pip install` required — these only need numpy/pandas/
scikit-learn/joblib, which this environment already has):

    cd ml-service
    python -m unittest discover -s tests -v

- `test_port_utils.py` — Phase 6 both-port vessel feasibility engine.
  Fully self-contained (synthetic port/vessel specs), no trained model
  needed.
- `test_fallback_hierarchy.py` — Phase 7 deterministic fallback hierarchy.
  Needs trained model artifacts in `models/` (run `python train.py`
  first if `models/metadata.json` doesn't exist yet); skips itself
  automatically otherwise rather than failing.
- `test_predict_integration.py` — full end-to-end `ModelBundle.predict()`
  runs against the checked-in production model (no `pip install`
  needed — uses a plain `SimpleNamespace` stand-in for
  `schemas.ForecastRequest` instead of pydantic). Covers the full
  response contract, the Phase 4 multi-horizon curve, Phase 2/3
  forecast-type/data-confidence labelling, and the Phase 24/25 edge
  cases (1000-tonne cargo, infeasible requested vessel).

**Known hard blocker (not a gap left on purpose):**
`ModelBundle.compare_origins()` and `.idle_alternatives()` construct real
`schemas.ForecastRequest` / request objects internally using `pydantic`
models, so they cannot be exercised in an environment without `pydantic`
installed, even indirectly. Once `pip install -r requirements.txt` is
possible, add `test_compare_origins.py` / `test_idle_alternatives.py`
following the same pattern as `test_predict_integration.py`.

As of this session: **35/35 passing**, executed directly (not just
written) against a freshly retrained model AND the checked-in production
model, in an environment with no network access — see
`docs/SIH26006_TRACEABILITY.md` for what remains untested (route-level
HTTP integration, auth flows, admin endpoints, `compare_origins`/
`idle_alternatives`, and the risk-threshold math inside `train.py`).
