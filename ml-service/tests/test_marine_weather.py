"""Tests for app/marine_weather.py.

The HTTP transport (`_http_get_json`) is monkeypatched in every test — this
environment has no internet access, and even where it does, a unit test
should not depend on a third-party service being up. See the module
docstring's "NOT tested against a live network call" note: these tests
verify the scoring/fallback logic, not that Open-Meteo's real response shape
still matches what we assume.
"""
import unittest
from unittest.mock import patch

from app import marine_weather as mw


def weather_response(wind=None, direction=None, precip=None, visibility_m=None):
    current = {}
    if wind is not None:
        current["wind_speed_10m"] = wind
    if direction is not None:
        current["wind_direction_10m"] = direction
    if precip is not None:
        current["precipitation"] = precip
    if visibility_m is not None:
        current["visibility"] = visibility_m
    return {"current": current}


def marine_response(wave=None, swell=None, period=None):
    current = {}
    if wave is not None:
        current["wave_height"] = wave
    if swell is not None:
        current["swell_wave_height"] = swell
    if period is not None:
        current["wave_period"] = period
    return {"current": current}


class TestFetchConditions(unittest.TestCase):
    def test_success_maps_both_endpoints(self):
        def fake_get(url, params, timeout=6):
            if url == mw.WEATHER_API_URL:
                return weather_response(wind=48.0, direction=180, precip=2.0, visibility_m=8000)
            return marine_response(wave=4.2, swell=3.1, period=9.0)

        with patch.object(mw, "_http_get_json", side_effect=fake_get):
            out = mw.fetch_conditions(-19.8, 34.8)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["wind_speed_kmh"], 48.0)
        self.assertEqual(out["wave_height_m"], 4.2)
        self.assertEqual(out["visibility_km"], 8.0)
        self.assertIsNone(out["error"])

    def test_both_endpoints_down_is_unavailable_not_a_crash(self):
        with patch.object(mw, "_http_get_json", side_effect=TimeoutError("timed out")):
            out = mw.fetch_conditions(-19.8, 34.8)
        self.assertEqual(out["status"], "unavailable")
        self.assertIsNone(out["wind_speed_kmh"])
        self.assertIsNone(out["wave_height_m"])
        self.assertIsNotNone(out["error"])

    def test_one_endpoint_down_is_partial_not_unavailable(self):
        def fake_get(url, params, timeout=6):
            if url == mw.WEATHER_API_URL:
                return weather_response(wind=30.0)
            raise ConnectionError("marine api down")

        with patch.object(mw, "_http_get_json", side_effect=fake_get):
            out = mw.fetch_conditions(-19.8, 34.8)
        self.assertEqual(out["status"], "partial")
        self.assertEqual(out["wind_speed_kmh"], 30.0)
        self.assertIsNone(out["wave_height_m"])


class TestComputeSeverity(unittest.TestCase):
    def test_calm_conditions_low_severity(self):
        r = mw.compute_severity({"wind_speed_kmh": 5, "wave_height_m": 0.2, "precipitation_mm_h": 0, "visibility_km": 10})
        self.assertLess(r["severity"], 0.1)

    def test_storm_conditions_high_severity(self):
        r = mw.compute_severity({"wind_speed_kmh": 100, "wave_height_m": 7.0, "precipitation_mm_h": 20, "visibility_km": 1})
        self.assertGreater(r["severity"], 0.85)

    def test_no_data_returns_none_not_zero(self):
        r = mw.compute_severity({"wind_speed_kmh": None, "wave_height_m": None, "precipitation_mm_h": None, "visibility_km": None})
        self.assertIsNone(r["severity"])
        self.assertEqual(r["coverage"], 0.0)

    def test_partial_data_still_scores_and_reports_coverage(self):
        r = mw.compute_severity({"wind_speed_kmh": 90, "wave_height_m": None, "precipitation_mm_h": None, "visibility_km": None})
        self.assertIsNotNone(r["severity"])
        self.assertAlmostEqual(r["coverage"], 0.25)  # 1 of 4 sub-scores

    def test_severity_monotonic_in_wind(self):
        low = mw.compute_severity({"wind_speed_kmh": 20, "wave_height_m": 1, "precipitation_mm_h": 1, "visibility_km": 10})
        high = mw.compute_severity({"wind_speed_kmh": 80, "wave_height_m": 1, "precipitation_mm_h": 1, "visibility_km": 10})
        self.assertGreater(high["severity"], low["severity"])

    def test_swell_used_when_wave_height_missing(self):
        r = mw.compute_severity({"wind_speed_kmh": None, "wave_height_m": None, "swell_wave_height_m": 5.0,
                                  "precipitation_mm_h": None, "visibility_km": None})
        self.assertIsNotNone(r["severity"])
        self.assertGreater(r["severity"], 0.5)

    def test_severity_never_exceeds_one(self):
        r = mw.compute_severity({"wind_speed_kmh": 500, "wave_height_m": 50, "precipitation_mm_h": 500, "visibility_km": 0})
        self.assertEqual(r["severity"], 1.0)


class TestGetLiveAssessment(unittest.TestCase):
    def test_unavailable_conditions_yield_none_severity(self):
        with patch.object(mw, "fetch_conditions", return_value={"status": "unavailable", "error": "down",
                                                                  "wind_speed_kmh": None, "wave_height_m": None,
                                                                  "swell_wave_height_m": None, "precipitation_mm_h": None,
                                                                  "visibility_km": None}):
            out = mw.get_live_assessment(-19.8, 34.8)
        self.assertIsNone(out["severity"])
        self.assertEqual(out["conditions"]["status"], "unavailable")

    def test_ok_conditions_yield_severity_and_reference_points(self):
        with patch.object(mw, "fetch_conditions", return_value={
            "status": "ok", "error": None, "wind_speed_kmh": 60, "wave_height_m": 3.0,
            "swell_wave_height_m": 2.0, "precipitation_mm_h": 5, "visibility_km": 6,
        }):
            out = mw.get_live_assessment(-19.8, 34.8)
        self.assertIsNotNone(out["severity"])
        self.assertIn("storm_wind_kmh", out["reference_points"])


if __name__ == "__main__":
    unittest.main()
