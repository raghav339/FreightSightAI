"""Tests for app/marine_weather.py.

The HTTP transport (`_http_get_json`) is monkeypatched in every test — this
environment has no internet access, and even where it does, a unit test
should not depend on a third-party service being up. See the module
docstring's "NOT tested against a live network call" note: these tests
verify the scoring/fallback logic, not that WeatherAPI's real response shape
still matches what we assume.
"""
import os
import unittest
from unittest.mock import patch

from app import marine_weather as mw


def weatherapi_response(wind_kph=None, direction=None, precip_mm=None, vis_km=None,
                         sig_ht_mt=None, swell_ht_mt=None, swell_period_secs=None):
    hour = {"time": "2026-01-01 00:00"}
    if wind_kph is not None:
        hour["wind_kph"] = wind_kph
    if direction is not None:
        hour["wind_degree"] = direction
    if precip_mm is not None:
        hour["precip_mm"] = precip_mm
    if vis_km is not None:
        hour["vis_km"] = vis_km
    if sig_ht_mt is not None:
        hour["sig_ht_mt"] = sig_ht_mt
    if swell_ht_mt is not None:
        hour["swell_ht_mt"] = swell_ht_mt
    if swell_period_secs is not None:
        hour["swell_period_secs"] = swell_period_secs
    return {"forecast": {"forecastday": [{"hour": [hour]}]}}


class TestFetchConditions(unittest.TestCase):
    def setUp(self):
        self._old_key = os.environ.pop(mw.WEATHERAPI_KEY_ENV, None)
        os.environ[mw.WEATHERAPI_KEY_ENV] = "test-key"

    def tearDown(self):
        if self._old_key is not None:
            os.environ[mw.WEATHERAPI_KEY_ENV] = self._old_key
        else:
            os.environ.pop(mw.WEATHERAPI_KEY_ENV, None)

    def test_success_maps_fields(self):
        with patch.object(mw, "_http_get_json", return_value=weatherapi_response(
                wind_kph=48.0, direction=180, precip_mm=2.0, vis_km=8.0,
                sig_ht_mt=4.2, swell_ht_mt=3.1, swell_period_secs=9.0)):
            out = mw.fetch_conditions(-19.8, 34.8)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["source"], "weatherapi")
        self.assertEqual(out["wind_speed_kmh"], 48.0)
        self.assertEqual(out["wind_direction_deg"], 180)
        self.assertEqual(out["precipitation_mm_h"], 2.0)
        self.assertEqual(out["visibility_km"], 8.0)
        self.assertEqual(out["wave_height_m"], 4.2)
        self.assertEqual(out["swell_wave_height_m"], 3.1)
        self.assertEqual(out["wave_period_s"], 9.0)
        self.assertIsNone(out["error"])

    def test_no_key_configured_is_unavailable_not_a_crash(self):
        os.environ.pop(mw.WEATHERAPI_KEY_ENV, None)
        out = mw.fetch_conditions(-19.8, 34.8)
        self.assertEqual(out["status"], "unavailable")
        self.assertIsNone(out["wind_speed_kmh"])
        self.assertIn("WEATHERAPI_KEY", out["error"])

    def test_network_failure_is_unavailable_not_a_crash(self):
        with patch.object(mw, "_http_get_json", side_effect=TimeoutError("timed out")):
            out = mw.fetch_conditions(-19.8, 34.8)
        self.assertEqual(out["status"], "unavailable")
        self.assertIsNone(out["wind_speed_kmh"])
        self.assertIsNone(out["wave_height_m"])
        self.assertIsNotNone(out["error"])

    def test_rate_limit_retries_then_succeeds(self):
        calls = {"n": 0}

        def fake_urlopen(url, timeout=6):
            calls["n"] += 1
            if calls["n"] < 2:
                raise mw.urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
            import io
            import json as _json
            body = _json.dumps(weatherapi_response(wind_kph=20.0)).encode("utf-8")
            return io.BytesIO(body)

        # Patch urlopen (not _http_get_json) so the real retry loop runs.
        with patch.object(mw.time, "sleep", return_value=None), \
             patch.object(mw.urllib.request, "urlopen", side_effect=fake_urlopen):
            out = mw.fetch_conditions(-19.8, 34.8)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["wind_speed_kmh"], 20.0)
        self.assertGreaterEqual(calls["n"], 2)

    def test_empty_forecast_is_unavailable(self):
        with patch.object(mw, "_http_get_json", return_value={"forecast": {"forecastday": []}}):
            out = mw.fetch_conditions(-19.8, 34.8)
        self.assertEqual(out["status"], "unavailable")
        self.assertIsNotNone(out["error"])


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
