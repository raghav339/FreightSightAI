"""AIS-based idle vessel detection for FreightSight.

The detector deliberately treats AIS as an *observed movement signal*, not
proof of charter availability. A vessel is classified as idle only when
multiple signals agree: low SOG, stable position, sustained duration, and
port/anchorage proximity. AIS navigational status is supporting evidence
because it is operator-entered and may be stale.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from math import asin, cos, radians, sin, sqrt
from typing import Any, Iterable


IDLE_SOG_KN = 0.5
POSITION_STABILITY_NM = 0.30
MIN_IDLE_HOURS = 4.0
HIGH_IDLE_HOURS = 6.0
PORT_RADIUS_NM = 20.0

# AIS navigational status values (ITU/IMO standard):
# 0 = underway using engine, 1 = at anchor, 2 = not under command,
# 3 = restricted manoeuvrability, 4 = constrained by draught,
# 5 = moored, 6 = aground, 7 = engaged in fishing, 8 = underway sailing.
NAV_STATUS_LABELS = {
    0: "UNDERWAY_USING_ENGINE",
    1: "AT_ANCHOR",
    2: "NOT_UNDER_COMMAND",
    3: "RESTRICTED_MANOEUVRABILITY",
    4: "CONSTRAINED_BY_DRAUGHT",
    5: "MOORED",
    6: "AGROUND",
    7: "ENGAGED_IN_FISHING",
    8: "UNDERWAY_SAILING",
    9: "RESERVED",
    10: "RESERVED",
    11: "RESERVED",
    12: "RESERVED",
    13: "RESERVED",
    14: "AIS_SART",
    15: "NOT_DEFINED",
}

STATIONARY_NAV_STATUSES = {1, 5}


@dataclass
class Observation:
    timestamp: datetime
    lat: float
    lon: float
    sog: float | None
    cog: float | None
    heading: float | None
    nav_status: int | None
    port_near: str | None
    distance_to_port_nm: float | None = None


def _parse_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_km = 6371.0088
    p1 = radians(lat1)
    p2 = radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lon2 - lon1)
    a = sin(dphi / 2) ** 2 + cos(p1) * cos(p2) * sin(dlambda / 2) ** 2
    km = 2 * radius_km * asin(sqrt(max(0.0, min(1.0, a))))
    return km / 1.852


def _position_stable(history: list[Observation]) -> tuple[bool, float]:
    """Return (stable, max displacement from latest observation in nm)."""
    if len(history) < 2:
        return False, float("inf")
    latest = history[-1]
    max_displacement = max(
        haversine_nm(latest.lat, latest.lon, item.lat, item.lon)
        for item in history[:-1]
    )
    return max_displacement <= POSITION_STABILITY_NM, max_displacement


def _stationary_start(history: list[Observation]) -> datetime | None:
    """Find the start of the continuous low-speed run ending at latest."""
    if not history:
        return None
    latest = history[-1]
    if latest.sog is None or latest.sog > IDLE_SOG_KN:
        return None

    start = latest.timestamp
    for idx in range(len(history) - 2, -1, -1):
        current = history[idx]
        newer = history[idx + 1]
        if current.sog is None or current.sog > IDLE_SOG_KN:
            break
        gap_hours = (newer.timestamp - current.timestamp).total_seconds() / 3600.0
        if gap_hours > 2.0:
            break
        start = current.timestamp
    return start


def _score(history: list[Observation], near_port: bool, distance_to_port_nm: float | None) -> dict[str, Any]:
    latest = history[-1]
    stationary = latest.sog is not None and latest.sog <= IDLE_SOG_KN
    stable, max_displacement = _position_stable(history)
    start = _stationary_start(history)
    idle_hours = 0.0
    if start is not None:
        idle_hours = max(0.0, (latest.timestamp - start).total_seconds() / 3600.0)

    nav_support = latest.nav_status in STATIONARY_NAV_STATUSES

    score = 0
    reasons: list[str] = []
    if stationary:
        score += 30
        reasons.append(f"SOG {latest.sog:.1f} kn is below the {IDLE_SOG_KN:.1f} kn threshold")
    if stable:
        score += 25
        reasons.append(f"position remained within {max_displacement:.2f} nm of the latest fix")
    if nav_support:
        score += 20
        reasons.append(f"AIS navigation status is {NAV_STATUS_LABELS.get(latest.nav_status, 'stationary status')}")
    if idle_hours >= HIGH_IDLE_HOURS:
        score += 15
        reasons.append(f"continuous low-speed period is {idle_hours:.1f} h")
    elif idle_hours >= MIN_IDLE_HOURS:
        score += 8
        reasons.append(f"continuous low-speed period is {idle_hours:.1f} h")
    if near_port:
        score += 10
        if distance_to_port_nm is not None:
            reasons.append(f"within {distance_to_port_nm:.1f} nm of a tracked port/anchorage")

    if score >= 80:
        confidence = "HIGH"
    elif score >= 60:
        confidence = "MEDIUM"
    elif score >= 40:
        confidence = "LOW"
    else:
        confidence = "VERY_LOW"

    idle = score >= 60 and stationary and idle_hours >= MIN_IDLE_HOURS and near_port

    return {
        "idle": idle,
        "idle_score": score,
        "idle_confidence": confidence,
        "idle_since": start.isoformat() if start else None,
        "idle_duration_hours": round(idle_hours, 2),
        "stationary": stationary,
        "position_stable": stable,
        "max_position_displacement_nm": round(max_displacement, 3) if max_displacement != float("inf") else None,
        "nav_status_support": nav_support,
        "nav_status_label": NAV_STATUS_LABELS.get(latest.nav_status, "UNKNOWN"),
        "near_port": near_port,
        "distance_to_port_nm": round(distance_to_port_nm, 2) if distance_to_port_nm is not None else None,
        "evidence": reasons,
        "available_for_charter": False,
        "availability_note": "AIS inactivity indicates potential idle status; charter availability must be verified independently.",
    }


def detect_idle_vessel(
    observations: Iterable[Observation],
    *,
    vessel: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    history = sorted(list(observations), key=lambda x: x.timestamp)
    if not history:
        return None
    latest = history[-1]
    result = _score(history, latest.port_near is not None, latest.distance_to_port_nm)
    result.update({
        "mmsi": str((vessel or {}).get("mmsi") or ""),
        "ship_name": (vessel or {}).get("ship_name") or "Unknown vessel",
        "ship_type": (vessel or {}).get("ship_type"),
        "imo": (vessel or {}).get("imo"),
        "destination": (vessel or {}).get("destination"),
        "latest_timestamp": latest.timestamp.isoformat(),
        "latitude": latest.lat,
        "longitude": latest.lon,
        "sog_kn": latest.sog,
        "cog": latest.cog,
        "heading": latest.heading,
        "nearest_port": latest.port_near,
        # AIS type 70-79 are cargo-ship categories. AIS alone does not
        # distinguish every cargo subtype reliably enough to assert "bulk"
        # ownership; this label is therefore deliberately cautious.
        "bulk_candidate": isinstance(latest.nav_status, int) and False,
    })
    ship_type = (vessel or {}).get("ship_type")
    try:
        ship_type_int = int(ship_type) if ship_type is not None else None
    except (TypeError, ValueError):
        ship_type_int = None
    result["bulk_candidate"] = ship_type_int is not None and 70 <= ship_type_int <= 79
    return result
