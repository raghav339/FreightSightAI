"""COA / multi-voyage cost optimizer.

This optimizer is deliberately a decision-support layer, not a charter quote.
It converts the route model's predicted percentage movement into an indicative
future USD/t only when the user supplies a current spot benchmark. It then
enumerates feasible vessel classes and voyage counts and ranks strategies by
total COA cost: freight + port + voyage/operating + delay/congestion costs
plus an explicit risk premium — see the cost-component tables below.
"""
from __future__ import annotations
import math
from datetime import date
from pathlib import Path
from .route_model import RouteModel

VESSEL_LOAD_FACTOR = {
    "Handysize":0.90, "Supramax":0.90, "Panamax":0.90, "Capesize":0.90
}
RISK_BUFFER = {"low":0.00,"medium":0.02,"high":0.05}

# --- Non-freight cost components -------------------------------------------
# The freight-rate market signal (route_model / BDRY proxy) only tells us
# $/tonne moved. It says nothing about the cost of physically running more
# or fewer voyages to move that tonnage, so a COA priced on freight rate
# alone gives every vessel class the same total cost (rate x total tons is
# invariant to how many voyages the total is split into) and the vessel
# choice becomes economically meaningless. These indicative, documented
# benchmarks (this stays a decision-support estimate, not a charter quote)
# let voyage count/vessel size actually move the ranking:
#   - Port cost: dues/pilotage/agency per port call, scales with vessel size.
VESSEL_PORT_CALL_COST_USD = {
    "Handysize": 12000, "Supramax": 16000, "Panamax": 22000, "Capesize": 30000,
}
#   - Daily operating cost: hire + bunker + running cost while at sea/berth.
VESSEL_DAILY_OPEX_USD = {
    "Handysize": 9000, "Supramax": 11000, "Panamax": 14000, "Capesize": 19000,
}
#   - Extra waiting days per port call implied by the static congestion
#     rating already on each port record (see port_utils.congestion_warning).
CONGESTION_DELAY_DAYS = {"low": 0.0, "medium": 1.5, "high": 3.5}

def optimize(req, route_model: RouteModel, port_utils):
    requested_lift = float(req.cargo_weight_tons) if req.cargo_weight_tons else None
    total=float(req.total_program_tons or requested_lift)
    if total <= 0: raise ValueError("total_program_tons must be positive")
    duration=max(float(req.contract_duration_months or 1),1.0)
    spot=getattr(req,"current_spot_rate_usd_per_ton",None)
    rf=route_model.predict(req.origin_port,req.destination_port,req.shipment_date,spot)
    horizon=rf.get("forecasts", [])
    if rf.get("forecast_type") == "route_specific":
        # Direct lane model predicts USD/t itself; use the mean of the
        # available forward horizons as the contract-rate planning estimate.
        direct_rates=[float(x["predicted_rate_usd_per_ton"]) for x in horizon if x.get("predicted_rate_usd_per_ton") is not None]
        projected_rate=float(sum(direct_rates) / len(direct_rates)) if direct_rates else None
    else:
        # Proxy model has no observed route-rate target. Only calibrate it to
        # dollars/tonne when the user supplies a current spot benchmark.
        moves=[x.get("proxy_change_pct", 0)/100 for x in horizon]
        avg_move=sum(moves)/len(moves) if moves else 0
        projected_rate=float(spot)*(1+avg_move) if spot is not None else None

    dest=port_utils.get_port(req.destination_port)
    origin=port_utils.get_port(req.origin_port)
    # For a COA, a vessel class can carry repeated parcels, so per-voyage
    # capacity is re-tested against each class's DWT below rather than using
    # feasible_vessels_both_ports()'s single-parcel cargo-capacity check.
    candidates=[]
    rejected=[]
    contract_days = duration * 30.4375
    for cls in ["Handysize","Supramax","Panamax","Capesize"]:
        spec=next((x for x in port_utils.get_vessel_specs() if x["vessel_class"]==cls),None)
        if not spec: continue
        ok_o,reason_o=port_utils.check_vessel_port_compatibility(cls,origin,label="origin port")
        ok_d,reason_d=port_utils.check_vessel_port_compatibility(cls,dest,label="destination port")
        if not (ok_o and ok_d):
            # Report both ends when both fail, since a class can be
            # simultaneously too big for the origin and the destination.
            reasons=[r for r in (reason_o if not ok_o else None, reason_d if not ok_d else None) if r]
            rejected.append({
                "vessel_type": cls,
                "rejection_reason": " ".join(reasons) or "Does not fit the port constraints at one or both ends.",
            })
            continue
        cap=max(float(spec["typical_dwt"])*VESSEL_LOAD_FACTOR.get(cls,.9),1)
        if requested_lift is not None:
            # User supplied a fixed per-voyage lift size — it must actually
            # fit on this vessel class, and it (not the class's own DWT)
            # drives the voyage count.
            if cap < requested_lift:
                rejected.append({
                    "vessel_type": cls,
                    "rejection_reason": (
                        f"{cls}'s effective capacity ({cap:,.0f} t) is smaller than the "
                        f"requested cargo/voyage of {requested_lift:,.0f} t."
                    ),
                })
                continue
            voyages=int(math.ceil(total/requested_lift))
        else:
            voyages=int(math.ceil(total/cap))
        parcel=total/voyages
        transit=port_utils.estimate_transit_days(req.origin_port,req.destination_port)
        turnaround=port_utils.port_turnaround_days(req.destination_port,parcel)
        cycle_days=transit+turnaround
        required_schedule_days = voyages * cycle_days
        schedule_slack_days = contract_days - required_schedule_days
        schedule_feasible = schedule_slack_days >= 0
        change_key = "rate_change_pct_vs_last_observed" if rf.get("forecast_type") == "route_specific" else "proxy_change_pct"
        max_change = max((abs(float(x.get(change_key, 0))) for x in rf.get("forecasts", [])), default=0.0)
        risk_label = "high" if max_change >= 10 else ("medium" if max_change >= 5 else "low")

        # --- Total COA cost = Freight + Port + Voyage/Operating + Delay/
        # Congestion + Risk Premium. Each of the last four scales with
        # *voyages* (and therefore with vessel capacity), not with total
        # tonnage — this is what makes a Capesize-at-2-voyages genuinely
        # cheaper or more expensive than a Supramax-at-3-voyages instead of
        # every class landing on an identical "rate x total_program_tons"
        # figure regardless of vessel choice.
        freight_cost = projected_rate * total if projected_rate is not None else None

        port_call_cost_usd = VESSEL_PORT_CALL_COST_USD.get(cls, 20000)
        # Two calls per voyage (load at origin, discharge at destination).
        port_cost = voyages * 2 * port_call_cost_usd

        daily_opex_usd = VESSEL_DAILY_OPEX_USD.get(cls, 12000)
        voyage_operating_cost = voyages * cycle_days * daily_opex_usd

        origin_congestion = (origin or {}).get("typical_congestion")
        dest_congestion = (dest or {}).get("typical_congestion")
        congestion_days_per_voyage = (
            CONGESTION_DELAY_DAYS.get(origin_congestion, 0.0)
            + CONGESTION_DELAY_DAYS.get(dest_congestion, 0.0)
        )
        congestion_cost = voyages * congestion_days_per_voyage * daily_opex_usd
        # Overrun penalty: if the voyage plan doesn't fit the contract
        # window, the charterer is effectively paying for the vessel(s)
        # beyond the contracted period.
        overrun_days = max(-schedule_slack_days, 0.0)
        overrun_cost = overrun_days * daily_opex_usd
        delay_congestion_cost = congestion_cost + overrun_cost

        risk_premium = freight_cost * RISK_BUFFER[risk_label] if freight_cost is not None else None
        non_freight_cost = port_cost + voyage_operating_cost + delay_congestion_cost

        total_cost = None
        if freight_cost is not None:
            total_cost = freight_cost + non_freight_cost + risk_premium
        # Blended $/t including every cost component, for an apples-to-apples
        # comparison across vessel classes — distinct from the raw market
        # freight rate below.
        rate = (freight_cost / total * (1 + RISK_BUFFER[risk_label])) if freight_cost is not None else None
        cost = total_cost
        blended_cost_usd_per_ton = (total_cost / total) if total_cost is not None else None
        # Ranking fallback when no market rate is available at all (no spot
        # benchmark and no route-specific model): rank by the real,
        # dollar-denominated non-freight cost (port + operating + delay),
        # which still varies meaningfully by voyage count/vessel size,
        # rather than the old unitless voyages*cycle_days index.
        ops_index=non_freight_cost
        candidates.append({
            "vessel_type":cls,"typical_dwt":round(float(spec["typical_dwt"]),1),
            "effective_cargo_tons_per_voyage":round(cap,1),"voyages":voyages,
            "average_parcel_tons":round(parcel,1),"estimated_cycle_days":round(cycle_days,1),
            "contract_duration_days":round(contract_days,1),"required_schedule_days":round(required_schedule_days,1),
            "schedule_slack_days":round(schedule_slack_days,1),"schedule_feasible":schedule_feasible,
            "schedule_note":("Fits inside the requested contract window." if schedule_feasible else
                              f"Requires ~{required_schedule_days:.0f} days vs {contract_days:.0f} available; contract window is too short for this vessel/voyage plan."),
            "contract_rate_usd_per_ton":round(rate,2) if rate is not None else None,
            "expected_freight_cost_usd":round(cost,2) if cost is not None else None,
            "blended_cost_usd_per_ton":round(blended_cost_usd_per_ton,2) if blended_cost_usd_per_ton is not None else None,
            "cost_breakdown_usd": {
                "freight_cost": round(freight_cost, 2) if freight_cost is not None else None,
                "port_cost": round(port_cost, 2),
                "voyage_operating_cost": round(voyage_operating_cost, 2),
                "delay_congestion_cost": round(delay_congestion_cost, 2),
                "risk_premium": round(risk_premium, 2) if risk_premium is not None else None,
                "total": round(total_cost, 2) if total_cost is not None else None,
            },
            "operational_index":round(ops_index,1),"risk_buffer_pct":round(RISK_BUFFER[risk_label]*100,2),
        })
    if not candidates:
        detail=" | ".join(f"{r['vessel_type']}: {r['rejection_reason']}" for r in rejected)
        prefix=(
            "No vessel class can carry the requested cargo/voyage at both origin and destination ports."
            if requested_lift is not None else
            "No vessel class is feasible at both origin and destination ports for the COA program."
        )
        raise ValueError(prefix + (f" {detail}" if detail else ""))
    feasible_schedule = [c for c in candidates if c["schedule_feasible"]]
    ranking_pool = feasible_schedule or candidates
    ranking_pool.sort(key=lambda x: (x["expected_freight_cost_usd"] if x["expected_freight_cost_usd"] is not None else x["operational_index"]))
    best=ranking_pool[0]
    spot_total=float(spot)*total if spot is not None else None
    savings=(spot_total-best["expected_freight_cost_usd"]) if spot_total is not None and best["expected_freight_cost_usd"] is not None and best["schedule_feasible"] else None
    return {
        "status":"optimized" if best["schedule_feasible"] else "no_schedule_feasible",
        "route":rf["route"],"total_program_tons":total,"contract_duration_months":duration,"contract_duration_days":round(contract_days,1),
        "requested_cargo_weight_tons":requested_lift,
        "current_spot_rate_usd_per_ton":spot,"spot_program_cost_usd":round(spot_total,2) if spot_total is not None else None,
        "best_strategy":best,"alternatives":candidates,
        "estimated_savings_vs_spot_usd":round(savings,2) if savings is not None else None,
        "estimated_savings_vs_spot_pct":round(savings/spot_total*100,2) if savings is not None and spot_total else None,
        "savings_note": (
            "current_spot_rate_usd_per_ton x total_program_tons is a freight-only benchmark; "
            "expected_freight_cost_usd is the full COA cost (freight + port + operating + "
            "delay/congestion + risk premium), so this comparison is not apples-to-apples — "
            "see cost_breakdown_usd on best_strategy for the freight-only component."
            if savings is not None else None
        ),
        "recommendation_note": (
            "Selected from schedule-feasible vessel strategies. Savings are shown only when a current spot benchmark is supplied."
            if best["schedule_feasible"] and spot is not None else
            "No vessel strategy fits the full COA within the requested contract window; increase duration, reduce program tonnage, or split the program."
            if not best["schedule_feasible"] else
            "No current spot benchmark supplied; ranking is operational and no monetary savings are claimed."
        ),
        "market_forecast":rf,
        "methodology":(
            "Cargo/voyage was supplied, so it is used as a fixed lift size: only vessel classes able to carry "
            "it are considered, and voyage count is total_program_tons \u00f7 that lift size. Total cost per "
            "vessel class = freight cost (market rate \u00d7 total tons) + port cost (dues/pilotage per port "
            "call \u00d7 voyages) + voyage/operating cost (daily opex \u00d7 cycle days \u00d7 voyages) + "
            "delay/congestion cost (static port-congestion rating + any contract-window overrun) + a risk "
            "premium on freight cost. Only freight cost is independent of voyage count; the other four scale "
            "with voyages, so fewer/larger-vessel voyages and more/smaller-vessel voyages are no longer priced "
            "identically. Uses direct observed-route forecasts when available or an AIS-enhanced market proxy "
            "calibrated to a user-supplied spot benchmark otherwise. It is not a broker/charter quote."
            if requested_lift is not None else
            "Enumerates both-port-feasible vessel classes, computes COA voyage count from dataset-derived typical DWT. "
            "Total cost per vessel class = freight cost (market rate \u00d7 total tons) + port cost (dues/pilotage per "
            "port call \u00d7 voyages) + voyage/operating cost (daily opex \u00d7 cycle days \u00d7 voyages) + "
            "delay/congestion cost (static port-congestion rating + any contract-window overrun) + a risk premium on "
            "freight cost. Only freight cost is independent of voyage count; the other four scale with voyages. Uses "
            "direct observed-route forecasts when available or an AIS-enhanced market proxy calibrated to a "
            "user-supplied spot benchmark otherwise. It is not a broker/charter quote."
        ),
    }