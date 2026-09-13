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
        # 8 lanes x 140 monthly observations each.
        self.assertEqual(len(model.data), 1120)
        for origin, destination, commodity, route_id in [
            ("Newcastle", "Visakhapatnam", "Coal", "R1"),
            ("Tubarao", "Paradip", "Iron Ore", "R2"),
            ("Richards Bay", "Krishnapatnam", "Coal", "R3"),
            ("Kalimantan", "Kamarajar", "Coal", "R4"),
            ("Port Hedland", "Chennai", "Iron Ore", "R5"),
            ("Norfolk", "Haldia", "Bulk Minerals And Ores", "R6"),
            ("Saldanha Bay", "Visakhapatnam", "Iron Ore", "R7"),
            ("Newcastle", "Chennai", "Iron Ore", "R8"),
        ]:
            self.assertTrue(model.has_route(origin, destination, route_id=route_id, commodity=commodity))
            result = model.predict(origin, destination, "2026-09-01", commodity=commodity)
            self.assertIsNotNone(result)
            self.assertEqual(result["forecast_type"], "route_specific")
            self.assertEqual(result["data_mode"], "synthetic_mvp")
            self.assertEqual(result["data_confidence"], "low")
            self.assertEqual(result["route"], f"{origin}-{destination}")
            self.assertEqual(result["commodity"], commodity)
            self.assertGreaterEqual(len(result["forecasts"]), 3)
            for point in result["forecasts"]:
                self.assertIn("predicted_rate_usd_per_ton", point)
                self.assertGreater(point["predicted_rate_usd_per_ton"], 0)
                self.assertEqual(point["basis"], "synthetic_route_freight")


    def _write_varied_rows(self, folder: Path, n=60):
        """Training rows where freight rate genuinely depends on cargo size
        and vessel class, so a model that actually uses those features (as
        opposed to ignoring them) can be told apart from one that doesn't."""
        data = folder / "route_freight_observations.csv"
        cols = [
            "observation_id","observation_date","origin","destination","route_id","commodity",
            "vessel_class","cargo_size_t","freight_usd_per_t","rate_type","observation_type",
            "source_name","source_url","source_reference","publication_date","retrieval_date",
            "coverage_start","coverage_end","source_file","verification_status","verification_notes",
            "confidence","schema_version"
        ]
        vessel_classes = ["Supramax", "Capesize"]
        with data.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for i in range(n):
                obs_date = (pd.Timestamp("2020-01-01") + pd.offsets.MonthBegin(i)).date().isoformat()
                vessel_class = vessel_classes[i % 2]
                cargo_size_t = 50000.0 if vessel_class == "Supramax" else 150000.0
                # Larger cargo / Capesize genuinely commands a different
                # rate per tonne in this fixture, plus a mild time trend so
                # the lag/rolling features still carry signal.
                rate = (8.0 if vessel_class == "Supramax" else 14.0) + i * 0.02
                w.writerow({
                    "observation_id": f"v{i}",
                    "observation_date": obs_date,
                    "origin": "Test Origin", "destination": "Test Destination", "route_id": "TEST_ROUTE",
                    "commodity": "thermal_coal", "vessel_class": vessel_class, "cargo_size_t": cargo_size_t,
                    "freight_usd_per_t": rate, "rate_type": "freight_usd_per_t", "observation_type": "assessment",
                    "source_name": "test", "source_url": "https://example.com/report", "source_reference": f"test:{i}",
                    "publication_date": "", "retrieval_date": "2026-09-04", "coverage_start": "", "coverage_end": "",
                    "source_file": "test.csv", "verification_status": "verified", "verification_notes": "synthetic unit-test fixture",
                    "confidence": "high", "schema_version": "1.0",
                })
        return data

    def test_request_cargo_and_vessel_override_change_the_forecast(self):
        """Regression test for the bug where the route model always used
        the last historical observation's cargo_size_t/vessel_class instead
        of what the current request actually specified — so a 50,000t
        Supramax request and a 150,000t Capesize request for the same
        route/date produced an identical forecast."""
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            self._write_varied_rows(d)
            out = d / "models"
            train(out, d)
            model = RouteFreightModel(out, d)

            small_supramax = model.predict(
                "Test Origin", "Test Destination", "2022-01-01",
                cargo_size_t=50000, vessel_class="Supramax",
            )
            large_capesize = model.predict(
                "Test Origin", "Test Destination", "2022-01-01",
                cargo_size_t=150000, vessel_class="Capesize",
            )
            self.assertIsNotNone(small_supramax)
            self.assertIsNotNone(large_capesize)

            # The two requests differ only in cargo size/vessel class, so
            # the forecast must actually move (pre-fix, both silently used
            # the last historical row's cargo_size_t/vessel_class and were
            # therefore identical regardless of what was requested).
            self.assertNotEqual(
                small_supramax["predicted_freight_rate_usd_per_ton"],
                large_capesize["predicted_freight_rate_usd_per_ton"],
            )

            # Provenance is reported correctly...
            self.assertEqual(small_supramax["cargo_size_source"], "request")
            self.assertEqual(small_supramax["vessel_class_source"], "request")
            self.assertEqual(small_supramax["cargo_size_t_used"], 50000)
            self.assertEqual(small_supramax["vessel_class_used"], "Supramax")

            # ...and omitting the overrides still falls back to historical
            # behavior (pre-fix behavior is preserved when the caller
            # genuinely has no request-level value to supply).
            historical = model.predict("Test Origin", "Test Destination", "2022-01-01")
            self.assertEqual(historical["cargo_size_source"], "historical")
            self.assertEqual(historical["vessel_class_source"], "historical")


if __name__ == "__main__":
    unittest.main()