"""English-only decision text builders for FreightSight.

This module contains deterministic human-readable wording used by the
forecast/decision engine. The application emits one consistent English wording set.
"""

import re

TEXT = {'rise': 'rise',
 'fall': 'fall',
 'flat': 'stay broadly flat',
 'risk': 'Market risk is {risk}.',
 'risk_low': 'low',
 'risk_medium': 'medium',
 'risk_high': 'high',
 'window_up': 'Charter within the next 1–2 weeks (rate trending up)',
 'window_down': 'You can wait 2–4 weeks (rate trending down)',
 'window_flat': 'Rate is stable; charter on your normal schedule',
 'summary': 'For {commodity} into {destination}, the route freight rate is forecast to {direction} to '
            'about ${forecast:.2f}/unit. {risk_text} {window}. {note}',
 'vessel': 'The recommended vessel is {vessel}. {note}',
 'idle_high': 'Estimated turnaround at discharge is ~{days} days, above the 4-day comfort band. Pre-book a laycan '
              "window with buffer, and line up a backhaul or repositioning cargo so the vessel isn't idle waiting at "
              'anchorage.',
 'idle_down': 'Rates are trending down — consider a short ballast reposition toward a firmer nearby load port, or hold '
              'the vessel on a 1–2 week extendable option.',
 'idle_slow': 'Estimated turnaround at discharge is ~{days} days. Coordinate berth prioritization in advance to avoid '
              'anchorage queueing and idle days.',
 'idle_ok': 'Turnaround and market direction look manageable; no special idle-time mitigation needed.',
 'contract_high': "Market volatility is high — a Contract of Affreightment (COA){duration} locking in today's terms "
                  'across multiple voyages hedges against future rate spikes better than repeated spot fixtures.',
 'contract_up': 'Rates are trending up — securing a short/mid-term COA{duration} now, rather than re-entering the spot '
                'market voyage-by-voyage, locks in the current rate before further increases.',
 'contract_down': 'Rates are trending down — a short spot or index-linked fixture is preferable to a long COA right '
                  'now; revisit COA coverage once rates stabilise.',
 'contract_flat': 'Rates look stable — a mid-term COA{duration} can still reduce chartering overhead versus repeated '
                  'single spot voyages.',
 'voyages': ' At {cargo:,.0f}t per lift, the {total:,.0f}t program implies roughly {voyages} voyages.',
 'congestion_none': 'No elevated port-congestion risk flagged for this route.',
 'congestion': '{label} {name}: {level} congestion risk — {notes}',
 'compare_note': 'The freight-rate forecast reflects global dry-bulk market conditions and does not vary by loading '
                 'port. Origins are ranked by vessel feasibility at both the load and discharge ports, estimated '
                 'transit time, and load-port congestion — the factors that actually differ by origin for a fixed '
                 'destination and commodity.',
 'idle_note': 'Ranked by a composite score combining predicted freight-rate earnings and ballast/idle time to the next '
              'load port — use alongside the idle-scenario-management guidance on a specific forecast for '
              'shipment-level planning.',
 'idle_reposition_note': 'Reposition to {origin} to load {commodity} back toward {current_port}.',
 'vessel_not_recognized': "Requested vessel type '{vessel}' is not a recognized vessel class.",
 'vessel_requested_rejected': 'The requested {vessel} is not feasible ({reason}); {selected} is recommended instead. '
                              '{note}',
 'vessel_feasibility_checks': '{note} Key feasibility checks: {checks}.',
 'vessel_draft_check': 'draft {draft:.1f} m against a port limit of {limit:.1f} m',
 'vessel_loa_check': 'LOA {loa:.0f} m against a port limit of {limit:.0f} m',
 'port_data_warning': 'Infrastructure data for one or both ports is limited or estimated; treat draft, LOA, and beam '
                      'constraints as indicative only.',
 'vessel_capacity_normal': '{vessel} is the smallest vessel class whose dataset-derived typical DWT can carry '
                           'approximately {cargo:,.0f} tonnes.',
 'vessel_capacity_over': 'The cargo quantity of approximately {cargo:,.0f} tonnes exceeds the typical dataset-derived '
                         'capacity of the largest vessel class ({vessel}); {vessel} is shown as the closest available '
                         'reference.',
 'vessel_fit_ok': 'Its typical draft of {draft:.1f} m is within the destination port depth of {port_depth:.1f} m.',
 'vessel_fit_unknown': 'Port depth or draft data is not fully available for this route, so this feasibility check is '
                       'approximate.',
 'vessel_fit_fail_alt': "{vessel}'s typical draft of {draft:.1f} m exceeds the destination port depth of "
                        '{port_depth:.1f} m, so {alt} is recommended instead as the largest class that fits both '
                        'ports.',
 'vessel_fit_fail_none': "{vessel}'s typical draft of {draft:.1f} m exceeds the destination port depth of "
                         '{port_depth:.1f} m, and no dataset vessel class fits both ports for this cargo; treat this '
                         'recommendation as indicative only.',
 'timing_up': 'Freight rates are trending up, so consider chartering sooner rather than later.',
 'timing_down': 'Freight rates are trending down, so there may be room to wait before chartering.',
 'timing_flat': 'Freight rates look stable.',
 'draft_exceeds_max': 'A typical draft of {draft:.1f} m exceeds the maximum permitted draft of {max_draft:.1f} m.',
 'delay_note': ' An additional {delay:g} day(s) of expected delay flagged on this request has been folded into the turnaround estimate above.',
 'transit_provided': 'Using the supplied distance of {distance_km:,.0f} km, estimated sea transit from {origin} to {destination} is about {days} days at a typical {speed:.1f}-knot laden bulk-carrier service speed.',
 'transit_table': 'Estimated sea transit from {origin} to {destination} is about {days} days, based on an indicative route-distance table (no distance was supplied on the request).',
 'transit_unavailable': 'No distance was supplied, and this origin-destination pair is not in the indicative route-distance table, so a transit-time estimate is not available.',
 'stowage_light': 'At {factor:.2f} m3/t, this cargo is relatively light/bulky for its weight (typical dry-bulk cargoes run roughly 0.4-1.6 m3/t) — cubic capacity, not deadweight, may end up being the binding constraint on vessel choice; confirm against the specific vessel class grain/bale capacity.',
 'stowage_dense': 'At {factor:.2f} m3/t, this cargo is relatively dense for its weight (typical dry-bulk cargoes run roughly 0.4-1.6 m3/t) — deadweight is very likely the binding constraint, consistent with the DWT-based vessel check above.',
 'stowage_typical': 'At {factor:.2f} m3/t, the implied stowage factor is within the typical dry-bulk range (roughly 0.4-1.6 m3/t); deadweight is the expected binding constraint, consistent with the vessel check above.',
 'mode_charter': 'Shipment mode is set to Charter — the figures above are framed as a chartering/COA decision (vessel hire under a charter party) rather than a one-off freight booking; the per-ton rate remains the reference point since this pipeline does not model daily hire-rate equivalents.',
 'mode_spot': 'Shipment mode is set to Bulk Carrier (spot voyage) — the figures above are framed as a single voyage-charter booking at the quoted per-ton rate.'}

REJECTION_TEXT = {'cargo': "Cargo of {cargo:,.0f} t exceeds {vessel}'s typical DWT capacity of {dwt:,.0f} t.",
 'loa': '{port} LOA limit: {vessel} LOA ({value:.0f} m) exceeds the port maximum ({limit:.0f} m).',
 'beam': '{port} beam limit: {vessel} beam ({value:.1f} m) exceeds the port maximum ({limit:.1f} m).',
 'draft': '{port} draft limit: {vessel} draft ({value:.1f} m) exceeds the port usable depth ({limit:.1f} m).',
 'unknown': 'Vessel feasibility cannot be confirmed for {vessel} because infrastructure data is unavailable for {port}.',
 'generic': '{vessel} is not feasible for the stated cargo and port constraints.'}


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
    if not congestion_text or congestion_text.startswith("No elevated port-congestion"):
        return TEXT["congestion_none"]
    parts = []
    for raw in re.split(r"\s*\|\s*", congestion_text):
        m = re.match(r"^(Load port|Discharge port)\s+(.+?):\s+(medium|high) congestion risk", raw, re.I)
        if m:
            parts.append(f"{m.group(1)} {m.group(2)}: {m.group(3).lower()} congestion risk")
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


def build_vessel_explanation(*, selected_class, cargo_tonnage, selected_draft, port_depth, selected_port_ok, best_feasible_class, over_capacity, predicted_rate, previous_rate):
    parts = []
    if over_capacity:
        parts.append(TEXT["vessel_capacity_over"].format(cargo=cargo_tonnage, vessel=selected_class))
    else:
        parts.append(TEXT["vessel_capacity_normal"].format(vessel=selected_class, cargo=cargo_tonnage))
    have_dims = selected_draft is not None and port_depth is not None
    if selected_port_ok:
        parts.append(TEXT["vessel_fit_ok"].format(draft=selected_draft, port_depth=port_depth) if have_dims else TEXT["vessel_fit_unknown"])
    elif have_dims:
        if best_feasible_class:
            parts.append(TEXT["vessel_fit_fail_alt"].format(vessel=selected_class, draft=selected_draft, port_depth=port_depth, alt=best_feasible_class))
        else:
            parts.append(TEXT["vessel_fit_fail_none"].format(vessel=selected_class, draft=selected_draft, port_depth=port_depth))
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