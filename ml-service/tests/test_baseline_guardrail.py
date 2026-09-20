# ml-service/tests/test_baseline_guardrail.py
#
# Task 4 — "Always run and surface the baseline comparison when real data
# lands". Covers:
#   1. route_freight_model.py:train() always computes model vs.
#      naive-persistence vs. moving-average MAE per horizon, and records an
#      explicit model_beats_baseline boolean (not just a raw MAE number a
#      caller has to interpret themselves).
#   2. RouteFreightModel.predict() surfaces that flag on every forecast item
#      and at the top level (keyed off H+1, the decision point).
#   3. Neither app/utils.py:ModelBundle.predict() nor
#      app/route_model.py:RouteModel.predict() ever serve a route-specific
#      forecast that failed the baseline check as if it were the
#      authoritative forecast — this is the actual guardrail against the
#      disclosed regression (route H+1 MAE 5.76 vs. naive 3.46).
#
# Run with:
#   cd ml-service && python -m unittest tests.test_baseline_guardrail -v
#
# Tests 1-2 train real (tiny, synthetic) models — no mocking of the ML
# itself. Tests 3 use a lightweight fake in place of RouteFreightModel to
# deterministically exercise both the "model failed" and "model passed"
# branches of the guardrail without depending on any particular dataset
# happening to produce a failing model on a given run.
import csv
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from route_freight_model import train, RouteFreightModel  # noqa: E402

MODELS_DIR = ROOT / "models"


def _write_observations(folder: Path, values, route_id="TEST_ROUTE"):
    """Write a route_freight_observations.csv with an explicit monthly
    freight_usd_per_t series, so the resulting model's win/loss against
    naive persistence is a direct, predictable consequence of the series
    shape rather than left to chance."""
    path = folder / "route_freight_observations.csv"
    cols = [
        "observation_id", "observation_date", "origin", "destination", "route_id", "commodity",
        "vessel_class", "cargo_size_t", "freight_usd_per_t", "rate_type", "observation_type",
        "source_name", "source_url", "source_reference", "publication_date", "retrieval_date",
        "coverage_start", "coverage_end", "source_file", "verification_status", "verification_notes",
        "confidence", "schema_version",
    ]
    import pandas as pd
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for i, v in enumerate(values):
            obs_date = (pd.Timestamp("2018-01-01") + pd.offsets.MonthBegin(i)).date().isoformat()
            w.writerow({
                "observation_id": f"r{i}", "observation_date": obs_date,
                "origin": "Test Origin", "destination": "Test Destination", "route_id": route_id,
                "commodity": "thermal_coal", "vessel_class": "Panamax", "cargo_size_t": 75000,
                "freight_usd_per_t": v, "rate_type": "freight_usd_per_t", "observation_type": "assessment",
                "source_name": "test", "source_url": "https://example.com/report", "source_reference": f"test:{i}",
                "publication_date": "", "retrieval_date": "2026-09-04", "coverage_start": "", "coverage_end": "",
                "source_file": "test.csv", "verification_status": "verified",
                "verification_notes": "synthetic unit-test fixture", "confidence": "high", "schema_version": "1.0",
            })
    return path


class BaselineMetricsAreAlwaysComputed(unittest.TestCase):
    """(1) train() always reports model vs. naive vs. moving-average MAE,
    per horizon, with an explicit pass/fail flag — this must be true
    whether the model happens to win or lose."""

    def test_noisy_series_produces_explicit_pass_fail_flags(self):
        # A pure random-walk-with-noise series is the classic case where a
        # flexible model can easily fail to beat naive persistence — the
        # exact failure mode this task guards against. We don't assert
        # which way it goes (that would be a flaky test); we assert the
        # metrics needed to know are always present and internally
        # consistent.
        import numpy as np
        rng = np.random.RandomState(7)
        values = list(100 + np.cumsum(rng.normal(0, 5, size=40)))
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            _write_observations(d, values)
            meta = train(d / "models", d)
            self.assertEqual(meta["status"], "active")
            key = "Test Origin|Test Destination|TEST_ROUTE"
            self.assertIn(key, meta["metrics"])
            for h in meta["metrics"][key]:
                m = meta["metrics"][key][h]
                for field in (
                    "mae_usd_per_t", "naive_mae_usd_per_t", "moving_average_mae_usd_per_t",
                    "beats_naive_persistence", "beats_moving_average", "model_beats_baseline",
                ):
                    self.assertIn(field, m, f"H+{h} metrics missing '{field}'")
                # The primary pass/fail bar is naive persistence specifically
                # (per the disclosed finding this task fixes), and must be
                # internally consistent with the raw MAE numbers.
                self.assertEqual(m["model_beats_baseline"], m["beats_naive_persistence"])
                self.assertEqual(m["mae_usd_per_t"] < m["naive_mae_usd_per_t"], m["beats_naive_persistence"])
            self.assertIn("baseline_summary", meta)
            self.assertEqual(
                meta["baseline_summary"]["total_route_horizon_models"],
                meta["baseline_summary"]["passed"] + meta["baseline_summary"]["failed"],
            )

    def test_predict_surfaces_the_flag_per_horizon_and_at_top_level(self):
        import numpy as np
        rng = np.random.RandomState(3)
        values = list(100 + np.cumsum(rng.normal(0, 5, size=40)))
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            _write_observations(d, values)
            out = d / "models"
            train(out, d)
            model = RouteFreightModel(out, d)
            pred = model.predict("Test Origin", "Test Destination", "2021-06-01")
            self.assertIsNotNone(pred)
            self.assertIn("model_beats_baseline", pred)
            self.assertIsInstance(pred["model_beats_baseline"], bool)
            for item in pred["forecasts"]:
                self.assertIn("model_beats_baseline", item)
                self.assertIn("baseline_mae_usd_per_t", item)
                self.assertIn("model_mae_usd_per_t", item)
            h1 = next(item for item in pred["forecasts"] if item["horizon_months"] == 1)
            self.assertEqual(pred["model_beats_baseline"], h1["model_beats_baseline"])


class _FakeRouteFreight:
    """Deterministic stand-in for RouteFreightModel — returns exactly the
    shape route_freight_model.RouteFreightModel.predict() would, with a
    controllable model_beats_baseline flag, so the guardrail's two branches
    are each exercised on purpose rather than by chance."""

    def __init__(self, beats_baseline):
        self._beats_baseline = beats_baseline

    def predict(self, origin, destination, when, route_id=None, commodity=None):
        return {
            "forecast_type": "route_specific",
            "data_confidence": "medium",
            "route": f"{origin}-{destination}",
            "route_id": "FAKE_ROUTE",
            "commodity": commodity or "thermal_coal",
            "last_observed_freight_usd_per_ton": 20.0,
            "last_available_freight_usd_per_ton": 20.0,
            "predicted_freight_rate_usd_per_ton": 999.0,  # deliberately implausible
            "forecasts": [
                {
                    "horizon_months": 1, "target_date": "2026-11-01",
                    "predicted_rate_usd_per_ton": 999.0,
                    "rate_change_pct_vs_last_observed": 4895.0,
                    "basis": "observed_route_freight", "route_id": "FAKE_ROUTE",
                    "feature_source_date": "2026-10-01",
                    "model_beats_baseline": self._beats_baseline,
                    "baseline_mae_usd_per_t": 3.46, "model_mae_usd_per_t": 5.76,
                }
            ],
            "source": "route_freight_observations.csv",
            "source_data_status": "verified_production",
            "data_mode": "verified_production",
            "model_beats_baseline": self._beats_baseline,
            "disclaimer": "test fixture",
        }


def _make_forecast_request(**overrides):
    defaults = dict(
        commodity="Coal", origin_port="Newcastle", destination_port="Paradip",
        shipment_date=date(2026, 10, 1), cargo_weight_tons=75000.0,
        cargo_volume_cbm=None, shipment_mode="Bulk Carrier", vessel_type=None,
        distance_km=None, delay_days=0, contract_duration_months=None,
        total_program_tons=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@unittest.skipUnless(
    os.path.exists(os.path.join(MODELS_DIR, "metadata.json")),
    "No trained model artifacts found — run route_freight_model.py:train() first.",
)
class ModelBundleNeverServesAFailingRouteModel(unittest.TestCase):
    """(3a) app/utils.py:ModelBundle.predict() must never serve a
    route-specific forecast that failed (or has no recorded result for) the
    baseline check as if it were authoritative. There is no longer a BDRY
    market-proxy fallback to silently substitute — a failing/unknown
    baseline result means predict() refuses the request outright (raises
    ValueError), and app/main.py turns that into a 400."""

    @classmethod
    def setUpClass(cls):
        from tests._shared_models import get_bundle

        cls.bundle = get_bundle()

    def test_refuses_when_route_model_fails_baseline(self):
        self.bundle.route_freight = _FakeRouteFreight(beats_baseline=False)
        with self.assertRaises(ValueError):
            self.bundle.predict(_make_forecast_request())

    def test_refuses_when_baseline_result_is_unknown(self):
        # No recorded comparison (None) must be treated the same as a
        # failure — never assumed to be a pass by default.
        self.bundle.route_freight = _FakeRouteFreight(beats_baseline=None)
        with self.assertRaises(ValueError):
            self.bundle.predict(_make_forecast_request())

    def test_uses_route_model_when_it_beats_baseline(self):
        self.bundle.route_freight = _FakeRouteFreight(beats_baseline=True)
        result = self.bundle.predict(_make_forecast_request())
        self.assertIn(result["forecast_type"], ("route_specific", "synthetic_route"))
        self.assertEqual(result["predicted_freight_rate_usd_per_ton"], 999.0)
        self.assertEqual(result["route_model_beats_baseline"], True)
        self.assertIsNone(result["route_model_fallback_note"])

    @classmethod
    def tearDownClass(cls):
        # Restore the real route_freight model once, after all tests in
        # this class have run — each test already sets its own fake at the
        # start of its body, so per-test restoration isn't needed for
        # intra-class isolation, only for whichever class/file runs next
        # against this process-wide cached bundle (see
        # tests/_shared_models.py).
        from tests._shared_models import fresh_route_freight

        cls.bundle.route_freight = fresh_route_freight()


class RouteModelNeverServesAFailingRouteModel(unittest.TestCase):
    """(3b) app/route_model.py:RouteModel.predict() — the /route-forecast
    and /coa-optimize path — must refuse (raise ValueError) rather than
    serve a route-specific forecast known to have lost to naive
    persistence. There is no BDRY market-proxy fallback to fall through to
    any more (see app/route_model.py's module docstring)."""

    @classmethod
    def setUpClass(cls):
        from tests._shared_models import get_route_model

        cls.model = get_route_model()

    def test_refuses_when_route_model_fails_baseline(self):
        self.model.route_freight = _FakeRouteFreight(beats_baseline=False)
        with self.assertRaises(ValueError):
            self.model.predict("Newcastle", "Paradip", "2026-10-01")

    def test_uses_route_model_when_it_beats_baseline(self):
        self.model.route_freight = _FakeRouteFreight(beats_baseline=True)
        result = self.model.predict("Newcastle", "Paradip", "2026-10-01")
        self.assertEqual(result["forecast_type"], "route_specific")

    @classmethod
    def tearDownClass(cls):
        # Same reasoning as ModelBundleNeverServesAFailingRouteModel
        # above — this instance is process-wide cached and shared with
        # test_route_model.py/test_coa_optimizer.py, so a fake left behind
        # here would silently corrupt whichever test runs next.
        from tests._shared_models import fresh_route_freight

        cls.model.route_freight = fresh_route_freight()


if __name__ == "__main__":
    unittest.main()
