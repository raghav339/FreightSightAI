"""Live marine conditions for the Disruption Engine's "Live" mode.

This is the ONLY thing this module does: fetch current wind/wave/precipitation
for a port's coordinates and turn them into a severity score (0..1) on the
same scale the Disruption Engine already uses for simulated events. It does
NOT decide delay or freight numbers itself — those come from
``disruption_engine.compute_impact``, exactly like the Simulate path. A live
reading is just a different way of arriving at a severity value; see
``app/disruption_engine.py``'s module docstring for why that separation
matters.

Data source
-----------
WeatherAPI.com's Marine API (https://www.weatherapi.com). One call returns
wind, precipitation, visibility AND wave/swell height together for a
lat/lon, which is why it was chosen: the previous source (Open-Meteo) needed
two separate endpoint calls for the same data, and this app runs on Render,
where the outbound IP is shared with other tenants — a free-tier rate limit
on a shared IP is something this app has no control over and can't "fix" by
calling less. A single-endpoint, API-keyed source sidesteps that: the quota
is per-key, not per-shared-IP.

Requires an API key in the ``WEATHERAPI_KEY`` environment variable (free
tier: https://www.weatherapi.com/pricing.aspx, no card required). Without
it, live conditions are unavailable — see the module docstring's "Honesty
requirements" below for why this fails loudly rather than silently.

Only the standard library (``urllib``, ``os``) is used for the HTTP call, so
this adds no new Python dependency.

Honesty requirements this module follows
-----------------------------------------
* If the network call fails, times out, the key is missing/invalid, or a
  port has no coordinates on file, this returns a result with
  ``status="unavailable"`` and NO severity number — it never invents a
  value or silently defaults to "calm". The caller (``ModelBundle`` in
  ``app/utils.py``) must refuse to run a "live" disruption assessment when
  it gets an unavailable reading rather than quietly substituting
  severity 0.
* The severity thresholds below (what counts as a "severe" wave, wind speed,
  or rainfall) are drawn from named, public meteorological/sea-state
  conventions (documented on each constant) — they are reference points for
  scaling a continuous score, not a fitted model, and that is stated
  wherever the score is surfaced.
* This has NOT been tested against a live network call in this sandboxed
  build environment (no internet access here). The HTTP plumbing is
  isolated in ``_http_get_json`` and unit-tested with a mocked transport;
  before relying on it for a demo, do one real end-to-end call against a
  real port and confirm the field names WeatherAPI returns still match
  ``_HOUR_FIELDS`` below (external APIs occasionally rename or restructure
  fields).
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

WEATHERAPI_URL = "https://api.weatherapi.com/v1/marine.json"
WEATHERAPI_KEY_ENV = "WEATHERAPI_KEY"
REQUEST_TIMEOUT_S = 6
# A couple of short, polite retries on a 429 — WeatherAPI's free tier is
# generous (1M calls/month) but still rate-limited per-key/per-second, so an
# isolated burst is worth a brief retry rather than surfacing "unavailable"
# immediately.
RATE_LIMIT_RETRIES = 2
RATE_LIMIT_BACKOFF_S = 1.5

# Field names WeatherAPI's `forecast.forecastday[0].hour[N]` objects are
# expected to use. Documented here (rather than buried in the function
# below) so a future field-name change on their end is a one-line fix.
_HOUR_FIELDS = {
    "wind_speed_kmh": "wind_kph",
    "wind_direction_deg": "wind_degree",
    "precipitation_mm_h": "precip_mm",
    "visibility_km": "vis_km",
    "wave_height_m": "sig_ht_mt",
    "swell_wave_height_m": "swell_ht_mt",
    "wave_period_s": "swell_period_secs",
}

# ---- labelled reference points (see module docstring) ----------------------
# Wind: ~62 km/h is the low end of Beaufort 8 ("gale"); ~89 km/h is the low
# end of Beaufort 10 ("storm"). We treat "storm-force" as the scale's top.
REFERENCE_STORM_WIND_KMH = 89.0
# Wave height: WMO sea-state code 6 ("very rough", 4-6 m) upper bound.
REFERENCE_VERY_ROUGH_WAVE_M = 6.0
# Precipitation: >7.6 mm/h is "heavy rain" by common meteorological
# convention; we set the scale's top a little beyond that, at "violent".
REFERENCE_VIOLENT_RAIN_MMH = 15.0
# Visibility: 10 km+ is considered good/unrestricted for coastal shipping.
REFERENCE_GOOD_VISIBILITY_KM = 10.0

SEVERITY_WEIGHTS = {"wave": 0.40, "wind": 0.35, "precipitation": 0.15, "visibility": 0.10}


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _weatherapi_key() -> str:
    return os.environ.get(WEATHERAPI_KEY_ENV, "").strip()


def _http_get_json(url: str, params: dict[str, Any], timeout: float = REQUEST_TIMEOUT_S) -> dict[str, Any]:
    """Thin, mockable HTTP GET-JSON wrapper (stdlib only).

    Retries a 429 (Too Many Requests) a couple of times with a short delay
    before giving up — see RATE_LIMIT_RETRIES above. Any other error
    (network failure, timeout, 4xx/5xx other than 429) is raised
    immediately with no retry.
    """
    query = urllib.parse.urlencode(params)
    full_url = f"{url}?{query}"
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(full_url, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < RATE_LIMIT_RETRIES:
                attempt += 1
                time.sleep(RATE_LIMIT_BACKOFF_S * attempt)
                continue
            raise


def fetch_conditions(lat: float, lon: float) -> dict[str, Any]:
    """Fetch current wind/precipitation/visibility + wave/swell for one point.

    Returns a dict always shaped the same way; on any failure (missing key,
    network error, timeout, unexpected response shape) the numeric fields
    are ``None`` and ``status`` is ``"unavailable"`` with an ``error``
    message — never a fabricated reading.
    """
    out: dict[str, Any] = {
        "wind_speed_kmh": None, "wind_direction_deg": None, "precipitation_mm_h": None,
        "visibility_km": None, "wave_height_m": None, "swell_wave_height_m": None, "wave_period_s": None,
        "status": "ok", "error": None, "source": "weatherapi",
    }

    key = _weatherapi_key()
    if not key:
        out["status"] = "unavailable"
        out["error"] = f"{WEATHERAPI_KEY_ENV} not configured"
        return out

    try:
        data = _http_get_json(WEATHERAPI_URL, {"key": key, "q": f"{lat},{lon}", "days": 1})
        forecast_days = data.get("forecast", {}).get("forecastday") or []
        if not forecast_days:
            raise RuntimeError("no forecast data in response")
        hours = forecast_days[0].get("hour") or []
        if not hours:
            raise RuntimeError("no hourly data in response")
        # WeatherAPI returns 24 local hourly buckets for the day rather than
        # a single "current" reading; pick the one matching the current UTC
        # hour (falling back to the first bucket if the match fails).
        now_hour = time.gmtime().tm_hour
        hour_data = next((h for h in hours if str(h.get("time", "")).endswith(f"{now_hour:02d}:00")), hours[0])
        for out_key, src_key in _HOUR_FIELDS.items():
            out[out_key] = hour_data.get(src_key)
    except Exception as exc:  # network error, timeout, bad response shape, invalid key, etc.
        out["status"] = "unavailable"
        out["error"] = f"weatherapi fetch failed: {exc}"
        return out

    have_any = any(out[k] is not None for k in (
        "wind_speed_kmh", "precipitation_mm_h", "wave_height_m", "swell_wave_height_m"))
    if not have_any:
        out["status"] = "unavailable"
        out["error"] = "weatherapi returned no usable readings"
    return out


def compute_severity(conditions: dict[str, Any]) -> dict[str, Any]:
    """Turn a `fetch_conditions` reading into a 0..1 severity score.

    Each available sub-score is scaled continuously against its reference
    point (see module docstring) and clamped to 1.0, then combined with
    fixed weights, RENORMALISED over whichever sub-scores actually had data
    (mirrors ``disruption_engine.port_exposure_factors``' neutral-fallback
    approach). Returns ``severity=None`` if nothing was available at all —
    callers must treat that as "cannot assess", not as severity 0.
    """
    sub: dict[str, float | None] = {}

    wave = conditions.get("wave_height_m")
    swell = conditions.get("swell_wave_height_m")
    wave_like = max((v for v in (wave, swell) if v is not None), default=None)
    sub["wave"] = clamp(wave_like / REFERENCE_VERY_ROUGH_WAVE_M, 0.0, 1.0) if wave_like is not None else None

    wind = conditions.get("wind_speed_kmh")
    sub["wind"] = clamp(wind / REFERENCE_STORM_WIND_KMH, 0.0, 1.0) if wind is not None else None

    precip = conditions.get("precipitation_mm_h")
    sub["precipitation"] = clamp(precip / REFERENCE_VIOLENT_RAIN_MMH, 0.0, 1.0) if precip is not None else None

    vis = conditions.get("visibility_km")
    sub["visibility"] = clamp(1.0 - vis / REFERENCE_GOOD_VISIBILITY_KM, 0.0, 1.0) if vis is not None else None

    known = {k: v for k, v in sub.items() if v is not None}
    if not known:
        return {"severity": None, "sub_scores": sub, "coverage": 0.0}

    weight_sum = sum(SEVERITY_WEIGHTS[k] for k in known)
    severity = sum(SEVERITY_WEIGHTS[k] * v for k, v in known.items()) / weight_sum
    return {
        "severity": round(clamp(severity, 0.0, 1.0), 3),
        "sub_scores": {k: (round(v, 3) if v is not None else None) for k, v in sub.items()},
        "coverage": round(len(known) / len(SEVERITY_WEIGHTS), 2),
    }


def get_live_assessment(lat: float, lon: float) -> dict[str, Any]:
    """Fetch + score in one call. ``severity`` is None when unavailable."""
    conditions = fetch_conditions(lat, lon)
    scored = compute_severity(conditions) if conditions["status"] != "unavailable" else {
        "severity": None, "sub_scores": {}, "coverage": 0.0,
    }
    return {
        "conditions": conditions,
        "severity": scored["severity"],
        "sub_scores": scored["sub_scores"],
        "coverage": scored["coverage"],
        "reference_points": {
            "storm_wind_kmh": REFERENCE_STORM_WIND_KMH,
            "very_rough_wave_m": REFERENCE_VERY_ROUGH_WAVE_M,
            "violent_rain_mmh": REFERENCE_VIOLENT_RAIN_MMH,
            "good_visibility_km": REFERENCE_GOOD_VISIBILITY_KM,
        },
    }
