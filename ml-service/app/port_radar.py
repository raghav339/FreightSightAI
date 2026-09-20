"""Port Disruption Radar: rule-based congestion assessment from AIS history.

This module is pure logic (no database, no clock, no network) so every rule
can be unit-tested with plain dicts. ``AISStreamCollector.port_radar_all`` in
``ais_stream.py`` does the SQL and feeds the results in here.

What it does
------------
For each port it compares the last ``window_hours`` of AIS activity ("Now")
with the SAME clock window on each of the previous days ("Normal"), so the
comparison already accounts for time-of-day patterns. It then reports what
changed and how much, and turns that into a status:

    NORMAL -> WATCH -> ELEVATED -> CRITICAL      (or INSUFFICIENT_DATA)

What it deliberately does NOT do
--------------------------------
* It does not fit or predict a delay in days. There is no ground-truth
  turnaround data to calibrate one against. ``impact.planning_assumption_days``
  is a fixed, labelled planning assumption per status, not a measurement.
* Its ``confidence`` is DATA COVERAGE (how much AIS evidence the numbers rest
  on), not the probability that the assessment is right.
* It says INSUFFICIENT_DATA rather than guessing when the baseline is thin,
  the feed was down, or too few vessels were seen for a percentage to mean
  anything (5 -> 8 vessels is "+60%" and also noise).
"""
from __future__ import annotations

from statistics import median
from typing import Any, Iterable

STATUSES = ("NORMAL", "WATCH", "ELEVATED", "CRITICAL")
INSUFFICIENT = "INSUFFICIENT_DATA"

# ---- vessel classification -------------------------------------------------
STATIONARY_SOG_KN = 0.5      # below this average speed a vessel is "stationary"
STATIONARY_MAX_SOG_KN = 2.0  # ...and never exceeded this (rules out GPS spikes)
BERTH_ZONE_NM = 2.0          # stationary inside this distance = at berth, beyond = waiting
MIN_REPORTS_FOR_STATIONARY = 2

# ---- data sufficiency ------------------------------------------------------
MIN_UNDERWAY_FOR_SPEED = 3   # need this many moving vessels for a meaningful average speed
MIN_BASELINE_WINDOWS = 3     # usable "same window on a previous day" samples required
MIN_VESSELS_FOR_SIGNAL = 3   # vessels seen (now or typically) below this = too sparse to judge
MIN_FEED_MESSAGES = 30       # table-wide AIS messages in a window for the feed to count as alive

# ---- scoring (each signal scores 0-3 points) -------------------------------
WAITING_RATIO_STEPS = (1.5, 2.0, 3.0)   # now / typical waiting vessels (typical floored at 1)
WAITING_MIN_INCREASE = 3                 # ...and at least this many more vessels
DENSITY_RATIO_STEPS = (1.3, 1.6, 2.0)   # now/typical vessels seen
DENSITY_MIN_INCREASE = 3
SPEED_DROP_STEPS = (0.20, 0.35, 0.50)   # fractional drop in average speed of vessels under way
WAITING_WEIGHT = 2                       # waiting vessels are the strongest congestion signal

# score -> status (upper bounds inclusive): 0-1, 2-3, 4-6, 7+
SCORE_BANDS = ((1, "NORMAL"), (3, "WATCH"), (6, "ELEVATED"))

PRESSURE = {"NORMAL": "low", "WATCH": "moderate", "ELEVATED": "high", "CRITICAL": "severe"}
# Fixed planning assumptions (days of port delay to budget for). NOT measured.
PLANNING_DELAY_DAYS = {"NORMAL": 0.0, "WATCH": 0.5, "ELEVATED": 1.0, "CRITICAL": 2.0}
RECOMMENDATION = {
    "NORMAL": "No unusual congestion signals. Proceed with the standard charter window.",
    "WATCH": "Early signs of build-up. Keep the charter window flexible and re-check before fixing.",
    "ELEVATED": "Waiting vessels are well above normal. Consider checking alternate loading origins or a later charter window, and budget extra port time.",
    "CRITICAL": "Severe build-up versus normal. Consider alternate loading origins or a later charter window, and budget significant extra port time.",
}


def classify_vessel(v: dict[str, Any]) -> str:
    """One vessel's activity in a window -> waiting | moored | underway | unknown | ignored.

    ``v`` carries per-vessel aggregates: n (reports), avg_sog, max_sog,
    avg_dist (nm from port centre), anchor_share / moored_share /
    ignore_share (fraction of reports with nav_status at-anchor / moored /
    fishing-or-sailing).

    "Waiting" is the congestion signal: vessels that are stationary but NOT
    at a berth (declared at anchor, or stationary outside the berth zone).
    Moored vessels are working cargo, not queueing, so they are counted
    separately.
    """
    if (v.get("ignore_share") or 0) >= 0.5:
        return "ignored"
    if (v.get("moored_share") or 0) >= 0.5:
        return "moored"
    if (v.get("anchor_share") or 0) >= 0.5:
        return "waiting"
    avg = v.get("avg_sog")
    if avg is None:
        return "unknown"
    stationary = avg < STATIONARY_SOG_KN and (v.get("max_sog") or 0) < STATIONARY_MAX_SOG_KN
    if not stationary:
        return "underway"
    if (v.get("n") or 0) < MIN_REPORTS_FOR_STATIONARY:
        return "unknown"  # one ping cannot show a vessel is stationary
    dist = v.get("avg_dist")
    return "waiting" if dist is not None and dist > BERTH_ZONE_NM else "moored"


def summarize(vessels: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Per-vessel aggregates for one port-window -> counts and average speed."""
    counts = {"waiting": 0, "moored": 0, "underway": 0, "unknown": 0}
    speeds: list[float] = []
    messages = 0
    for v in vessels:
        messages += int(v.get("n") or 0)
        cls = classify_vessel(v)
        if cls == "ignored":
            continue
        counts[cls] += 1
        if cls == "underway" and v.get("avg_sog") is not None:
            speeds.append(float(v["avg_sog"]))
    return {
        "seen": sum(counts.values()),
        **counts,
        "avg_speed_kn": round(sum(speeds) / len(speeds), 2) if len(speeds) >= MIN_UNDERWAY_FOR_SPEED else None,
        "messages": messages,
    }


def _median(values: Iterable[float | None]) -> float | None:
    vals = [float(v) for v in values if v is not None]
    return round(float(median(vals)), 1) if vals else None


def _pct(now: float | None, base: float | None) -> float | None:
    if now is None or base is None or base == 0:
        return None
    return round((now - base) / base * 100.0, 1)


def _ratio_points(now: float, base: float, steps: tuple[float, ...], min_increase: float) -> int:
    if now - base < min_increase:
        return 0
    ratio = now / max(base, 1.0)  # floor keeps a zero baseline from dividing by zero
    return sum(1 for s in steps if ratio >= s)


def _speed_points(now: float | None, base: float | None) -> int:
    if now is None or base is None or base <= 0:
        return 0
    drop = 1.0 - now / base
    return sum(1 for s in SPEED_DROP_STEPS if drop >= s)


def _status_for(score: int) -> str:
    for upper, status in SCORE_BANDS:
        if score <= upper:
            return status
    return "CRITICAL"


def _confidence(now: dict, baseline_seen: float | None, windows_used: int, baseline_days: int) -> dict[str, Any]:
    coverage = min(1.0, windows_used / max(1, baseline_days))
    volume = min(1.0, now["messages"] / 200.0)
    sample = min(1.0, (baseline_seen or 0.0) / 8.0)
    score = round(100 * (0.4 * coverage + 0.3 * volume + 0.3 * sample))
    label = "High" if score >= 75 else "Medium" if score >= 50 else "Low"
    return {
        "score": score,
        "label": label,
        "basis": "data coverage: baseline days with usable AIS, message volume now, and vessels typically observed. "
                 "It measures how much evidence the numbers rest on, not the chance the assessment is right.",
    }


def assess(
    port: str,
    now: dict[str, Any],
    baselines: list[dict[str, Any]],
    *,
    feed_ok: bool,
    window_hours: float,
    baseline_days: int,
) -> dict[str, Any]:
    """Compare a port's current window with its usable baseline windows.

    ``baselines`` must already exclude windows where the AIS feed was not
    running (the caller cannot tell "no ships" from "no data" per port, so it
    uses table-wide message volume to decide which windows are usable).
    """
    base = {
        "seen": _median(b["seen"] for b in baselines),
        "waiting": _median(b["waiting"] for b in baselines),
        "moored": _median(b["moored"] for b in baselines),
        "underway": _median(b["underway"] for b in baselines),
        "avg_speed_kn": _median(b["avg_speed_kn"] for b in baselines),
        "windows_used": len(baselines),
        "windows_requested": baseline_days,
    }
    changes = {
        "seen_pct": _pct(now["seen"], base["seen"]),
        "waiting_pct": _pct(now["waiting"], base["waiting"]),
        "speed_pct": _pct(now["avg_speed_kn"], base["avg_speed_kn"]),
    }

    reason = None
    if not feed_ok:
        reason = "The AIS feed shows no recent activity, so current conditions cannot be assessed."
    elif len(baselines) < MIN_BASELINE_WINDOWS:
        reason = (
            f"Only {len(baselines)} of the last {baseline_days} days have usable AIS coverage for this window "
            f"(at least {MIN_BASELINE_WINDOWS} needed to define what is normal)."
        )
    elif max(now["seen"], base["seen"] or 0) < MIN_VESSELS_FOR_SIGNAL:
        reason = (
            f"Too few vessels observed near {port} (now {now['seen']}, typically {base['seen']:g}) "
            "for a change to be meaningful."
        )

    pts_wait = pts_dens = pts_speed = 0
    score: int | None = None
    status = INSUFFICIENT
    if reason is None:
        pts_wait = _ratio_points(now["waiting"], base["waiting"] or 0.0, WAITING_RATIO_STEPS, WAITING_MIN_INCREASE)
        pts_dens = _ratio_points(now["seen"], base["seen"] or 0.0, DENSITY_RATIO_STEPS, DENSITY_MIN_INCREASE)
        pts_speed = _speed_points(now["avg_speed_kn"], base["avg_speed_kn"])
        score = WAITING_WEIGHT * pts_wait + pts_dens + pts_speed
        status = _status_for(score)

    evidence = [
        {
            "key": "waiting",
            "label": "Vessels waiting (at anchor or stationary outside the berth area)",
            "now": now["waiting"], "baseline": base["waiting"], "change_pct": changes["waiting_pct"],
            "flagged": pts_wait > 0, "unit": "vessels",
        },
        {
            "key": "seen",
            "label": "Vessels near the port",
            "now": now["seen"], "baseline": base["seen"], "change_pct": changes["seen_pct"],
            "flagged": pts_dens > 0, "unit": "vessels",
        },
        {
            "key": "speed",
            "label": "Average speed of vessels under way",
            "now": now["avg_speed_kn"], "baseline": base["avg_speed_kn"], "change_pct": changes["speed_pct"],
            "flagged": pts_speed > 0, "unit": "kn",
        },
        {
            "key": "moored",
            "label": "Vessels at berth (working cargo)",
            "now": now["moored"], "baseline": base["moored"], "change_pct": _pct(now["moored"], base["moored"]),
            "flagged": False, "unit": "vessels",
        },
    ]

    impact = None
    if status in PRESSURE:
        impact = {
            "turnaround_pressure": PRESSURE[status],
            "planning_assumption_days": PLANNING_DELAY_DAYS[status],
            "assumption_note": (
                "A fixed planning assumption for this status, not a measured or predicted delay. "
                "Use it as a starting value when running a what-if."
            ),
            "recommendation": RECOMMENDATION[status],
        }

    return {
        "port": port,
        "status": status,
        "status_index": STATUSES.index(status) if status in STATUSES else None,
        "score": score,
        "insufficient_reason": reason,
        "window_hours": window_hours,
        "now": now,
        "baseline": base,
        "changes": changes,
        "evidence": evidence,
        "signal_points": {"waiting": pts_wait, "density": pts_dens, "speed": pts_speed},
        "confidence": _confidence(now, base["seen"], len(baselines), baseline_days),
        "impact": impact,
    }


def severity_key(radar: dict[str, Any]) -> tuple[int, str]:
    """Sort key: most severe first, then insufficient-data ports last, then name."""
    idx = radar.get("status_index")
    return (-(idx if idx is not None else -1), radar["port"])
