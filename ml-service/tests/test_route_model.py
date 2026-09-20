import sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from tests._shared_models import get_route_model, fresh_route_freight

class RouteModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model=get_route_model()

    def test_route_forecast_contract(self):
        # Newcastle->Paradip now has real synthetic route-freight coverage
        # (see scripts/generate_synthetic_route_grid.py), so this is a
        # route_specific forecast, not the old BDRY/AIS market-proxy
        # response (that fallback path was removed entirely).
        x=self.model.predict("Newcastle","Paradip","2026-09-04",10.0,commodity="Coal")
        self.assertEqual(x["forecast_type"],"route_specific")
        self.assertGreaterEqual(len(x["forecasts"]),3)
        self.assertTrue(all("predicted_rate_usd_per_ton" in z for z in x["forecasts"]))
        self.assertTrue(all("rate_change_pct_vs_last_observed" in z for z in x["forecasts"]))

    def test_route_specific_model_is_preferred(self):
        class Direct:
            def predict(self, origin, destination, shipment_date, commodity=None):
                return {"forecast_type": "route_specific", "route": f"{origin}-{destination}", "forecasts": [{"x": 1}], "model_beats_baseline": True}
        self.model.route_freight = Direct()
        try:
            result = self.model.predict("Newcastle", "Paradip", "2026-09-04", 10.0)
            self.assertEqual(result["forecast_type"], "route_specific")
        finally:
            # self.model is process-wide cached (tests/_shared_models.py) and
            # shared with test_coa_optimizer.py/test_baseline_guardrail.py —
            # leaving the fake in place would silently corrupt whichever
            # test runs next in the same process.
            self.model.route_freight = fresh_route_freight()

    def test_missing_route_rejected(self):
        with self.assertRaises(ValueError):
            self.model.predict("NotAPort","Paradip","2026-09-04",10.0)

if __name__=="__main__":
    unittest.main()
