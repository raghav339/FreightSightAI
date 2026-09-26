# ML-service tests

Run from `ml-service/` (needs `pip install -r requirements.txt` plus `pytest`):

    python -m pytest tests -q

The route-freight models are large, so run files one at a time if memory is tight:

    python -m pytest tests/test_port_utils.py -q

| File | Covers |
|---|---|
| `test_port_utils.py` | Both-port vessel feasibility engine (self-contained) |
| `test_predict_integration.py` | End-to-end `ModelBundle.predict()` against the checked-in models |
| `test_compare_origins.py` | Origin comparison |
| `test_idle_alternatives.py` | Idle-vessel repositioning alternatives |
| `test_idle_detector.py` | AIS idle-vessel detection |
| `test_port_radar.py` | Port Disruption Radar rules and end-to-end behaviour |
| `test_port_substitution.py` | Port Substitution Engine (vessel-fit gate + weighted ranking) |
| `test_disruption_engine.py` | Disruption Intelligence pure logic (propagation, event profiles) |
| `test_disruption_wiring.py` | Disruption Intelligence Simulate mode wired against real port/lane data |
| `test_marine_weather.py` | Open-Meteo wind/wave/precipitation parsing and severity scoring for Disruption Live mode |
| `test_live_disruption.py` | Disruption Intelligence Live mode end-to-end (marine-weather HTTP layer mocked) |
| `test_coa_optimizer.py` | COA / multi-voyage optimizer |
| `test_route_freight_model.py` | Route-freight model training and lookup |
| `test_route_model.py` | `RouteModel` wrapper |
| `test_synthetic_market_proxy.py` | Synthetic route-rate fallback |
| `test_lazy_models.py` | Per-lane lazy model loading, LRU cache, export and stale-file handling |
| `test_brent.py` | Brent cache, staleness handling and the fuel-shock risk factor |
| `test_baseline_guardrail.py` | Naive-persistence guardrail for route models |

`_shared_models.py` caches loaded models across tests. `conftest.py` sets `BRENT_ENABLED=false` so the suite stays offline and deterministic.
