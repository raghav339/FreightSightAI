"""COA / multi-voyage cost optimizer.

This optimizer is deliberately a decision-support layer, not a charter quote.
It converts the route model's predicted percentage movement into an indicative
future USD/t only when the user supplies a current spot benchmark. It then
enumerates feasible vessel classes and voyage counts and ranks strategies by
expected freight spend plus an explicit risk/idle allowance.
"""
from __future__ import annotations
import math
from .route_model import RouteModel

VESSEL_LOAD_FACTOR = {
    "Handysize":0.90, "Supramax":0.90, "Panamax":0.90, "Capesize":0.90
}
RISK_BUFFER = {"low":0.00,"medium":0.02,"high":0.05}

def optimize(req, route_model: RouteModel, port_utils):
    requested_lift = float(req.cargo_weight_tons) if req.cargo_weight_tons else None
    total=float(req.total_program_tons or requested_lift)
    if total <= 0: raise ValueError("total_program_tons must be positive")
    duration=max(float(req.contract_duration_months or 1),1.0)
    spot=getattr(req,"current_spot_rate_usd_per_ton",None)
    # Price the lane for the requested commodity. Most lanes carry several commodities
    # (Coal / Iron Ore / Bulk Minerals & Ores) and, without this, predict() silently
    # returns whichever commodity's model it finds first for the origin/destination pair.
    rf=route_model.predict(req.origin_port,req.destination_port,req.shipment_date,spot,getattr(req,"commodity",None))
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
        ok_o,reason_o=port_utils.check_vessel_port_compatibility(cls,origin,label="origin port",port_name=req.origin_port)
        ok_d,reason_d=port_utils.check_vessel_port_compatibility(cls,dest,label="destination port",port_name=req.destination_port)
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
        risk_mult=1+RISK_BUFFER[risk_label]
        rate=projected_rate*risk_mult if projected_rate is not None else None
        cost=rate*total if rate is not None else None
        # operational index penalizes smaller parcels / more voyages and
        # long cycles. It is not a monetary cost when no spot rate is supplied.
        ops_index=voyages*cycle_days
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
            "operational_index":round(ops_index,1),"risk_buffer_pct":round((risk_mult-1)*100,2),
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
    # BUG FIX: the route model prices a lane, not a vessel class (route_model.predict()
    # takes no vessel_class argument), so contract_rate_usd_per_ton — and therefore
    # expected_freight_cost_usd — is identical across every candidate here whenever a
    # spot rate is supplied. Sorting by cost alone left every tie broken by Python's
    # stable sort falling back to the candidates list's build order (the fixed
    # ["Handysize","Supramax","Panamax","Capesize"] loop above), so "best_strategy" was
    # silently always Handysize whenever it was schedule-feasible — regardless of it
    # needing far more voyages (and so far more port calls, bunker burn, and schedule
    # risk) than a Panamax or Capesize doing the same program. operational_index
    # (voyages x cycle_days) is now the explicit tiebreak, so among cost-tied
    # candidates the fewer-voyage, shorter-cycle option wins, as it should.
    ranking_pool.sort(key=lambda x: (
        x["expected_freight_cost_usd"] if x["expected_freight_cost_usd"] is not None else x["operational_index"],
        x["operational_index"],
    ))
    best=ranking_pool[0]
    # True only when the model's freight cost can't tell these vessel classes apart at
    # all (the normal case whenever a spot rate is supplied) — surfaced in
    # recommendation_note below so the pick doesn't read as a cost-driven choice it isn't.
    cost_values = {c["expected_freight_cost_usd"] for c in ranking_pool if c["expected_freight_cost_usd"] is not None}
    freight_cost_is_tied = len(ranking_pool) > 1 and len(cost_values) <= 1 and cost_values
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
        "recommendation_note": (
            "Selected from schedule-feasible vessel strategies, tie-broken by fewest voyage-days, "
            "because the market-rate forecast does not vary by vessel class so freight cost alone "
            "does not distinguish them. Savings are shown only when a current spot benchmark is supplied."
            if best["schedule_feasible"] and spot is not None and freight_cost_is_tied else
            "Selected from schedule-feasible vessel strategies. Savings are shown only when a current spot benchmark is supplied."
            if best["schedule_feasible"] and spot is not None else
            "No vessel strategy fits the full COA within the requested contract window; increase duration, reduce program tonnage, or split the program."
            if not best["schedule_feasible"] else
            "No current spot benchmark supplied; ranking is operational and no monetary savings are claimed."
        ),
        "market_forecast":rf,
        "methodology":(
            "Cargo/voyage was supplied, so it is used as a fixed lift size: only vessel classes able to carry "
            "it are considered, and voyage count is total_program_tons \u00f7 that lift size. Uses direct "
            "observed-route forecasts when available or an AIS-enhanced market proxy calibrated to a "
            "user-supplied spot benchmark otherwise, and adds a transparent risk buffer. It is not a "
            "broker/charter quote."
            if requested_lift is not None else
            "Enumerates both-port-feasible vessel classes, computes COA voyage count from dataset-derived typical DWT, uses direct observed-route forecasts when available or an AIS-enhanced market proxy calibrated to a user-supplied spot benchmark otherwise, and adds a transparent risk buffer. It is not a broker/charter quote."
        ),
    }