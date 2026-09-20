import os
import tempfile
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.idle_detector import Observation, detect_idle_vessel


class TestIdleDetector(unittest.TestCase):
    def make_history(self, hours=7, sog=0.1, lat=20.266, lon=86.683, nav_status=1):
        start = datetime(2026, 9, 5, 0, 0, tzinfo=timezone.utc)
        return [
            Observation(
                timestamp=start + timedelta(hours=i),
                lat=lat + (0.00005 * (i % 2)),
                lon=lon + (0.00005 * (i % 2)),
                sog=sog,
                cog=180.0,
                heading=180.0,
                nav_status=nav_status,
                port_near="Paradip",
                distance_to_port_nm=2.0,
            )
            for i in range(hours + 1)
        ]

    def test_sustained_stationary_near_port_is_idle(self):
        result = detect_idle_vessel(
            self.make_history(),
            vessel={"mmsi": "123", "ship_name": "MV Test", "ship_type": 70},
        )
        self.assertTrue(result["idle"])
        self.assertGreaterEqual(result["idle_score"], 80)
        self.assertEqual(result["idle_confidence"], "HIGH")
        self.assertAlmostEqual(result["idle_duration_hours"], 7.0, places=1)
        self.assertTrue(result["bulk_candidate"])

    def test_short_stop_is_not_idle(self):
        result = detect_idle_vessel(
            self.make_history(hours=2),
            vessel={"mmsi": "123", "ship_name": "MV Test", "ship_type": 70},
        )
        self.assertFalse(result["idle"])

    def test_fast_vessel_is_not_idle(self):
        result = detect_idle_vessel(
            self.make_history(hours=7, sog=8.5),
            vessel={"mmsi": "123", "ship_name": "MV Test", "ship_type": 70},
        )
        self.assertFalse(result["idle"])
        self.assertFalse(result["stationary"])

    def test_position_drift_reduces_stationary_evidence(self):
        history = self.make_history()
        history[-1] = Observation(
            timestamp=history[-1].timestamp,
            lat=20.5,
            lon=86.9,
            sog=0.1,
            cog=180.0,
            heading=180.0,
            nav_status=1,
            port_near="Paradip",
            distance_to_port_nm=2.0,
        )
        result = detect_idle_vessel(
            history,
            vessel={"mmsi": "123", "ship_name": "MV Test", "ship_type": 70},
        )
        self.assertFalse(result["position_stable"])
        self.assertLess(result["idle_score"], 80)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestAISCollectorIdleIntegration(unittest.TestCase):
    def test_sqlite_history_is_converted_to_idle_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "ais.sqlite3")
            old_db = os.environ.get("AISSTREAM_DB")
            os.environ["AISSTREAM_DB"] = db_path
            try:
                # Reload module so collector points at the isolated test DB.
                import importlib
                import app.ais_stream as ais_stream
                ais_stream = importlib.reload(ais_stream)
                collector = ais_stream.AISStreamCollector()
                # Anchor to "now" rather than a fixed calendar date: the
                # lookback window below is computed against the real wall
                # clock (datetime.now()), so a hardcoded past date would
                # silently drift out of the 24h window as real time passes.
                start = datetime.now(timezone.utc) - timedelta(hours=8)
                with collector._connect_db() as conn:
                    for i in range(8):
                        conn.execute(
                            """INSERT INTO ais_positions
                            (received_at, ais_timestamp, mmsi, ship_name, lat, lon, sog, cog, heading, nav_status, port_near, port_distance_nm, ship_type)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            ((start + timedelta(hours=i)).isoformat(), int((start + timedelta(hours=i)).timestamp()),
                             "999000001", "MV Test", 20.266 + (i % 2)*0.00005, 86.683 + (i % 2)*0.00005,
                             0.1, 180.0, 180.0, 1, "Paradip", 2.0, 70),
                        )
                result = collector.idle_vessels(lookback_hours=24, min_idle_hours=4, limit=10)
                self.assertEqual(result["count"], 1)
                self.assertTrue(result["vessels"][0]["idle"])
                self.assertEqual(result["vessels"][0]["mmsi"], "999000001")
            finally:
                if old_db is None:
                    os.environ.pop("AISSTREAM_DB", None)
                else:
                    os.environ["AISSTREAM_DB"] = old_db


