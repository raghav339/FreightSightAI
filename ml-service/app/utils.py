import json
from datetime import date
from pathlib import Path
import pandas as pd
from app import port_utils
from app import brent
from app.i18n import t
from route_freight_model import RouteFreightModel
try:
    # AIS is a live, best-effort enhancement. If aisstream isn't
    # configured/running (no AISSTREAM_API_KEY, websocket-client missing,
    # import error) the rest of ModelBundle must keep working exactly as
    # before.
    from app.ais_stream import collector as ais_collector
except Exception:
    ais_collector = None
from app.decision_text import (
    build_prediction_text,
    build_contract_text,
    build_congestion_text,
    build_compare_note,
    build_idle_note,
    build_idle_reposition_note,
    build_not_recognized_vessel,
    build_requested_rejected,
    build_key_feasibility_checks,
    build_draft_check_item,
    build_loa_check_item,
    build_port_data_warning,
    build_rejection_reason,
    build_transit_note,
    build_stowage_note,
    build_mode_note,
)

MODELS_DIR = Path(__file__).resolve().parent / ".." / "models"

# Two-threshold bucketing for the deterministic risk score below (see
# _derive_risk). Chosen to land in roughly the same low/medium/high split
# the old trained classifier's train-only tertiles used, but this is now a
# plain, auditable rule instead of a fitted model.
RISK_THRESHOLDS = (0.35, 0.6)

# Same five factors/weights the project's risk_methodology always
# documented (see models/metadata.json's old risk_weights), just no longer
# fed into a RandomForest trained against a BDRY-derived label. Each factor
# below is computed directly from the route-freight forecast itself.
RISK_WEIGHTS = {
    "volatility": 0.35,
    "rate_shock": 0.20,
    "trend_deviation": 0.15,
    "port_congestion": 0.20,
    "data_uncertainty": 0.10,
}

# Used instead of RISK_WEIGHTS while fresh Brent data is available (see
# app/brent.py). "fuel_shock" takes 0.10 of the weight, 0.05 each from
# volatility and rate_shock, so the weights still sum to 1.0. When Brent is
# missing/stale the original RISK_WEIGHTS apply unchanged.
RISK_WEIGHTS_WITH_FUEL = {
    "volatility": 0.30,
    "rate_shock": 0.15,
    "trend_deviation": 0.15,
    "port_congestion": 0.20,
    "data_uncertainty": 0.10,
    "fuel_shock": 0.10,
}


class ModelBundle:
    """Decision engine for a single route+commodity+date forecast request.

    HISTORY: this class used to wrap a RandomForest regressor + classifier
    trained on a BDRY (Baltic Dry Index) market-proxy target
    (forecast_model.joblib / risk_model.joblib / feature_encoder.joblib).
    That pipeline has been removed entirely. The freight-rate level now
    comes ONLY from RouteFreightModel (route_freight_model.py), trained on
    synthetic (and, once available, verified) route freight-rate
    observations. Risk is derived deterministically from that same
    route-freight forecast (see _derive_risk) instead of a separately
    trained classifier.

    Practical consequence: a request for a route/commodity with no
    route-freight coverage now raises ValueError instead of silently
    falling back to a BDRY-derived number. Callers (app/main.py) turn that
    into a 400 with an explanatory message.
    """

    def __init__(self):
        with open(MODELS_DIR / "metadata.json") as f:
            self.meta = json.load(f)
        # metadata.json is still used, but only for the static reference
        # lists it also happens to carry (origins/destinations/routes/
        # commodities/shipment_modes/vessel_types) — not for anything
        # forecast-model-shaped. Those lists describe the network the app
        # covers, not the (now-removed) BDRY pipeline.
        self.route_freight = RouteFreightModel(MODELS_DIR, MODELS_DIR.parent / "data" / "production")

    # ------------------------------------------------------------------
    # Risk derivation (replaces the trained risk_model.joblib classifier)
    # ------------------------------------------------------------------
    def _port_congestion_score(self, origin_port, destination_port):
        levels = {"low": 0.0, "medium": 0.5, "high": 1.0}
        scores = []
        for name in (origin_port, destination_port):
            info = port_utils.get_port(name)
            if info and info.get("typical_congestion") in levels:
                scores.append(levels[info["typical_congestion"]])
        return max(scores) if scores else 0.3  # unknown ports: mild default, never zero

    def _derive_risk(self, route_result, forecast_curve, pct, origin_port, destination_port):
        """Deterministic low/medium/high risk label from the route-freight
        forecast itself, plus static port-congestion data. Replaces the
        BDRY-trained classifier with an auditable weighted score using the
        same five factors this project's risk_methodology always named.
        """
        h1 = forecast_curve[0] if forecast_curve else None

        # volatility: ensemble spread (lower/upper bound) at H+1, relative
        # to the predicted level.
        volatility = 0.5
        if h1 and h1.get("lower_bound") is not None and h1.get("upper_bound") is not None and h1.get("predicted_rate"):
            width = abs(h1["upper_bound"] - h1["lower_bound"])
            volatility = min(width / abs(h1["predicted_rate"]) / 0.5, 1.0) if h1["predicted_rate"] else 0.5

        # rate_shock: magnitude of the H+1 move vs. last observed rate.
        rate_shock = min(abs(pct) / 0.15, 1.0)

        # trend_deviation: how much the curve accelerates/reverses across
        # horizons (H+3 move vs H+1 move) — a route trending consistently
        # is lower risk than one whose direction flips or accelerates hard.
        trend_deviation = 0.3
        if len(forecast_curve) >= 2:
            first_pct = forecast_curve[0].get("predicted_rate")
            last_pct = forecast_curve[-1].get("predicted_rate")
            if first_pct and last_pct and h1 and h1.get("predicted_rate"):
                drift = abs(last_pct - first_pct) / abs(h1["predicted_rate"])
                trend_deviation = min(drift / 0.2, 1.0)

        port_congestion = self._port_congestion_score(origin_port, destination_port)

        # data_uncertainty: synthetic MVP data is inherently less certain
        # than verified observations; data_confidence further modulates it.
        data_confidence = route_result.get("data_confidence", "low")
        data_uncertainty = {"high": 0.1, "medium": 0.45, "low": 0.8}.get(data_confidence, 0.8)
        if route_result.get("data_mode") == "synthetic_mvp":
            data_uncertainty = max(data_uncertainty, 0.7)

        # fuel_shock: size of the recent Brent move (either direction; a
        # sharp swing is a cost-volatility signal). Read from the local cache;
        # the factor drops out entirely if Brent data is missing or stale.
        brent_signal = brent.fuel_shock()
        if brent_signal["available"]:
            fuel_shock = min(abs(brent_signal["pct_change_30d"]) / brent.SHOCK_CAP, 1.0)
            weights = RISK_WEIGHTS_WITH_FUEL
        else:
            fuel_shock = None
            weights = RISK_WEIGHTS

        score = (
            weights["volatility"] * volatility
            + weights["rate_shock"] * rate_shock
            + weights["trend_deviation"] * trend_deviation
            + weights["port_congestion"] * port_congestion
            + weights["data_uncertainty"] * data_uncertainty
            + (weights["fuel_shock"] * fuel_shock if fuel_shock is not None else 0.0)
        )
        low_t, high_t = RISK_THRESHOLDS
        if score < low_t:
            risk = "low"
            confidence = 1.0 - (score / low_t) * 0.5
        elif score < high_t:
            risk = "medium"
            confidence = 0.6
        else:
            risk = "high"
            confidence = 0.5 + min((score - high_t) / (1.0 - high_t), 1.0) * 0.5
        return risk, round(float(min(max(confidence, 0.0), 1.0)), 3), {
            "volatility": round(volatility, 3),
            "rate_shock": round(rate_shock, 3),
            "trend_deviation": round(trend_deviation, 3),
            "port_congestion": round(port_congestion, 3),
            "data_uncertainty": round(data_uncertainty, 3),
            "fuel_shock": round(fuel_shock, 3) if fuel_shock is not None else None,
            "brent": (
                {
                    "pct_change_30d": round(brent_signal["pct_change_30d"], 4),
                    "latest_usd_per_bbl": brent_signal["latest_usd_per_bbl"],
                    "as_of": brent_signal["as_of"],
                }
                if fuel_shock is not None
                else {"available": False, "reason": brent_signal["reason"]}
            ),
            "score": round(score, 3),
            "thresholds": {"low_below": low_t, "high_at_or_above": high_t},
        }

    # ------------------------------------------------------------------
    # Core forecast (route-freight only — no BDRY fallback)
    # ------------------------------------------------------------------
    def _route_forecast(self, origin_port, destination_port, commodity, shipment_date):
        route_result = self.route_freight.predict(
            origin_port, destination_port, shipment_date, commodity=commodity
        ) if self.route_freight is not None else None

        if route_result is None or not route_result.get("forecasts") or route_result.get("model_beats_baseline") is not True:
            raise ValueError(
                t("errors.no_route_forecast", origin=origin_port, destination=destination_port,
                  commodity_part=f" ({commodity})" if commodity else "")
            )

        route_h1 = route_result["forecasts"][0]
        prev = float(route_result["last_available_freight_usd_per_ton"])
        forecast = float(route_h1["predicted_rate_usd_per_ton"])
        pct = (forecast - prev) / prev if prev else 0.0

        forecast_type = "synthetic_route" if route_result.get("data_mode") == "synthetic_mvp" else "route_specific"
        forecast_basis = t("forecast.basis_synthetic") if forecast_type == "synthetic_route" else t("forecast.basis_verified")
        forecast_source = (
            t("forecast.source_synthetic")
            if forecast_type == "synthetic_route"
            else t("forecast.source_verified")
        )
        def _curve_point_confidence(item: dict) -> float:
            """Ensemble-spread-based confidence for one forecast point: a
            tight lower/upper bound relative to the predicted level means
            the per-tree ensemble agrees, so confidence is high; a wide
            spread means the trees disagree, so confidence is low. This is
            a heuristic derived from the same ensemble percentile spread
            already exposed as lower_bound/upper_bound — not a statistical
            confidence interval (see route_freight_model.py's own
            interval_note)."""
            rate = item.get("predicted_rate_usd_per_ton")
            lo = item.get("lower_bound")
            hi = item.get("upper_bound")
            if not rate or lo is None or hi is None:
                return 0.5
            spread = abs(hi - lo) / abs(rate) if rate else 1.0
            return round(float(min(max(1.0 - spread, 0.05), 0.99)), 3)

        forecast_curve = [
            {
                "horizon": f"H+{item['horizon_months']}",
                "date": item["target_date"],
                "predicted_rate": item["predicted_rate_usd_per_ton"],
                "lower_bound": item.get("lower_bound"),
                "upper_bound": item.get("upper_bound"),
                "confidence": _curve_point_confidence(item),
            }
            for item in route_result["forecasts"]
        ]
        data_source_level = "synthetic_route" if forecast_type == "synthetic_route" else "route_specific"
        data_confidence = route_result.get("data_confidence", "low")

        risk, risk_confidence, risk_factors = self._derive_risk(
            route_result, forecast_curve, pct, origin_port, destination_port
        )

        dest_port_info = port_utils.get_port(destination_port)
        port_depth = None
        if dest_port_info:
            port_depth = (
                dest_port_info.get("cargo_depth_m")
                or dest_port_info.get("channel_depth_m")
                or dest_port_info.get("max_draft_m")
            )

        return {
            "route_result": route_result,
            "prev": prev, "forecast": forecast, "pct": pct,
            "forecast_curve": forecast_curve,
            "forecast_type": forecast_type, "forecast_basis": forecast_basis, "forecast_source": forecast_source,
            "training_data_mode": route_result.get("data_mode", "unknown"),
            "data_source_level": data_source_level, "data_confidence": data_confidence,
            "risk": risk, "confidence": risk_confidence, "risk_factors": risk_factors,
            "dest_port_info": dest_port_info, "port_depth": port_depth,
        }

    def predict(self, req, core=None):
        core = core or self._route_forecast(req.origin_port, req.destination_port, req.commodity, req.shipment_date)
        prev = core["prev"]; forecast = core["forecast"]; pct = core["pct"]
        forecast_curve = core["forecast_curve"]
        forecast_type = core["forecast_type"]; forecast_basis = core["forecast_basis"]; forecast_source = core["forecast_source"]
        training_data_mode = core["training_data_mode"]
        data_source_level = core["data_source_level"]; data_confidence = core["data_confidence"]
        risk = core["risk"]; confidence = core["confidence"]; risk_factors = core["risk_factors"]
        dest_port_info = core["dest_port_info"]; port_depth = core["port_depth"]
        route_result = core["route_result"]

        origin_port_info = port_utils.get_port(req.origin_port)

        feasible_candidates, rejected_candidates = port_utils.feasible_vessels_both_ports(
            req.cargo_weight_tons,
            origin_port_info,
            dest_port_info,
        )
        feasible = [c["vessel_class"] for c in feasible_candidates]

        recommendation = port_utils.recommend_vessel(
            req.cargo_weight_tons,
            port_depth,
            port_name=req.destination_port,
            origin_port_name=req.origin_port,
            predicted_rate=forecast,
            previous_rate=prev,
        )

        requested_vessel = req.vessel_type
        vessel_rejection_reason = None

        if requested_vessel:
            requested = next(
                (v for v in feasible_candidates if v["vessel_class"] == requested_vessel),
                None,
            )
            if requested is not None:
                vessel = requested_vessel
                vessel_status = "REQUESTED_VESSEL_FEASIBLE"
            else:
                rej = next((r for r in rejected_candidates if r["vessel_class"] == requested_vessel), None)
                vessel_rejection_reason = (
                    rej["rejection_reason"] if rej
                    else build_not_recognized_vessel(vessel=requested_vessel)
                )
                if feasible_candidates:
                    vessel = recommendation["recommended_vessel"]
                    vessel_status = "REQUESTED_VESSEL_NOT_FEASIBLE_USING_RECOMMENDED"
                else:
                    vessel = recommendation["recommended_vessel"]
                    vessel_status = "NO_FEASIBLE_VESSEL"
        else:
            vessel = recommendation["recommended_vessel"]
            vessel_status = "RECOMMENDED_VESSEL" if feasible_candidates else "NO_FEASIBLE_VESSEL"

        note = recommendation["explanation"]
        recommended_vessel_reason = note
        if vessel_status == "REQUESTED_VESSEL_NOT_FEASIBLE_USING_RECOMMENDED" and vessel_rejection_reason:
            recommended_vessel_reason = build_requested_rejected(
                vessel=requested_vessel, reason=vessel_rejection_reason, selected=vessel, note=note,
            )
        elif feasible_candidates:
            dims = []
            spec = next((c for c in feasible_candidates if c["vessel_class"] == vessel), feasible_candidates[0])
            if spec.get("typical_draft") is not None and dest_port_info and dest_port_info.get("max_draft_m") is not None:
                dims.append(build_draft_check_item(draft=spec["typical_draft"], limit=dest_port_info["max_draft_m"]))
            if spec.get("typical_length") is not None and origin_port_info and origin_port_info.get("max_loa_m") is not None:
                dims.append(build_loa_check_item(loa=spec["typical_length"], limit=origin_port_info["max_loa_m"]))
            if dims:
                recommended_vessel_reason = build_key_feasibility_checks(note=note, checks="; ".join(dims))

        rejected_reasons = []
        for entry in rejected_candidates:
            item = dict(entry)
            kind = "generic"
            port_name = None
            value = None
            limit = None
            if float(entry.get("typical_dwt", 0) or 0) < float(req.cargo_weight_tons):
                kind = "cargo"
                item["rejection_reason"] = build_rejection_reason(
                    kind=kind, vessel=entry.get("vessel_class"), cargo=req.cargo_weight_tons,
                    dwt=float(entry.get("typical_dwt", 0) or 0)
                )
            else:
                for label, port_name_candidate, info in (
                    ("origin port", req.origin_port, origin_port_info),
                    ("destination port", req.destination_port, dest_port_info),
                ):
                    ok, reason = port_utils.check_vessel_port_compatibility(entry.get("vessel_class"), info, label=label)
                    if ok:
                        continue
                    port_name = port_name_candidate
                    low = (reason or "").lower()
                    if "loa limitation" in low:
                        kind = "loa"
                        spec = port_utils.VESSEL_LIMIT_SPECS.get(entry.get("vessel_class"), {})
                        value = float(spec.get("max_loa_m")) if spec.get("max_loa_m") is not None else None
                        limit = float(info.get("max_loa_m")) if info and info.get("max_loa_m") is not None else None
                    elif "beam limitation" in low:
                        kind = "beam"
                        spec = port_utils.VESSEL_LIMIT_SPECS.get(entry.get("vessel_class"), {})
                        value = float(spec.get("max_beam_m")) if spec.get("max_beam_m") is not None else None
                        limit = float(info.get("max_beam_m")) if info and info.get("max_beam_m") is not None else None
                    elif "draft limitation" in low:
                        kind = "draft"
                        spec = port_utils.VESSEL_LIMIT_SPECS.get(entry.get("vessel_class"), {})
                        value = float(spec.get("max_draft_m")) if spec.get("max_draft_m") is not None else None
                        depths = [x for x in ((info or {}).get("cargo_depth_m"), (info or {}).get("channel_depth_m"), (info or {}).get("max_draft_m")) if x is not None]
                        limit = float(min(depths)) if depths else None
                    elif "no infrastructure data" in low:
                        kind = "unknown"
                    break
                item["rejection_reason"] = build_rejection_reason(kind=kind, vessel=entry.get("vessel_class"), port=port_name, value=value, limit=limit)
            rejected_reasons.append(item)

        turnaround = port_utils.port_turnaround_days(req.destination_port, req.cargo_weight_tons, delay_days=req.delay_days or 0)
        congestion = port_utils.congestion_warning(req.origin_port, req.destination_port)

        transit_days = port_utils.estimate_transit_days(req.origin_port, req.destination_port, distance_km_override=req.distance_km)
        transit_source = (
            "user_provided" if (req.distance_km and req.distance_km > 0)
            else ("route_table" if transit_days is not None else "unavailable")
        )
        transit_note = build_transit_note(
            origin=req.origin_port, destination=req.destination_port,
            transit_days=transit_days, source=transit_source,
            distance_km=req.distance_km, speed_knots=port_utils.DEFAULT_SERVICE_SPEED_KNOTS,
        )

        stowage_factor_value = port_utils.stowage_factor(req.cargo_weight_tons, req.cargo_volume_cbm)
        stowage_note = build_stowage_note(factor=stowage_factor_value) if stowage_factor_value is not None else None

        direction_key = "rise" if pct > 0.03 else "fall" if pct < -0.03 else "flat"
        summary, window, vessel_note, idle = build_prediction_text(
            commodity=req.commodity, destination=req.destination_port,
            forecast=forecast, risk=risk, direction=direction_key, note=note,
            vessel=vessel, turnaround=turnaround, pct_move=pct,
            delay_days=req.delay_days or 0,
        )
        duration_note = f" over {req.contract_duration_months:.0f} months" if req.contract_duration_months else ""
        strategy = build_contract_text(
            pct_move=pct, risk=risk, duration_note=duration_note,
            total_program_tons=req.total_program_tons, cargo_weight_tons=req.cargo_weight_tons
        )
        strategy = strategy + " " + build_mode_note(mode=req.shipment_mode)

        trend = [
            {"label": "route lag 3m", "value": round(float(route_result["forecasts"][0]["predicted_rate_usd_per_ton"]), 2)},
            {"label": "route last available", "value": round(prev, 2)},
            {"label": "route forecast", "value": round(forecast, 2)},
        ]

        return {
            "route": f"{req.origin_port}-{req.destination_port}",
            "predicted_freight_rate_usd_per_ton": round(forecast, 2),
            "risk_label": risk, "risk_confidence": round(confidence, 3), "risk_factors": risk_factors,
            "recommended_vessel_type": vessel, "recommended_charter_window": window,
            "summary": summary, "trend_points": trend,
            "feasible_vessel_types": feasible, "vessel_constraint_note": vessel_note,
            "origin_port_info": self._port_info(req.origin_port), "destination_port_info": self._port_info(req.destination_port),
            "port_turnaround_days": turnaround, "idle_management_advice": idle,
            "congestion_warning": build_congestion_text(congestion), "contracting_strategy": strategy,
            "feature_importance": [], "top_drivers": [],
            "data_source_level": data_source_level, "vessel_status": vessel_status,
            "vessel_rejection_reason": vessel_rejection_reason, "rejected_vessel_types": rejected_reasons,
            "forecast_curve": forecast_curve, "forecast_type": forecast_type, "data_confidence": data_confidence,
            "training_data_mode": training_data_mode,
            "forecast_basis": forecast_basis, "forecast_source": forecast_source,
            "route_model_available": True,
            "route_model_beats_baseline": route_result.get("model_beats_baseline"),
            "route_model_fallback_note": None,
            "latest_feature_date": route_result["forecasts"][0].get("feature_source_date"),
            "risk_reliability": t("forecast.risk_reliability"),
            "recommended_vessel_reason": recommended_vessel_reason,
            "port_data_warning": build_port_data_warning() if (origin_port_info or {}).get("data_status") or (dest_port_info or {}).get("data_status") else None,
            "estimated_transit_days": transit_days,
            "transit_distance_source": transit_source,
            "transit_note": transit_note,
            "stowage_factor_cbm_per_ton": stowage_factor_value,
            "stowage_note": stowage_note,
        }

    def compare_origins(self, req):
        """Rank every known loading port for the same cargo/destination/date.

        HISTORY: this used to share ONE destination-only BDRY forecast
        across every origin, because the old BDRY pipeline's rate/risk
        model was destination+commodity driven and origin-invariant by
        construction. Route-freight forecasts are genuinely per-lane
        (origin AND destination), so that sharing no longer applies — each
        origin now gets its own route-freight prediction, and an origin
        with no route-freight coverage for this destination/commodity
        simply shows up in `errors` instead of a fabricated shared rate.
        """
        from app.schemas import ForecastRequest
        import concurrent.futures
        origins = self.meta.get("origins", [])

        def build_row(origin):
            try:
                single = ForecastRequest(
                    origin_port=origin,
                    destination_port=req.destination_port,
                    commodity=req.commodity,
                    shipment_date=req.shipment_date,
                    cargo_weight_tons=req.cargo_weight_tons,
                    vessel_type=req.vessel_type,
                    contract_duration_months=req.contract_duration_months,
                    total_program_tons=req.total_program_tons,
                )
                pred = self.predict(single)
            except Exception as exc:
                return ("error", {"origin_port": origin, "error": str(exc)})

            origin_info = port_utils.get_port(origin)
            if origin_info is None:
                return ("error", {"origin_port": origin, "error": t("compare.no_port_data")})
            origin_port_ok = None
            if pred.get("recommended_vessel_type"):
                origin_port_ok = port_utils.vessel_fits_port(pred["recommended_vessel_type"], origin_info)
            distance_nm = port_utils.get_distance_nm(origin, req.destination_port)
            transit_days = port_utils.estimate_transit_days(origin, req.destination_port)
            total_voyage_days = (
                round(transit_days + pred["port_turnaround_days"], 1) if transit_days is not None else None
            )

            ais_congestion = {
                "available": False, "congestion_index": None, "unique_vessels": None,
                "avg_sog_kn": None, "lookback_hours": None, "source": None,
            }
            if ais_collector is not None and ais_collector.enabled:
                try:
                    o = ais_collector.port_congestion(origin, lookback_hours=24)
                    ais_congestion = {
                        "available": True, "congestion_index": o["congestion_index"],
                        "unique_vessels": o["unique_vessels"], "avg_sog_kn": o["avg_sog_kn"],
                        "lookback_hours": 24, "source": t("compare.ais_source"),
                    }
                except Exception:
                    pass

            return ("ok", {
                "origin_port": origin,
                "origin_country": (origin_info or {}).get("country"),
                "predicted_freight_rate_usd_per_ton": pred["predicted_freight_rate_usd_per_ton"],
                "risk_label": pred["risk_label"],
                "recommended_vessel_type": pred["recommended_vessel_type"],
                "origin_port_vessel_ok": origin_port_ok,
                "origin_port_congestion": (origin_info or {}).get("typical_congestion"),
                "origin_port_congestion_source": t("compare.congestion_source_static"),
                "ais_congestion": ais_congestion,
                "distance_nm": distance_nm,
                "estimated_transit_days": transit_days,
                "port_turnaround_days": pred["port_turnaround_days"],
                "total_voyage_days": total_voyage_days,
                # `feasible` reflects full both-port vessel feasibility (origin
                # AND destination), taken from predict()'s vessel_status — not
                # just whether the recommended vessel fits the origin port.
                # An origin whose port can handle the recommended vessel but
                # whose destination can't (vessel_status == NO_FEASIBLE_VESSEL)
                # is correctly reported as infeasible here, so it sorts and
                # displays as infeasible instead of only being caught
                # downstream via vessel_status/feasible_vessel_types.
                "feasible": pred.get("vessel_status") != "NO_FEASIBLE_VESSEL",
                "vessel_status": pred.get("vessel_status"),
                "feasible_vessel_types": pred.get("feasible_vessel_types", []),
            })

        results, errors = [], []
        # One worker per origin (not capped at 6): origins is the small,
        # fixed port list from metadata.json (currently 11), each doing
        # mostly I/O-bound work per candidate (a lane joblib.load on a cache
        # miss, an optional live AIS lookup) plus a single sklearn .predict()
        # call. Capping this below the origin count serialized part of the
        # fan-out for no memory/CPU benefit at this list size; now that
        # _LaneStore.get_lane() no longer holds its lock across the disk
        # read (see route_freight_model.py), letting every origin's thread
        # run at once is what actually lets those loads happen in parallel.
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(origins) or 1) as pool:
            for kind, row in pool.map(build_row, origins):
                (results if kind == "ok" else errors).append(row)

        # Ranked feasible-first, then by ascending total voyage days, then by
        # ascending freight rate. Congestion (origin_port_congestion /
        # ais_congestion) is returned on every row and shown in the UI, but
        # it is a displayed signal, not a ranking key — it doesn't affect
        # sort order.
        results.sort(key=lambda r: (
            0 if r["feasible"] else 1,
            r["total_voyage_days"] if r["total_voyage_days"] is not None else float("inf"),
            r["predicted_freight_rate_usd_per_ton"],
        ))
        for i, r in enumerate(results):
            r["rank"] = i + 1

        return {
            "destination_port": req.destination_port,
            "commodity": req.commodity,
            "note": build_compare_note(),
            "results": results,
            "errors": errors,
        }

    def idle_alternatives(self, req):
        """Rank next-best loading ports for an idle vessel.

        HISTORY: this used to batch a BDRY forecast + risk-classifier call
        across commodities, then optionally overlay a route-freight number
        when the held-out guardrail passed. The BDRY batch is gone — every
        candidate's rate now comes directly from route_freight.predict();
        candidates with no route-freight coverage for that lane/commodity
        are skipped and reported in `errors` instead of falling back.

        Each (origin, commodity) pair is its own lane and used to run
        sequentially — up to ~11 origins x ~3 commodities, each doing a
        per-lane joblib.load() on a cache miss plus a sklearn .predict()
        call (see route_freight_model._LaneStore.get_lane()), one after
        another. That's the same "N independent lane loads/predicts"
        shape compare_origins() already parallelizes across origins with a
        thread pool, just with an extra commodity dimension here, so it
        gets the same fix: fan the (origin, commodity) pairs out across
        threads instead of looping over them in series.
        """
        import concurrent.futures

        origins = [
            origin for origin in self.meta.get("origins", [])
            if str(origin).strip().lower() != str(req.current_port).strip().lower()
        ]
        commodities = [req.commodity] if req.commodity else self.meta.get("commodities", [])
        cargo_weight = req.cargo_weight_tons or 50000.0
        vessel_type = req.vessel_type
        shipment_date = date.today()

        dest_info = port_utils.get_port(req.current_port)

        jobs = []
        for origin in origins:
            origin_info = port_utils.get_port(origin)
            if origin_info is None:
                continue
            if vessel_type and not port_utils.vessel_fits_port(vessel_type, origin_info):
                continue
            distance_nm = port_utils.get_distance_nm(origin, req.current_port)
            ballast_days = port_utils.estimate_transit_days(origin, req.current_port)
            # feasible_vessels_both_ports() depends only on cargo_weight,
            # origin_info and dest_info — none of which vary by commodity —
            # so it's computed once per origin here instead of once per
            # (origin, commodity) task below (previously re-run identically
            # for every commodity of the same origin).
            try:
                feasible_candidates, _rejected = port_utils.feasible_vessels_both_ports(cargo_weight, origin_info, dest_info)
            except Exception:
                feasible_candidates = []
            jobs.append((origin, origin_info, distance_nm, ballast_days, feasible_candidates))

        tasks = [
            (origin, origin_info, distance_nm, ballast_days, feasible_candidates, commodity)
            for origin, origin_info, distance_nm, ballast_days, feasible_candidates in jobs
            for commodity in commodities
        ]

        def build_candidate(task):
            origin, origin_info, distance_nm, ballast_days, feasible_candidates, commodity = task
            try:
                core = self._route_forecast(origin, req.current_port, commodity, shipment_date)
            except ValueError as exc:
                return ("error", {"origin_port": origin, "commodity": commodity, "error": str(exc)})

            rate = core["forecast"]
            risk = core["risk"]

            recommended_vessel = None
            if feasible_candidates:
                try:
                    recommendation = port_utils.recommend_vessel(
                        cargo_weight,
                        ((dest_info or {}).get("cargo_depth_m") or (dest_info or {}).get("channel_depth_m") or (dest_info or {}).get("max_draft_m")),
                        port_name=req.current_port, origin_port_name=origin,
                        predicted_rate=rate, previous_rate=core["prev"],
                    )
                    recommended_vessel = recommendation.get("recommended_vessel")
                except Exception:
                    recommended_vessel = None

            score = rate / (1 + (ballast_days or 0) / 30.0)
            return ("ok", {
                "origin_port": origin,
                "commodity": commodity,
                "predicted_freight_rate_usd_per_ton": round(float(rate), 2),
                "risk_label": risk,
                "recommended_vessel_type": recommended_vessel or vessel_type,
                "ballast_distance_nm": distance_nm,
                "estimated_ballast_days": ballast_days,
                "score": round(float(score), 3),
                "note": build_idle_reposition_note(origin=origin, commodity=commodity, current_port=req.current_port),
            })

        candidates = []
        errors = []
        if tasks:
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as pool:
                for kind, row in pool.map(build_candidate, tasks):
                    (candidates if kind == "ok" else errors).append(row)

        candidates.sort(key=lambda c: c["score"], reverse=True)
        top = candidates[:5]
        for i, candidate in enumerate(top):
            candidate["rank"] = i + 1

        return {
            "current_port": req.current_port,
            "vessel_type": vessel_type,
            "alternatives": top,
            "note": build_idle_note(),
            "errors": errors,
        }

    def route_freight_history_12m(self):
        """Trailing-12-month average route-freight rate, aggregated across
        every route in the currently-loaded dataset. Replaces the old
        dashboard `bdry_history_12m` series (BDRY ETF close price), which
        was a market index, not a freight rate at all.
        """
        if self.route_freight is None or self.route_freight.data.empty:
            return []
        df = self.route_freight.data.copy()
        df["observation_date"] = pd.to_datetime(df["observation_date"])
        df["month"] = df["observation_date"].values.astype("datetime64[M]")
        monthly = df.groupby("month")["freight_usd_per_t"].mean().sort_index()
        monthly = monthly.tail(12)
        return [
            {"month": pd.Timestamp(m).strftime("%Y-%m"), "value": round(float(v), 2)}
            for m, v in monthly.items()
        ]

    def _port_info(self, name):
        info = port_utils.get_port(name)
        if not info:
            return {"name": name, "known": False}
        return {
            "name": name, "known": True,
            "max_loa_m": info.get("max_loa_m"),
            "max_beam_m": info.get("max_beam_m"),
            "max_draft_m": info.get("max_draft_m"),
            "cargo_handling_rate_tpd": info.get("cargo_handling_rate_tpd"),
            "typical_congestion": info.get("typical_congestion"),
            "notes": info.get("notes"),
            "data_status": info.get("data_status"),
            "source_note": info.get("source_note"),
        }
