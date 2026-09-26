"""Tests for ModelBundle.live_disruption (app/utils.py) — Step 4's Live mode.

Every test mocks app.marine_weather.get_live_assessment so nothing here
depends on network access (this sandbox has none) or on WeatherAPI being up.
Run against the project's real port master and lane models, in the style of
test_disruption_wiring.py.
"""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app import marine_weather as mw
from tests._shared_models import get_bundle


def make(**kw):
    base = dict(port=None, duration_days=None, origin_port=None, destination_port=None,
                commodity=None, shipment_date=None, cargo_weight_tons=50000.0,
                stockpile_buffer_days=None, include_alternatives=True)
    base.update(kw)
    return SimpleNamespace(**base)


def fake_reading(severity, coverage=1.0):
    return {
        "conditions": {"status": "ok", "error": None, "wind_speed_kmh": 40, "wave_height_m": 2.0,
                       "swell_wave_height_m": 1.5, "precipitation_mm_h": 3, "visibility_km": 8},
        "severity": severity, "sub_scores": {}, "coverage": coverage, "reference_points": {},
    }


UNAVAILABLE = {"conditions": {"status": "unavailable", "error": "connection timed out"},
               "severity": None, "sub_scores": {}, "coverage": 0.0, "reference_points": {}}


class TestLiveDisruption(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = get_bundle()

    def test_uses_extreme_weather_profile_and_labels_source_live(self):
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.6)):
            r = self.bundle._live_disruption_impl(make(port="Paradip"))
        self.assertEqual(r["disruption"]["source"], "live")
        self.assertEqual(r["disruption"]["event_type"], "extreme_weather")
        self.assertEqual(r["disruption"]["severity"], 0.6)

    def test_severity_comes_from_weather_not_caller(self):
        # live_disruption (and its impl) never accepts a severity argument -- confirm
        # the request object has no such field and the result still varies
        # with whatever the (mocked) weather reading says.
        self.assertNotIn("severity", vars(make(port="Paradip")))
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.2)):
            low = self.bundle._live_disruption_impl(make(port="Paradip"))
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.9)):
            high = self.bundle._live_disruption_impl(make(port="Paradip"))
        self.assertLess(low["disruption"]["loading_delay_days"], high["disruption"]["loading_delay_days"])

    def test_unavailable_weather_raises_not_fabricates(self):
        with patch.object(mw, "get_live_assessment", return_value=UNAVAILABLE):
            with self.assertRaises(ValueError) as ctx:
                self.bundle._live_disruption_impl(make(port="Paradip"))
        self.assertIn("unavailable", str(ctx.exception).lower())

    def test_port_without_coordinates_raises_before_calling_weather_api(self):
        calls = []
        with patch.object(mw, "get_live_assessment", side_effect=lambda *a: calls.append(a) or fake_reading(0.5)):
            with self.assertRaises(ValueError):
                self.bundle._live_disruption_impl(make(port="Nowhereville"))
        self.assertEqual(calls, [])  # never even tried to fetch weather for an unknown port

    def test_destination_port_gets_alternatives_like_simulate_mode(self):
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.7)):
            r = self.bundle._live_disruption_impl(make(port="Paradip"))
        self.assertEqual(r["port_role"], "destination")
        self.assertIsNotNone(r["decision"])
        self.assertIsNotNone(r["alternatives"])

    def test_origin_port_gets_no_bogus_alternatives(self):
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.7)):
            r = self.bundle._live_disruption_impl(make(port="Newcastle"))
        self.assertEqual(r["port_role"], "origin")
        self.assertIsNone(r["alternatives"])
        self.assertIsNone(r["decision"])

    def test_response_includes_raw_live_conditions_for_transparency(self):
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.5, coverage=0.75)):
            r = self.bundle._live_disruption_impl(make(port="Paradip"))
        self.assertEqual(r["live_conditions"]["coverage"], 0.75)
        self.assertIn("wind_speed_kmh", r["live_conditions"]["conditions"])

    def test_lane_pricing_works_same_as_simulate_mode(self):
        from datetime import date
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.6)):
            r = self.bundle._live_disruption_impl(make(
                port="Paradip", origin_port="Newcastle", commodity="Coal",
                shipment_date=date(2026, 10, 1)))
        self.assertIsNotNone(r["lane"])
        self.assertEqual(r["lane"]["destination_port"], "Paradip")

    def test_unknown_port_raises(self):
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.5)):
            with self.assertRaises(ValueError):
                self.bundle._live_disruption_impl(make(port="Atlantis"))

    def test_public_entry_point_delegates_to_impl(self):
        # The cached public method (live_disruption) should return the same
        # shape as the impl for a fresh cache key. A distinct port name here
        # avoids colliding with the 5-minute cache bucket used by other
        # tests in this file/run that also hit "Paradip".
        with patch.object(mw, "get_live_assessment", return_value=fake_reading(0.55)):
            r = self.bundle.live_disruption(make(port="Gangavaram"))
        self.assertEqual(r["disruption"]["source"], "live")
        self.assertEqual(r["disruption"]["severity"], 0.55)


if __name__ == "__main__":
    unittest.main()
