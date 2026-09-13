import sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app.route_model import RouteModel

class RouteModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model=RouteModel(ROOT/"models")
    def test_route_forecast_contract(self):
        x=self.model.predict("Newcastle","Paradip","2026-09-04",10.0)
        self.assertEqual(x["forecast_type"],"ais_enhanced_route_proxy")
        self.assertEqual(len(x["forecasts"]),3)
        self.assertTrue(all("proxy_change_pct" in z for z in x["forecasts"]))
        self.assertTrue(all("indicative_route_rate_usd_per_ton" in z for z in x["forecasts"]))

    def test_route_specific_model_is_preferred(self):
        class Direct:
            def predict(self, origin, destination, shipment_date):
                return {"forecast_type": "route_specific", "route": f"{origin}-{destination}", "forecasts": []}
        self.model.route_freight = Direct()
        result = self.model.predict("Newcastle", "Paradip", "2026-09-04", 10.0)
        self.assertEqual(result["forecast_type"], "route_specific")

    def test_missing_route_rejected(self):
        with self.assertRaises(ValueError):
            self.model.predict("NotAPort","Paradip","2026-09-04",10.0)

    def test_ais_freshness_is_exposed_and_reflects_real_data_age(self):
        """The response must expose which mode (LIVE/RECENT/STALE/
        UNAVAILABLE) actually produced the route features, and it must be
        computed from the real age of the underlying data — not from the
        requested shipment_date, and not fabricated as "now"."""
        result = self.model.predict("Newcastle", "Paradip", "2026-09-04", 10.0)
        self.assertIn("ais", result)
        ais = result["ais"]
        self.assertIn(ais["status"], ("live", "recent", "stale", "unavailable"))
        # This project's shipped PortWatch route features stop in Oct 2024 and
        # no AISStream credentials are configured in the test environment, so
        # this must honestly report "stale", not silently look current.
        self.assertEqual(ais["status"], "stale")
        self.assertEqual(ais["last_update"], "2024-10-01")

    def test_ais_freshness_reported_even_on_direct_route_freight_path(self):
        class Direct:
            def predict(self, origin, destination, shipment_date):
                return {"forecast_type": "route_specific", "route": f"{origin}-{destination}", "forecasts": []}
        original_route_freight = self.model.route_freight
        self.model.route_freight = Direct()
        try:
            result = self.model.predict("Newcastle", "Paradip", "2026-09-04", 10.0)
            self.assertIn("ais", result)
            self.assertEqual(result["ais"]["status"], "stale")
        finally:
            self.model.route_freight = original_route_freight

if __name__=="__main__":
    unittest.main()