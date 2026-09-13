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

if __name__=="__main__":
    unittest.main()
