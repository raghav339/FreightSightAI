"""Disruption Engine: "an external disruption becomes a procurement decision."

Step 1 of the Disruption Intelligence feature (see project chat log for the
full plan). This module is deliberately the ONLY place the math lives, and it
is used by both:

  * the "Simulate" path — a user picks an event type + severity (0-100) +
    port + optional duration, with no live data involved; and
  * the future "Live" path (marine_weather.py, not built yet) — a marine
    weather reading is converted to the same severity scale and fed in here.

Both paths produce a severity value and a port name; from there the impact
numbers (productivity loss, loading delay, vessel waiting, freight pressure)
are COMPUTED from formulas, never looked up from a table keyed by scenario
name. Two different severities for the same event type always produce two
different numbers — nothing here is a canned per-scenario constant.

What "not hardcoded" means here, precisely
--------------------------------------------
* There is no ``{"Mozambique Cyclone": {"delay": 4}}`` anywhere. The event
  TYPE ("cyclone") only selects which of the four impact channels it mainly
  loads (see EVENT_PROFILES) and a one-line label; the port and the severity
  the user picks are what actually drive every number.
* Port sensitivity (``port_exposure_factors``) comes from each port's real
  master-data fields (berths, cargo handling rate, typical congestion
  rating) — the same file the rest of the project already uses
  (``port_utils.PORT_INFRA``) — not a per-port constant invented for this
  feature.
* The few numeric constants below (``BASE_*``, the reference berths/rate
  used to normalise exposure) ARE fixed, because some starting point is
  unavoidable in a planning tool. They are openly labelled as engineering
  assumptions, not measured or fitted values, exactly like
  ``port_substitution.py``'s ``ASSUMPTIONS`` list. Changing them changes the
  scale of every result uniformly; they do not encode any particular event.

What this deliberately does NOT do
-----------------------------------
* It does not change sailing time at sea, reroute a vessel, or pick an
  alternative port — that is ``port_substitution.py``'s job. This module's
  "ETA impact" is PORT-SIDE only (loading delay + vessel waiting).
* It does not know the difference between a demo/simulated event and reality
  — callers must label that themselves (see ``assess_disruption``'s
  ``source`` argument), and the API layer must always echo it back plainly.
* It does not model compounding effects of many disruptions at once, or a
  disruption's knock-on effect on a THIRD port.
"""
from __future__ import annotations

import math
from typing import Any

# ---------------------------------------------------------------------------
# Event type profiles: relative weights (not magnitudes) saying which of the
# four impact channels a given event type mainly loads. These are engineering
# judgements about how each kind of event typically shows up operationally
# (e.g. a vessel shortage is mostly a freight/waiting story, not a port
# productivity story), not measurements. The actual SIZE of the impact comes
# from severity x the formulas below x the port's own exposure factors.
# ---------------------------------------------------------------------------
EVENT_PROFILES: dict[str, dict[str, Any]] = {
    "cyclone": {
        "label": "Tropical cyclone / severe storm",
        "channels": {"productivity": 1.0, "delay": 1.0, "waiting": 0.7, "freight": 0.6},
    },
    "port_closure": {
        "label": "Port closure (strike, incident, regulatory shutdown)",
        "channels": {"productivity": 1.3, "delay": 1.2, "waiting": 0.9, "freight": 0.5},
    },
    "vessel_shortage": {
        "label": "Vessel / tonnage shortage in the market",
        "channels": {"productivity": 0.1, "delay": 0.3, "waiting": 1.0, "freight": 1.2},
    },
    "freight_spike": {
        "label": "Sudden freight-rate spike (demand surge, bunker cost, etc.)",
        "channels": {"productivity": 0.0, "delay": 0.1, "waiting": 0.2, "freight": 1.3},
    },
    "congestion_surge": {
        "label": "Port congestion surge (queueing, anchorage backlog)",
        "channels": {"productivity": 0.4, "delay": 0.9, "waiting": 1.1, "freight": 0.4},
    },
    "extreme_weather": {
        "label": "Adverse marine weather (generic — used by the live-conditions path)",
        "channels": {"productivity": 0.8, "delay": 0.8, "waiting": 0.6, "freight": 0.4},
    },
}

# ---- labelled planning constants (see module docstring) -------------------
# Reference values used only to NORMALISE a port's own real fields into a
# 0..1 exposure score — not per-port constants.
REFERENCE_BERTHS = 8.0          # a well-provisioned bulk terminal, for scaling only
REFERENCE_HANDLING_RATE_TPD = 20000.0
CONGESTION_BASELINE_FACTOR = {"low": 1.0, "medium": 0.7, "high": 0.4, "unknown": 0.55}
NEUTRAL_EXPOSURE_FACTOR = 0.5   # used when a port has no data for a factor

# Planning-assumption magnitudes at severity=1.0 and neutral port exposure.
# These set the SCALE of the outputs; they are not tied to any named event.
BASE_DELAY_DAYS_AT_FULL_SEVERITY = 5.0
BASE_WAITING_DAYS_AT_FULL_SEVERITY = 3.0
BASE_FREIGHT_PRESSURE_PCT_AT_FULL_SEVERITY = 0.15  # 15%
MAX_PRODUCTIVITY_LOSS = 0.90     # a port never modelled as fully at zero capacity
MAX_DELAY_DAYS = 21.0
MAX_WAITING_DAYS = 14.0
MAX_FREIGHT_PRESSURE_PCT = 0.60

# A longer-running event compounds freight/waiting pressure a little more
# than a one-day spike, up to a cap. This is a mild, documented assumption,
# not a fitted curve.
DURATION_COMPOUND_PER_DAY = 0.03
DURATION_COMPOUND_CAP = 1.6

ASSUMPTIONS = [
    "Event-type weights (EVENT_PROFILES) are relative engineering judgements about which "
    "impact channels a kind of event typically loads, not measured or fitted values.",
    "Port exposure uses only static port master fields (berths, cargo handling rate, typical "
    "congestion rating) — not a live operational capacity or berth-occupancy feed.",
    "The BASE_* magnitudes set the overall scale of the outputs at maximum severity; they are "
    "planning assumptions, not measured historical delays for any specific event.",
    "ETA impact here is PORT-SIDE only (loading delay + vessel waiting). It does not include "
    "weather-driven slowdown of the vessel at sea, and it does not pick an alternative port — "
    "see the Port Substitution Engine for routing around a disrupted port.",
    "Duration compounds freight/waiting pressure mildly and is capped; it does not compound "
    "productivity loss or one-off loading delay.",
]


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def port_exposure_factors(port_info: dict[str, Any] | None) -> dict[str, Any]:
    """Turn a port's real master-data fields into 0..1 exposure factors.

    Higher factor = more resilient / less exposed for that dimension.
    Missing fields fall back to a labelled neutral value rather than being
    guessed. ``resilience`` is the simple average of the three factors that
    were actually available (equal weights); if none were available it is
    the neutral value too, and ``coverage`` says how many of the three had
    real data.
    """
    factors: dict[str, float | None] = {"berths": None, "handling": None, "congestion": None}
    info = port_info or {}

    berths = info.get("berths")
    if berths:
        factors["berths"] = clamp(float(berths) / REFERENCE_BERTHS, 0.0, 1.0)

    rate = info.get("cargo_handling_rate_tpd")
    if rate:
        factors["handling"] = clamp(float(rate) / REFERENCE_HANDLING_RATE_TPD, 0.0, 1.0)

    level = str(info.get("typical_congestion") or "").strip().lower()
    if level in CONGESTION_BASELINE_FACTOR:
        factors["congestion"] = CONGESTION_BASELINE_FACTOR[level]

    known = [v for v in factors.values() if v is not None]
    resilience = sum(known) / len(known) if known else NEUTRAL_EXPOSURE_FACTOR
    return {
        **{k: (v if v is not None else NEUTRAL_EXPOSURE_FACTOR) for k, v in factors.items()},
        "resilience": round(resilience, 3),
        "coverage": round(len(known) / 3, 2),
        "has_port_data": port_info is not None,
    }


def compute_impact(
    event_type: str,
    severity: float,
    port_info: dict[str, Any] | None,
    duration_days: float | None = None,
) -> dict[str, Any]:
    """Compute the four impact channels for one event at one port.

    Parameters
    ----------
    event_type: a key in EVENT_PROFILES.
    severity: 0..1 (already clamped by the caller's validation layer; this
        function clamps again defensively).
    port_info: the port's ``port_utils.get_port(...)`` record, or None if the
        port has no master data on file (exposure then falls back to neutral
        and this is reported in ``exposure``).
    duration_days: optional expected duration; mildly compounds freight and
        waiting pressure (see DURATION_COMPOUND_PER_DAY).
    """
    if event_type not in EVENT_PROFILES:
        raise ValueError(
            f"Unknown event type '{event_type}'. Known types: {', '.join(sorted(EVENT_PROFILES))}."
        )
    severity = clamp(float(severity), 0.0, 1.0)
    profile = EVENT_PROFILES[event_type]
    ch = profile["channels"]
    exposure = port_exposure_factors(port_info)
    resilience = exposure["resilience"]

    duration_days = float(duration_days) if duration_days else 1.0
    duration_factor = clamp(1.0 + DURATION_COMPOUND_PER_DAY * max(duration_days - 1.0, 0.0), 1.0, DURATION_COMPOUND_CAP)

    productivity_loss_pct = clamp(severity * ch["productivity"] * (1.0 - resilience), 0.0, MAX_PRODUCTIVITY_LOSS)

    # A port with fewer berths / lower handling rate queues up faster once
    # disrupted, on top of the base severity-driven delay.
    queue_pressure = 1.0 + (1.0 - exposure["berths"]) * 0.5 + (1.0 - exposure["handling"]) * 0.5
    loading_delay_days = clamp(
        BASE_DELAY_DAYS_AT_FULL_SEVERITY * severity * ch["delay"] * queue_pressure, 0.0, MAX_DELAY_DAYS
    )

    vessel_waiting_days = clamp(
        BASE_WAITING_DAYS_AT_FULL_SEVERITY * severity * ch["waiting"] * (1.0 + (1.0 - exposure["congestion"])) * duration_factor,
        0.0, MAX_WAITING_DAYS,
    )

    freight_pressure_pct = clamp(
        BASE_FREIGHT_PRESSURE_PCT_AT_FULL_SEVERITY * severity * ch["freight"] * duration_factor,
        0.0, MAX_FREIGHT_PRESSURE_PCT,
    )

    total_eta_impact_days = round(loading_delay_days + vessel_waiting_days, 2)

    return {
        "event_type": event_type,
        "event_label": profile["label"],
        "severity": round(severity, 3),
        "duration_days": duration_days,
        "exposure": exposure,
        "productivity_loss_pct": round(productivity_loss_pct, 4),
        "loading_delay_days": round(loading_delay_days, 2),
        "vessel_waiting_days": round(vessel_waiting_days, 2),
        "freight_pressure_pct": round(freight_pressure_pct, 4),
        "total_eta_impact_days": total_eta_impact_days,
    }


def build_propagation(impact: dict[str, Any], port: str, stockpile_buffer_days: float | None = None) -> list[dict[str, Any]]:
    """The event -> ... -> procurement chain, as ordered steps for the UI."""
    steps = [
        {"key": "event", "label": f"{impact['event_label']}",
         "detail": f"{port} · severity {round(impact['severity'] * 100)}/100" + (
             f" · ~{impact['duration_days']:.0f}d duration" if impact["duration_days"] != 1.0 else "")},
        {"key": "productivity", "label": "Port productivity",
         "detail": f"-{impact['productivity_loss_pct'] * 100:.0f}% (port data coverage {impact['exposure']['coverage'] * 100:.0f}%)"},
        {"key": "delay", "label": "Loading delay", "detail": f"+{impact['loading_delay_days']:.1f} days"},
        {"key": "waiting", "label": "Vessel waiting", "detail": f"+{impact['vessel_waiting_days']:.1f} days"},
        {"key": "freight", "label": "Freight pressure", "detail": f"+{impact['freight_pressure_pct'] * 100:.1f}%"},
        {"key": "eta", "label": "ETA impact (port-side)", "detail": f"+{impact['total_eta_impact_days']:.1f} days"},
    ]
    if stockpile_buffer_days is not None:
        breached = impact["total_eta_impact_days"] > stockpile_buffer_days
        steps.append({
            "key": "stockpile",
            "label": "Stockpile buffer",
            "detail": (
                f"Breached: {impact['total_eta_impact_days']:.1f}d impact vs {stockpile_buffer_days:.1f}d buffer"
                if breached else
                f"Holds: {impact['total_eta_impact_days']:.1f}d impact within {stockpile_buffer_days:.1f}d buffer"
            ),
            "breached": breached,
        })
        steps.append({
            "key": "procurement",
            "label": "Procurement action",
            "detail": (
                "Evaluate alternative loading/discharge ports or bring forward the next shipment."
                if breached else
                "No action required; buffer absorbs the delay."
            ),
        })
    else:
        steps.append({
            "key": "procurement",
            "label": "Procurement action",
            "detail": "Set a stockpile buffer to get a breach/no-breach call; otherwise, review alternative ports below.",
        })
    return steps


def list_event_types() -> list[dict[str, str]]:
    return [{"event_type": k, "label": v["label"]} for k, v in EVENT_PROFILES.items()]


def assess_disruption(
    event_type: str,
    port: str,
    severity: float,
    port_info: dict[str, Any] | None,
    *,
    source: str = "simulated",
    duration_days: float | None = None,
    stockpile_buffer_days: float | None = None,
) -> dict[str, Any]:
    """Full result for one disruption: impact numbers + propagation chain.

    ``source`` must be ``"simulated"`` or ``"live"`` and is always echoed back
    verbatim so the API/UI layer can never blur a simulated event into a real
    one — see module docstring.
    """
    if source not in ("simulated", "live"):
        raise ValueError("source must be 'simulated' or 'live'")
    impact = compute_impact(event_type, severity, port_info, duration_days)
    return {
        "source": source,
        "port": port,
        **impact,
        "propagation": build_propagation(impact, port, stockpile_buffer_days),
        "assumptions": ASSUMPTIONS,
    }
