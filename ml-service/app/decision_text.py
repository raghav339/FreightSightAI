"""Decision text builders for FreightSight.

Deterministic human-readable wording used by the forecast/decision engine. The
wording itself lives in the per-language catalogs (app/locales/<lang>.json, keys
"decision.*" and "rejection.*"); TEXT / REJECTION_TEXT resolve keys in the language
of the current request (see app/i18n.py). English is the fallback.
"""

import re

from app.i18n import Namespace

TEXT = Namespace("decision")
REJECTION_TEXT = Namespace("rejection")


def build_rejection_reason(*, kind, vessel=None, port=None, value=None, limit=None, cargo=None, dwt=None):
    vessel = vessel or "This vessel class"
    if kind == "cargo":
        return REJECTION_TEXT["cargo"].format(vessel=vessel, cargo=cargo, dwt=dwt)
    if kind in ("loa", "beam", "draft"):
        return REJECTION_TEXT[kind].format(vessel=vessel, port=port, value=value, limit=limit)
    if kind == "unknown":
        return REJECTION_TEXT["unknown"].format(vessel=vessel, port=port)
    return REJECTION_TEXT["generic"].format(vessel=vessel)


def build_delay_note(*, delay_days):
    if not delay_days or delay_days <= 0:
        return ""
    return TEXT["delay_note"].format(delay=delay_days)


def build_transit_note(*, origin, destination, transit_days, source, distance_km=None, speed_knots=None):
    if source == "user_provided":
        return TEXT["transit_provided"].format(distance_km=distance_km, origin=origin, destination=destination, days=transit_days, speed=speed_knots)
    if source == "route_table":
        return TEXT["transit_table"].format(origin=origin, destination=destination, days=transit_days)
    return TEXT["transit_unavailable"]


def build_stowage_note(*, factor):
    if factor < 0.6:
        return TEXT["stowage_dense"].format(factor=factor)
    if factor > 1.6:
        return TEXT["stowage_light"].format(factor=factor)
    return TEXT["stowage_typical"].format(factor=factor)


def build_mode_note(*, mode):
    return TEXT["mode_charter"] if str(mode).strip().lower() == "charter" else TEXT["mode_spot"]


def build_prediction_text(*, commodity, destination, forecast, risk, direction, note, vessel, turnaround, pct_move, delay_days=0):
    risk_text = TEXT["risk"].format(risk=TEXT.get(f"risk_{risk}", risk))
    if pct_move > 0.03:
        window = TEXT["window_up"]
    elif pct_move < -0.03:
        window = TEXT["window_down"]
    else:
        window = TEXT["window_flat"]
    summary = TEXT["summary"].format(commodity=commodity, destination=destination, forecast=forecast, direction=TEXT[direction], risk_text=risk_text, window=window, note=note)
    if turnaround > 4 and risk in ("medium", "high"):
        idle = TEXT["idle_high"].format(days=turnaround)
    elif pct_move < -0.03:
        idle = TEXT["idle_down"]
    elif turnaround > 4:
        idle = TEXT["idle_slow"].format(days=turnaround)
    else:
        idle = TEXT["idle_ok"]
    idle = idle + build_delay_note(delay_days=delay_days)
    return summary, window, TEXT["vessel"].format(vessel=vessel, note=note), idle


def build_compare_note():
    return TEXT["compare_note"]


def build_idle_note():
    return TEXT["idle_note"]


def build_idle_reposition_note(*, origin, commodity, current_port):
    return TEXT["idle_reposition_note"].format(origin=origin, commodity=commodity, current_port=current_port)


def build_congestion_text(congestion_text):
    """Localise the port-congestion warning.

    ``congestion_text`` is the canonical English string produced by
    port_utils.congestion_warning(); it is parsed (role, port, level) and re-rendered
    in the request language, so the parsing never depends on the display language.
    """
    if not congestion_text or congestion_text.startswith("No elevated port-congestion"):
        return TEXT["congestion_none"]
    parts = []
    for raw in re.split(r"\s*\|\s*", congestion_text):
        m = re.match(r"^(Load port|Discharge port)\s+(.+?):\s+(medium|high) congestion risk", raw, re.I)
        if m:
            label = TEXT["label_load"] if m.group(1).lower() == "load port" else TEXT["label_discharge"]
            level = TEXT["level_" + m.group(3).lower()]
            parts.append(TEXT["congestion_item"].format(label=label, name=m.group(2), level=level))
    return " | ".join(parts) if parts else TEXT["congestion_none"]


def build_contract_text(*, pct_move, risk, duration_note, cargo_weight_tons, total_program_tons):
    if risk == "high":
        base = TEXT["contract_high"].format(duration=duration_note)
    elif pct_move > 0.03:
        base = TEXT["contract_up"].format(duration=duration_note)
    elif pct_move < -0.03:
        base = TEXT["contract_down"]
    else:
        base = TEXT["contract_flat"].format(duration=duration_note)
    if total_program_tons and cargo_weight_tons:
        import math
        voyages = max(1, math.ceil(total_program_tons / cargo_weight_tons))
        base += TEXT["voyages"].format(cargo=cargo_weight_tons, total=total_program_tons, voyages=voyages)
    return base


def build_not_recognized_vessel(*, vessel):
    return TEXT["vessel_not_recognized"].format(vessel=vessel)


def build_requested_rejected(*, vessel, reason, selected, note):
    return TEXT["vessel_requested_rejected"].format(vessel=vessel, reason=reason, selected=selected, note=note)


def build_key_feasibility_checks(*, note, checks):
    return TEXT["vessel_feasibility_checks"].format(note=note, checks=checks)


def build_draft_check_item(*, draft, limit):
    return TEXT["vessel_draft_check"].format(draft=draft, limit=limit)


def build_loa_check_item(*, loa, limit):
    return TEXT["vessel_loa_check"].format(loa=loa, limit=limit)


def build_port_data_warning():
    return TEXT["port_data_warning"]


def build_draft_exceeds_max(*, draft, max_draft):
    return TEXT["draft_exceeds_max"].format(draft=draft, max_draft=max_draft)


def build_vessel_explanation(*, selected_class, cargo_tonnage, selected_draft, port_depth, selected_port_ok, best_feasible_class, over_capacity, predicted_rate, previous_rate, failure_port_label=None, failure_depth=None):
    parts = []
    if over_capacity:
        parts.append(TEXT["vessel_capacity_over"].format(cargo=cargo_tonnage, vessel=selected_class))
    else:
        parts.append(TEXT["vessel_capacity_normal"].format(vessel=selected_class, cargo=cargo_tonnage))
    # BUGFIX: the failure branch used to always cite the destination
    # port's depth ("port_depth"), even when the actual constraint that
    # rejected this vessel class was at the origin port — see the note in
    # port_utils.recommend_vessel(). failure_depth/failure_port_label (when
    # supplied) point at whichever port really caused the rejection; fall
    # back to the destination depth when the caller couldn't determine
    # which port failed (e.g. an unrecognized vessel class), preserving
    # the old behaviour for that edge case.
    fail_depth = failure_depth if failure_depth is not None else port_depth
    have_dims = selected_draft is not None and port_depth is not None
    have_fail_dims = selected_draft is not None and fail_depth is not None
    if selected_port_ok:
        parts.append(TEXT["vessel_fit_ok"].format(draft=selected_draft, port_depth=port_depth) if have_dims else TEXT["vessel_fit_unknown"])
    elif have_fail_dims:
        port_label = TEXT["port_word_origin"] if failure_port_label == "origin" else TEXT["port_word_destination"]
        if best_feasible_class:
            parts.append(TEXT["vessel_fit_fail_alt"].format(vessel=selected_class, draft=selected_draft, port_depth=fail_depth, port_label=port_label, alt=best_feasible_class))
        else:
            parts.append(TEXT["vessel_fit_fail_none"].format(vessel=selected_class, draft=selected_draft, port_depth=fail_depth, port_label=port_label))
    else:
        parts.append(TEXT["vessel_fit_unknown"])
    timing = None
    if predicted_rate is not None and previous_rate:
        pct = (float(predicted_rate) - float(previous_rate)) / float(previous_rate)
        timing = TEXT["timing_up"] if pct > 0.03 else TEXT["timing_down"] if pct < -0.03 else TEXT["timing_flat"]
        parts.append(timing)
    explanation = " ".join(p for p in parts if p)
    recommended_class = best_feasible_class if (not selected_port_ok and best_feasible_class) else selected_class
    return {"recommended_class": recommended_class, "warnings": None if selected_port_ok else explanation, "timing": timing, "explanation": explanation}