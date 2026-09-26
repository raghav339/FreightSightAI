"""Port Substitution Engine: "If this discharge port becomes unavailable, where should we go?"

Pure logic (no database, no model, no clock, no network) so every rule can be
unit-tested with plain dicts. ``ModelBundle.port_substitution`` in ``utils.py``
gathers the facts (port master data, lane forecasts, live AIS radar) and feeds
them in here.

What it does
------------
For a failed destination it takes every other candidate port and

1. applies a HARD vessel gate: a candidate is only viable if at least one
   cargo-suitable vessel class passes draft, LOA and beam at that port (and,
   when a loading port is given, at the loading port too);
2. scores the viable candidates on six criteria and ranks them:

       freight impact        - change in $/t against the original lane
       expected delay        - extra sailing days + extra cargo-handling days
       congestion            - live AIS radar status, else a static rating
       proximity             - straight-line distance from the failed port
                               (how far cargo must be moved onward afterwards)
       cargo handling        - days to discharge the parcel at that port
       vessel margin         - draft / LOA headroom of the chosen vessel

3. returns a ranked list plus a "substitution map" (nodes + edges) for the UI.

What it deliberately does NOT do
--------------------------------
* It does not price onward rail/road/coastal movement, port dues, demurrage
  or surge congestion caused by many ships diverting at once. None of that
  data exists in this project, so those costs are NOT in the freight impact.
* Delay days are planning figures built from labelled assumptions (see
  ``port_radar.PLANNING_DELAY_DAYS`` and ``STATIC_CONGESTION_DELAY_DAYS``),
  not measured or predicted delays.
* Scores are RELATIVE among the viable options (min-max within this request);
  a 90 means "best of this set", not "90% good" in any absolute sense.
* Coverage is DATA COVERAGE (how many criteria rest on real data), not the
  probability that the ranking is right. Missing data is scored neutral and
  named in ``data_gaps`` instead of being guessed.
"""
from __future__ import annotations

import math
from typing import Any, Callable, Iterable

# criterion -> weight (sums to 1.0)
DEFAULT_WEIGHTS = {
    "freight": 0.25,
    "delay": 0.20,
    "congestion": 0.15,
    "proximity": 0.15,
    "handling": 0.15,
    "vessel_margin": 0.10,
}

CRITERION_LABEL = {
    "freight": "freight cost",
    "delay": "sailing and handling time",
    "congestion": "congestion",
    "proximity": "closeness to the failed port",
    "handling": "cargo handling speed",
    "vessel_margin": "vessel draft/LOA headroom",
}

# Fixed planning assumption (days) when only the static port rating is known.
STATIC_CONGESTION_DELAY_DAYS = {"low": 0.0, "medium": 0.5, "high": 1.5}
STATIC_CONGESTION_UNKNOWN_DAYS = 0.5

# Vessel headroom that counts as "comfortable" (fraction of the port limit).
COMFORTABLE_MARGIN = 0.25

NEUTRAL = 0.5  # score used when a criterion has no data for a candidate

PRIMARY_COUNT = 1
BACKUP_COUNT = 2


def haversine_nm(a: tuple[float, float] | None, b: tuple[float, float] | None) -> float | None:
    """Great-circle distance in nautical miles between two (lat, lon) points."""
    if not a or not b:
        return None
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return round(2 * 3440.065 * math.asin(math.sqrt(h)), 1)


def vessel_margin_ratio(vessel: dict[str, Any] | None, port_info: dict[str, Any] | None) -> tuple[float | None, float | None, float | None]:
    """(worst headroom ratio, draft margin m, LOA margin m) of a vessel at a port.

    Ratio is the smaller of the draft and LOA headroom as a fraction of the
    port's limit, so 0.0 means "just fits" and 0.25 means "25% to spare".
    """
    if not vessel or not port_info:
        return None, None, None
    ratios: list[float] = []
    draft_margin = loa_margin = None
    p_draft, v_draft = port_info.get("max_draft_m"), vessel.get("typical_draft")
    if p_draft and v_draft:
        draft_margin = round(float(p_draft) - float(v_draft), 2)
        ratios.append(draft_margin / float(p_draft))
    p_loa, v_loa = port_info.get("max_loa_m"), vessel.get("typical_length")
    if p_loa and v_loa:
        loa_margin = round(float(p_loa) - float(v_loa), 1)
        ratios.append(loa_margin / float(p_loa))
    return (round(min(ratios), 3) if ratios else None), draft_margin, loa_margin


def congestion_assumption(radar: dict[str, Any] | None, static_level: str | None) -> dict[str, Any]:
    """Congestion for one port: live AIS radar if it has a verdict, else static rating."""
    if radar and radar.get("status") in ("NORMAL", "WATCH", "ELEVATED", "CRITICAL"):
        impact = radar.get("impact") or {}
        days = impact.get("planning_assumption_days")
        if days is not None:
            return {
                "level": radar["status"].lower(),
                "source": "live_ais_radar",
                "radar_status": radar["status"],
                "delay_days": float(days),
                "basis": "Live AIS radar status; delay is a fixed planning assumption per status, not a measurement.",
            }
    level = (static_level or "").strip().lower()
    if level in STATIC_CONGESTION_DELAY_DAYS:
        return {
            "level": level, "source": "static_rating", "radar_status": (radar or {}).get("status"),
            "delay_days": STATIC_CONGESTION_DELAY_DAYS[level],
            "basis": "Static typical-congestion rating from the port master; no live AIS verdict available.",
        }
    return {
        "level": "unknown", "source": "assumed", "radar_status": (radar or {}).get("status"),
        "delay_days": STATIC_CONGESTION_UNKNOWN_DAYS,
        "basis": "No congestion data for this port; a neutral planning allowance is used.",
    }


def _lower_is_better(values: list[float | None]) -> list[float | None]:
    """Min-max to 0..1 where the smallest value scores 1. None stays None."""
    real = [v for v in values if v is not None]
    if not real:
        return [None] * len(values)
    lo, hi = min(real), max(real)
    if hi - lo < 1e-9:
        return [1.0 if v is not None else None for v in values]
    return [None if v is None else round(1.0 - (v - lo) / (hi - lo), 4) for v in values]


def score_options(options: list[dict[str, Any]], weights: dict[str, float] | None = None) -> None:
    """Fill ``score``, ``score_breakdown``, ``coverage`` and ``data_gaps`` on the VIABLE options in place."""
    weights = weights or DEFAULT_WEIGHTS
    viable = [o for o in options if o["feasible"]]
    if not viable:
        return

    raw = {
        "freight": [o["freight"].get("delta_usd_per_ton") for o in viable],
        "delay": [
            (None if o["delay"]["extra_transit_days"] is None and o["delay"]["extra_handling_days"] is None
             else (o["delay"]["extra_transit_days"] or 0.0) + (o["delay"]["extra_handling_days"] or 0.0))
            for o in viable
        ],
        "congestion": [o["congestion"]["delay_days"] for o in viable],
        "proximity": [o["distance"]["from_failed_nm"] for o in viable],
        "handling": [o["handling"]["discharge_days"] for o in viable],
    }
    scores = {k: _lower_is_better(v) for k, v in raw.items()}
    # vessel headroom: higher is better, saturating at COMFORTABLE_MARGIN
    scores["vessel_margin"] = [
        None if o["vessel"].get("margin_ratio") is None
        else round(max(0.0, min(o["vessel"]["margin_ratio"] / COMFORTABLE_MARGIN, 1.0)), 4)
        for o in viable
    ]

    labels = {
        "freight": "No freight forecast for this lane (or the failed lane), so freight impact is not scored.",
        "delay": "Transit/handling time could not be compared with the original plan.",
        "congestion": "No congestion data.",
        "proximity": "No coordinates on file, so distance from the failed port is unknown.",
        "handling": "No cargo-handling rate on file.",
        "vessel_margin": "Vessel or port dimensions missing, so headroom is unknown.",
    }
    for idx, opt in enumerate(viable):
        total = 0.0
        breakdown: dict[str, float] = {}
        gaps: list[str] = []
        gap_keys: list[str] = []
        known = 0
        for key, w in weights.items():
            s = scores[key][idx]
            if s is None:
                s_used = NEUTRAL
                gaps.append(labels[key])
                gap_keys.append(key)
            else:
                s_used = s
                known += 1
            breakdown[key] = round(s_used, 3)
            total += w * s_used
        opt["score"] = round(total * 100, 1)
        opt["score_breakdown"] = breakdown
        opt["coverage"] = round(known / len(weights), 2)
        opt["data_gaps"] = gaps
        opt["data_gap_keys"] = gap_keys


def _why(opt: dict[str, Any]) -> list[str]:
    """Short plain-language reasons: the strongest two criteria and the weakest one."""
    bd = opt.get("score_breakdown") or {}
    if not bd:
        return []
    real = [k for k in bd if k not in (opt.get("data_gap_keys") or [])]
    ordered = sorted(real, key=lambda k: bd[k], reverse=True)
    out: list[str] = []
    for k in ordered[:2]:
        if bd[k] >= 0.6:
            out.append(f"Strong on {CRITERION_LABEL[k]}.")
    if len(ordered) >= 3 and bd[ordered[-1]] <= 0.4:
        out.append(f"Weakest on {CRITERION_LABEL[ordered[-1]]}.")
    return out


def rank_options(options: list[dict[str, Any]], weights: dict[str, float] | None = None) -> list[dict[str, Any]]:
    """Score the viable options, rank them, and assign verdicts. Returns the sorted list."""
    score_options(options, weights)
    viable = sorted(
        (o for o in options if o["feasible"]),
        key=lambda o: (-o["score"], o["distance"]["from_failed_nm"] if o["distance"]["from_failed_nm"] is not None else float("inf"), o["port"]),
    )
    rest = sorted((o for o in options if not o["feasible"]), key=lambda o: o["port"])
    for i, o in enumerate(viable):
        o["rank"] = i + 1
        o["verdict"] = "PRIMARY" if i < PRIMARY_COUNT else "BACKUP" if i < PRIMARY_COUNT + BACKUP_COUNT else "VIABLE"
        o["why"] = _why(o)
    for o in rest:
        o["rank"] = None
        o["verdict"] = "NOT_VIABLE"
        o["score"] = None
        o["score_breakdown"] = {}
        o["coverage"] = None
        o["data_gaps"] = []
        o["data_gap_keys"] = []
        o["why"] = [o["vessel"].get("rejection_reason") or "No suitable vessel fits this port."]
    return viable + rest


def build_map(failed: dict[str, Any], ordered: list[dict[str, Any]]) -> dict[str, Any]:
    """Nodes and edges for the substitution map (failed port -> each candidate)."""
    nodes = [{"port": failed["port"], "lat": failed.get("lat"), "lon": failed.get("lon"), "role": "failed"}]
    edges = []
    for o in ordered:
        role = {"PRIMARY": "primary", "BACKUP": "backup", "VIABLE": "viable"}.get(o["verdict"], "not_viable")
        nodes.append({"port": o["port"], "lat": o.get("lat"), "lon": o.get("lon"), "role": role, "rank": o["rank"]})
        edges.append({
            "from": failed["port"], "to": o["port"], "rank": o["rank"], "role": role,
            "distance_nm": o["distance"]["from_failed_nm"], "feasible": o["feasible"],
        })
    return {"nodes": nodes, "edges": edges}


def build_recommendation(failed_port: str, ordered: list[dict[str, Any]]) -> str:
    viable = [o for o in ordered if o["feasible"]]
    if not viable:
        return (
            f"If {failed_port} becomes unavailable, none of the other ports can take this cargo with any vessel class "
            "that also fits the loading port. Consider a smaller parcel, a different vessel class, or transshipment."
        )
    p = viable[0]
    bits = [f"If {failed_port} becomes unavailable, divert to {p['port']}."]
    fr = p["freight"]
    if fr.get("delta_usd_per_ton") is not None:
        d = fr["delta_usd_per_ton"]
        bits.append(
            f"Forecast freight {'rises' if d > 0 else 'falls' if d < 0 else 'is unchanged'}"
            + (f" by ${abs(d):.2f}/t" if abs(d) >= 0.005 else "") + "."
        )
    if p["distance"]["from_failed_nm"] is not None:
        bits.append(f"It is about {p['distance']['from_failed_nm']:.0f} nm from {failed_port}.")
    if not p["vessel"].get("keeps_planned_vessel") and p["vessel"].get("planned_vessel"):
        bits.append(f"The planned {p['vessel']['planned_vessel']} does not fit there; use {p['vessel']['class']}.")
    backups = [o["port"] for o in viable[1:1 + BACKUP_COUNT]]
    if backups:
        bits.append("Backups: " + ", ".join(backups) + ".")
    return " ".join(bits)


ASSUMPTIONS = [
    "Freight impact uses the route model's forecast per lane; port dues, onward rail/road/coastal cost, demurrage and surge congestion from many ships diverting at once are NOT included.",
    "Delay days are planning figures from labelled assumptions (live AIS radar status where available, otherwise a static congestion rating), not measured delays.",
    "Distance from the failed port is straight-line, not a routed distance.",
    "Scores are relative among the viable options in this request.",
    "Port dimensions come from the project's port master data; verify berth availability and draft limits with the port authority before acting.",
]
