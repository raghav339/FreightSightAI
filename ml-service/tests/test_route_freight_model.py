import csv
import sys
import tempfile
import unittest
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from route_freight_model import train, RouteFreightModel


class RouteFreightModelTests(unittest.TestCase):
    def _write_rows(self, folder: Path, n=40):
        data = folder / "route_freight_observations.csv"
        cols = [
            "observation_id","observation_date","origin","destination","route_id","commodity",
            "vessel_class","cargo_size_t","freight_usd_per_t","rate_type","observation_type",
            "source_name","source_url","source_reference","publication_date","retrieval_date",
            "coverage_start","coverage_end","source_file","verification_status","verification_notes",
            "confidence","schema_version"
        ]
        with data.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for i in range(n):
                obs_date = (pd.Timestamp("2020-01-01") + pd.offsets.MonthBegin(i)).date().isoformat()
                w.writerow({
                    "observation_id": f"r{i}",
                    "observation_date": obs_date,
                    "origin": "Test Origin", "destination": "Test Destination", "route_id": "TEST_ROUTE",
                    "commodity": "thermal_coal", "vessel_class": "Panamax", "cargo_size_t": 75000,
                    "freight_usd_per_t": 10 + i * 0.1, "rate_type": "freight_usd_per_t", "observation_type": "assessment",
                    "source_name": "test", "source_url": "https://example.com/report", "source_reference": f"test:{i}",
                    "publication_date": "", "retrieval_date": "2026-09-04", "coverage_start": "", "coverage_end": "",
                    "source_file": "test.csv", "verification_status": "verified", "verification_notes": "synthetic unit-test fixture",
                    "confidence": "high", "schema_version": "1.0",
                })
        return data

    def test_empty_production_is_inactive(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            (d / "route_freight_observations.csv").write_text("observation_id,verification_status,rate_type\n", encoding="utf-8")
            meta = train(d / "models", d)
            self.assertEqual(meta["status"], "inactive")

    def test_verified_lane_trains_and_predicts(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            self._write_rows(d)
            out = d / "models"
            meta = train(out, d)
            self.assertEqual(meta["status"], "active")
            model = RouteFreightModel(out, d)
            pred = model.predict("Test Origin", "Test Destination", "2022-01-01")
            self.assertIsNotNone(pred)
            self.assertEqual(pred["forecast_type"], "route_specific")
            self.assertGreaterEqual(len(pred["forecasts"]), 1)
            self.assertEqual(pred["route_id"], "TEST_ROUTE")

    def test_checked_in_synthetic_mvp_dataset_trains_all_lanes(self):
        data_dir = ROOT / "data" / "synthetic"
        model_dir = ROOT / "models"
        model = RouteFreightModel(model_dir, ROOT / "data" / "production")
        self.assertEqual(model.data_mode, "synthetic_mvp")
        # 8 lanes x 140 monthly observations each (includes the
        # Newcastle-Chennai/R8 lane added for the market-proxy tests).
        self.assertEqual(len(model.data), 1120)
        for origin, destination, commodity in [
            ("Newcastle", "Visakhapatnam", "Coal"),
            ("Tubarao", "Paradip", "Iron Ore"),
            ("Richards Bay", "Krishnapatnam", "Coal"),
            ("Kalimantan", "Kamarajar", "Coal"),
            ("Port Hedland", "Chennai", "Iron Ore"),
            ("Norfolk", "Haldia", "Bulk Minerals And Ores"),
            ("Saldanha Bay", "Visakhapatnam", "Iron Ore"),
        ]:
            result = model.predict(origin, destination, "2026-09-01", commodity=commodity)
            self.assertIsNotNone(result)
            self.assertEqual(result["data_mode"], "synthetic_mvp")
            self.assertEqual(len(result["forecasts"]), 3)
            self.assertGreater(result["forecasts"][0]["predicted_rate_usd_per_ton"], 0)


if __name__ == "__main__":
    unittest.main()
