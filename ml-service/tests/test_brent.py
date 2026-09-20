import os
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import brent  # noqa: E402


def _series(end: date, days: int, start_price: float = 80.0, end_price: float = 100.0):
    out = []
    for i in range(days + 1):
        d = end - timedelta(days=days - i)
        out.append((d, start_price + (end_price - start_price) * i / days))
    return out


class BrentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "brent.csv"
        self.env = mock.patch.dict(os.environ, {"BRENT_ENABLED": "true"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_parse_fred_csv_skips_missing_values(self):
        text = "observation_date,DCOILBRENTEU\n2026-01-01,80.5\n2026-01-02,.\n2026-01-03,81.0\nbad,1\n"
        self.assertEqual(brent.parse_series(text), [(date(2026, 1, 1), 80.5), (date(2026, 1, 3), 81.0)])

    def test_parse_legacy_layout(self):
        text = "date,brent_price_daily,brent_price_monthly_avg\n2026-01-01,80.5,79\n"
        self.assertEqual(brent.parse_series(text), [(date(2026, 1, 1), 80.5)])

    def test_cache_roundtrip(self):
        s = _series(date(2026, 9, 1), 40)
        brent.write_cache(s, self.path)
        back = brent.load_series(self.path)
        self.assertEqual(len(back), len(s))
        self.assertAlmostEqual(back[-1][1], 100.0, places=2)

    def test_signal_available_and_correct(self):
        end = date(2026, 9, 10)
        brent.write_cache(_series(end, 60, 80.0, 100.0), self.path)
        sig = brent.fuel_shock(today=end + timedelta(days=2), path=self.path)
        self.assertTrue(sig["available"])
        self.assertEqual(sig["as_of"], end.isoformat())
        self.assertEqual(sig["age_days"], 2)
        # price 30 days earlier was 90, latest 100
        self.assertAlmostEqual(sig["pct_change_30d"], (100 - 90) / 90, places=2)

    def test_stale_data_drops_out(self):
        end = date(2026, 6, 1)
        brent.write_cache(_series(end, 60), self.path)
        sig = brent.fuel_shock(today=end + timedelta(days=brent.MAX_AGE_DAYS + 1), path=self.path)
        self.assertFalse(sig["available"])
        self.assertEqual(sig["reason"], "stale")

    def test_missing_cache_and_short_history(self):
        self.assertEqual(brent.fuel_shock(path=self.path)["reason"], "no_data")
        brent.write_cache(_series(date(2026, 9, 1), 10), self.path)
        sig = brent.fuel_shock(today=date(2026, 9, 2), path=self.path)
        self.assertEqual(sig["reason"], "insufficient_history")

    def test_disabled(self):
        with mock.patch.dict(os.environ, {"BRENT_ENABLED": "false"}):
            self.assertEqual(brent.fuel_shock(path=self.path)["reason"], "disabled")

    def test_bad_download_never_overwrites_good_cache(self):
        good = _series(date(2026, 9, 1), 60)
        brent.write_cache(good, self.path)
        fake = mock.MagicMock()
        fake.__enter__.return_value.read.return_value = b"observation_date,X\n2026-01-01,80\n"
        with mock.patch.object(brent, "urlopen", return_value=fake):
            with self.assertRaises(ValueError):
                brent.fetch_and_cache(url="http://example.invalid", path=self.path)
        self.assertEqual(len(brent.load_series(self.path)), len(good))

    def test_refresh_failure_is_swallowed(self):
        with mock.patch.object(brent, "fetch_and_cache", side_effect=OSError("offline")):
            self.assertFalse(brent.refresh_once())
        self.assertIn("offline", brent.status()["last_error"])


class RiskIntegrationTests(unittest.TestCase):
    """_derive_risk uses the Brent factor only when fresh data exists."""

    def _risk(self, signal):
        from app import utils
        stub = SimpleNamespace(_port_congestion_score=lambda o, d: 0.3)
        curve = [
            {"predicted_rate": 50.0, "lower_bound": 46.0, "upper_bound": 54.0},
            {"predicted_rate": 51.0}, {"predicted_rate": 52.0},
        ]
        route = {"data_confidence": "medium", "data_mode": "verified_production"}
        with mock.patch.object(utils.brent, "fuel_shock", return_value=signal):
            return utils.ModelBundle._derive_risk(stub, route, curve, 0.04, {}, {})

    def test_unavailable_matches_original_weights(self):
        from app import utils
        _, _, f = self._risk({"available": False, "reason": "stale"})
        self.assertIsNone(f["fuel_shock"])
        self.assertEqual(f["brent"]["reason"], "stale")
        expected = (0.35 * f["volatility"] + 0.20 * f["rate_shock"] + 0.15 * f["trend_deviation"]
                    + 0.20 * f["port_congestion"] + 0.10 * f["data_uncertainty"])
        self.assertAlmostEqual(f["score"], expected, places=2)
        self.assertAlmostEqual(sum(utils.RISK_WEIGHTS.values()), 1.0)

    def test_available_adds_factor_and_raises_score_on_big_move(self):
        from app import utils
        self.assertAlmostEqual(sum(utils.RISK_WEIGHTS_WITH_FUEL.values()), 1.0)
        _, _, base = self._risk({"available": False, "reason": "no_data"})
        _, _, hot = self._risk({"available": True, "pct_change_30d": 0.30, "latest_usd_per_bbl": 110.0, "as_of": "2026-09-09"})
        _, _, calm = self._risk({"available": True, "pct_change_30d": 0.0, "latest_usd_per_bbl": 90.0, "as_of": "2026-09-09"})
        self.assertEqual(hot["fuel_shock"], 1.0)  # capped
        self.assertEqual(calm["fuel_shock"], 0.0)
        self.assertGreater(hot["score"], calm["score"])
        self.assertEqual(hot["brent"]["as_of"], "2026-09-09")


if __name__ == "__main__":
    unittest.main()
