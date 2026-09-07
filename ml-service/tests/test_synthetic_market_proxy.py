import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.route_model import RouteModel
from route_freight_model import RouteFreightModel


class TestNewcastleChennaiIronOreRoute(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        cls.model = RouteModel(cls.root / "models")

    def test_shared_synthetic_route_freight_data_drives_r8(self):
        result = self.model.predict(
            "Newcastle", "Chennai", "2026-09-05",
            current_spot_rate_usd_per_ton=12.0, commodity="Iron Ore"
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["forecast_type"], "route_specific")
        self.assertEqual(result["route_id"], "R8")
        self.assertEqual(result["data_mode"], "synthetic_mvp")
        self.assertEqual(result["data_confidence"], "low")
        self.assertEqual(result["route"], "Newcastle-Chennai")
        self.assertEqual(result["commodity"], "Iron Ore")
        self.assertGreaterEqual(len(result["forecasts"]), 3)
        for point in result["forecasts"]:
            self.assertIn("predicted_rate_usd_per_ton", point)
            self.assertIn("basis", point)
            self.assertEqual(point["basis"], "synthetic_route_freight")

    def test_r8_is_present_in_shared_synthetic_route_dataset(self):
        model = RouteFreightModel(self.root / "models", self.root / "data" / "production")
        self.assertTrue(model.has_route("Newcastle", "Chennai", route_id="R8", commodity="Iron Ore"))


if __name__ == "__main__":
    unittest.main()
