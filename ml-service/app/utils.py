import copy
import json
import os
import threading
import time
from datetime import date
from pathlib import Path
import pandas as pd
from app import port_utils
from app import brent
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

        # PERF: short-lived memo caches (see _route_forecast, compare_origins,
        # idle_alternatives). Everything here is recomputable, so a stale or
        # missing entry only ever costs time, never correctness.
        self._cache_lock = threading.Lock()
        self._forecast_cache: dict = {}
        self._decision_cache: dict = {}

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
    # A lane's forecast only depends on (lane, commodity, calendar month of
    # the shipment date) plus the live Brent signal inside the risk score, so
    # it is safe to reuse for a few minutes. compare-origins, idle-alternatives,
    # the decision simulator and the what-if sliders all re-request the same
    # lanes over and over; before this every one of those paid a lane-model
    # disk load + ~150-tree ensemble evaluation again.
    FORECAST_CACHE_TTL_S = 600
    FORECAST_CACHE_MAX = 4096
    DECISION_CACHE_TTL_S = 120
    DECISION_CACHE_MAX = 256

    @staticmethod
    def _month_key(shipment_date):
        try:
            ts = pd.Timestamp(shipment_date)
            return (ts.year, ts.month)
        except Exception:
            return str(shipment_date)

    def _route_forecast(self, origin_port, destination_port, commodity, shipment_date):
        key = (
            id(self.route_freight),
            str(origin_port).strip().lower(),
            str(destination_port).strip().lower(),
            str(commodity or "").strip().lower().replace(" ", "_").replace("&", "and"),
            self._month_key(shipment_date),
        )
        now = time.monotonic()
        with self._cache_lock:
            hit = self._forecast_cache.get(key)
        if hit is not None and now - hit[0] < self.FORECAST_CACHE_TTL_S:
            return dict(hit[1])
        core = self._route_forecast_uncached(origin_port, destination_port, commodity, shipment_date)
        with self._cache_lock:
            if len(self._forecast_cache) >= self.FORECAST_CACHE_MAX:
                self._forecast_cache.clear()
            self._forecast_cache[key] = (now, core)
        return dict(core)

    def _decision_cached(self, name, key_parts, compute):
        """TTL memo for whole compare-origins / idle-alternatives answers.
        Errors are never cached (compute() raising just propagates)."""
        key = (name, id(self.route_freight), key_parts)
        now = time.monotonic()
        with self._cache_lock:
            hit = self._decision_cache.get(key)
        if hit is not None and now - hit[0] < self.DECISION_CACHE_TTL_S:
            return copy.deepcopy(hit[1])
        result = compute()
        with self._cache_lock:
            if len(self._decision_cache) >= self.DECISION_CACHE_MAX:
                self._decision_cache.clear()
            self._decision_cache[key] = (now, result)
        return copy.deepcopy(result)

    def prefill_forecasts(self, months_ahead=1, pause_s=0.02):
        """Warm the forecast memo for every covered lane (current month, plus
        `months_ahead` more), one lane at a time so the lane LRU never holds
        more than it does today. Run from a background thread at startup so a
        user's first compare-origins / idle-vessel request is a dictionary
        lookup instead of ~30 lane-model loads. Best effort: any lane that
        fails is simply skipped and computed lazily when asked for."""
        rf = self.route_freight
        if rf is None or rf.data.empty or not rf.models.get(1):
            return 0
        today = date.today()
        months = []
        y, m = today.year, today.month
        for _ in range(months_ahead + 1):
            months.append(date(y, m, 1))
            m += 1
            if m > 12:
                y, m = y + 1, 1
        done = 0
        for lane in list(rf.models[1]):
            try:
                origin, destination, _rid = lane.split("|", 2)
                commodity = str(rf._key_first_row.loc[lane, "commodity"])
            except Exception:
                continue
            for when in months:
                try:
                    self._route_forecast(origin, destination, commodity, when)
                    done += 1
                except Exception:
                    pass
            time.sleep(pause_s)
        return done

    def _route_forecast_uncached(self, origin_port, destination_port, commodity, shipment_date):
        route_result = self.route_freight.predict(
            origin_port, destination_port, shipment_date, commodity=commodity
        ) if self.route_freight is not None else None

        if route_result is None or not route_result.get("forecasts") or route_result.get("model_beats_baseline") is not True:
            raise ValueError(
                f"No synthetic route-freight forecast is available for {origin_port} -> {destination_port}"
                + (f" ({commodity})" if commodity else "")
                + ". This lane is not covered by the route-freight dataset, or its held-out "
                "evaluation did not beat the naive-persistence baseline."
            )

        route_h1 = route_result["forecasts"][0]
        prev = float(route_result["last_available_freight_usd_per_ton"])
        forecast = float(route_h1["predicted_rate_usd_per_ton"])
        pct = (forecast - prev) / prev if prev else 0.0

        forecast_type = "synthetic_route" if route_result.get("data_mode") == "synthetic_mvp" else "route_specific"
        forecast_basis = "Synthetic route freight rate (MVP)" if forecast_type == "synthetic_route" else "Verified route freight"
        forecast_source = (
            "route_freight_observations.csv (synthetic MVP development dataset)"
            if forecast_type == "synthetic_route"
            else "Verified route freight observations"
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
            origin_name=req.origin_port,
            destination_name=req.destination_port,
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
            "risk_reliability": "heuristic (rule-based, not a trained classifier) — see risk_factors",
            "recommended_vessel_reason": recommended_vessel_reason,
            "port_data_warning": build_port_data_warning() if (origin_port_info or {}).get("data_status") or (dest_port_info or {}).get("data_status") else None,
            "estimated_transit_days": transit_days,
            "transit_distance_source": transit_source,
            "transit_note": transit_note,
            "stowage_factor_cbm_per_ton": stowage_factor_value,
            "stowage_note": stowage_note,
        }

    # ------------------------------------------------------------------
    # Port Substitution Engine (see app/port_substitution.py for the rules)
    # ------------------------------------------------------------------
    @staticmethod
    def _norm_port_name(name):
        import re
        return re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).strip()

    def _known_destinations(self):
        names = list(self.meta.get("destinations", []) or [])
        try:
            from app.ais_stream import DESTINATIONS as _AIS_DESTINATIONS
            for n in _AIS_DESTINATIONS:
                if n not in names:
                    names.append(n)
        except Exception:
            pass
        return names

    def _canonical_destination(self, name):
        """'Vizag' / 'sagar-sandheads' / 'PARADIP' -> the canonical port name."""
        want = self._norm_port_name(name)
        for cand in self._known_destinations():
            info = port_utils.get_port(cand) or {}
            if want in (self._norm_port_name(cand), self._norm_port_name(info.get("alias"))):
                return cand
        return str(name).strip()

    @staticmethod
    def _classes_fitting(cargo, port_info, port_name, origin_info=None, origin_name=None):
        """Vessel classes (smallest first) that can carry `cargo` and pass the
        port checks at the discharge port (and the loading port, if known).
        Returns (feasible_entries, rejected_entries_with_reason)."""
        rows = sorted(
            (r for _, r in port_utils.VESSEL_SPECS.iterrows()),
            key=lambda r: float(r["typical_dwt"]),
        )
        feasible, rejected = [], []
        for row in rows:
            entry = {
                "vessel_class": row["vessel_class"],
                "typical_dwt": float(row["typical_dwt"]),
                "typical_draft": float(row["typical_draft"]) if pd.notna(row["typical_draft"]) else None,
                "typical_length": float(row["typical_length"]) if pd.notna(row["typical_length"]) else None,
                "typical_beam": float(row["typical_beam"]) if pd.notna(row["typical_beam"]) else None,
            }
            if entry["typical_dwt"] < float(cargo):
                rejected.append({**entry, "rejection_reason": (
                    f"Cargo exceeds recommended capacity: {float(cargo):,.0f} t requested vs. "
                    f"{entry['vessel_class']}'s typical DWT of {entry['typical_dwt']:,.0f} t."), "cargo_ok": False})
                continue
            if origin_info is not None:
                ok, reason = port_utils.check_vessel_port_compatibility(
                    entry["vessel_class"], origin_info, label="origin port", port_name=origin_name)
                if not ok:
                    rejected.append({**entry, "rejection_reason": reason, "cargo_ok": True})
                    continue
            ok, reason = port_utils.check_vessel_port_compatibility(
                entry["vessel_class"], port_info, label="destination port", port_name=port_name)
            if not ok:
                rejected.append({**entry, "rejection_reason": reason, "cargo_ok": True})
                continue
            feasible.append(entry)
        return feasible, rejected

    def port_substitution(self, req):
        key_parts = (
            tuple(self.meta.get("destinations", [])), str(req.failed_port), float(req.cargo_weight_tons),
            str(req.commodity or ""), str(req.origin_port or ""), str(req.shipment_date or date.today()),
            str(req.vessel_type or ""), float(req.max_distance_nm), bool(req.use_live_ais),
        )
        return self._decision_cached("substitute", key_parts, lambda: self._port_substitution_impl(req))

    def _port_substitution_impl(self, req):
        import concurrent.futures
        from app import port_substitution as ps
        try:
            from app.ais_stream import PORT_COORDS as coords
        except Exception:
            coords = {}

        failed = self._canonical_destination(req.failed_port)
        failed_info = port_utils.get_port(failed)
        if failed_info is None and failed not in coords:
            raise ValueError(f"Unknown port '{req.failed_port}': no infrastructure or coordinate data on file.")
        cargo = float(req.cargo_weight_tons)
        when = req.shipment_date or date.today()
        commodity = (req.commodity or "").strip() or None
        origin = self._canonical_origin(req.origin_port) if req.origin_port else None
        origin_info = port_utils.get_port(origin) if origin else None
        notes = []
        if origin and origin_info is None:
            notes.append(f"No port data for loading port {origin}; the loading-port vessel check was skipped.")

        # Live AIS radar, best effort (one cached call covers every port).
        radar_by_port = {}
        live_ais = False
        if req.use_live_ais and ais_collector is not None and getattr(ais_collector, "enabled", False):
            try:
                for item in ais_collector.port_radar_all().get("ports", []):
                    radar_by_port[item["port"]] = item
                live_ais = any(v.get("status") in ("NORMAL", "WATCH", "ELEVATED", "CRITICAL") for v in radar_by_port.values())
            except Exception:
                radar_by_port = {}

        def lane(dest):
            if not (origin and commodity):
                return None
            try:
                core = self._route_forecast(origin, dest, commodity, when)
                return {"rate": float(core["forecast"]), "risk": core.get("risk")}
            except Exception:
                return None

        # ---- baseline: the failed port itself -------------------------------
        f_feasible, _ = (self._classes_fitting(cargo, failed_info, failed, origin_info, origin)
                         if failed_info else ([], []))
        planned = req.vessel_type or (f_feasible[0]["vessel_class"] if f_feasible else None)
        f_rate_tpd = (failed_info or {}).get("cargo_handling_rate_tpd") or 8000
        base_discharge = round(cargo / f_rate_tpd, 2)
        base_transit = port_utils.estimate_transit_days(origin, failed) if origin else None

        candidates = [c for c in self._known_destinations() if c != failed]
        f_coord = coords.get(failed)
        if f_coord:
            candidates = [c for c in candidates
                          if coords.get(c) is None or (ps.haversine_nm(f_coord, coords[c]) or 0) <= req.max_distance_nm]

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(candidates) or 1, 8)) as pool:
            lanes = dict(zip(candidates, pool.map(lane, candidates)))
        base_lane = lane(failed)

        options = []
        for cand in candidates:
            info = port_utils.get_port(cand)
            feasible, rejected = self._classes_fitting(cargo, info, cand, origin_info, origin)
            classes = [v["vessel_class"] for v in feasible]
            chosen = None
            if feasible:
                chosen = next((v for v in feasible if v["vessel_class"] == planned), None) or feasible[0]
            margin, draft_m, loa_m = ps.vessel_margin_ratio(chosen, info)
            reason = None
            if not feasible:
                cargo_ok = [r for r in rejected if r.get("cargo_ok")]
                reason = (cargo_ok[0] if cargo_ok else (rejected[-1] if rejected else {})).get("rejection_reason")
                if cargo_ok and str(reason).startswith("Origin port"):
                    # The LOADING port is what blocks it, not this candidate.
                    reason = f"Blocked by the loading port, not by {cand}. {reason}"
                elif cargo_ok:
                    reason = f"No vessel class that can carry {cargo:,.0f} t fits {cand}. {reason}"

            cand_coord = coords.get(cand)
            dist_failed = ps.haversine_nm(f_coord, cand_coord)
            sea_nm = port_utils.get_distance_nm(origin, cand) if origin else None
            transit = port_utils.estimate_transit_days(origin, cand) if origin else None
            rate_tpd = (info or {}).get("cargo_handling_rate_tpd") or 8000
            discharge = round(cargo / rate_tpd, 2) if info else None
            extra_transit = round(transit - base_transit, 1) if transit is not None and base_transit is not None else None
            extra_handling = round(discharge - base_discharge, 2) if discharge is not None else None

            cong = ps.congestion_assumption(radar_by_port.get(cand), (info or {}).get("typical_congestion"))
            cl = lanes.get(cand)
            fr = {"rate_usd_per_ton": None, "delta_usd_per_ton": None, "total_impact_usd": None,
                  "risk": None, "source": None}
            if cl is not None:
                fr.update(rate_usd_per_ton=round(cl["rate"], 2), risk=cl["risk"], source="route_freight_model")
                if base_lane is not None:
                    d = round(cl["rate"] - base_lane["rate"], 2)
                    fr.update(delta_usd_per_ton=d, total_impact_usd=round(d * cargo, 0))

            options.append({
                "port": cand,
                "country": (info or {}).get("country"),
                "lat": cand_coord[0] if cand_coord else None,
                "lon": cand_coord[1] if cand_coord else None,
                "feasible": bool(feasible),
                "vessel": {
                    "class": chosen["vessel_class"] if chosen else None,
                    "feasible_classes": classes,
                    "planned_vessel": planned,
                    "keeps_planned_vessel": bool(planned and planned in classes),
                    "draft_margin_m": draft_m, "loa_margin_m": loa_m, "margin_ratio": margin,
                    "port_max_draft_m": (info or {}).get("max_draft_m"),
                    "port_max_loa_m": (info or {}).get("max_loa_m"),
                    "rejection_reason": reason,
                },
                "freight": fr,
                "congestion": cong,
                "delay": {
                    "extra_transit_days": extra_transit,
                    "extra_handling_days": extra_handling,
                    "congestion_days": cong["delay_days"],
                    "total_days": round(
                        max(extra_transit or 0.0, 0.0) + max(extra_handling or 0.0, 0.0) + cong["delay_days"], 1),
                },
                "handling": {
                    "rate_tpd": (info or {}).get("cargo_handling_rate_tpd"),
                    "berths": (info or {}).get("berths"),
                    "discharge_days": discharge,
                },
                "distance": {"from_failed_nm": dist_failed, "sea_nm_from_origin": sea_nm},
                "data_status": (info or {}).get("data_status"),
            })

        ordered = ps.rank_options(options)
        origin_blocked = bool(ordered) and not any(o["feasible"] for o in ordered) and all(
            str(o["vessel"].get("rejection_reason") or "").startswith("Blocked by the loading port") for o in ordered
            if o["vessel"].get("rejection_reason"))
        if origin_blocked:
            notes.append(f"Loading port {origin} cannot handle any vessel that can carry this cargo, "
                         "so no discharge port can work. Change the loading port, vessel or parcel size.")
        f_cong = ps.congestion_assumption(radar_by_port.get(failed), (failed_info or {}).get("typical_congestion"))
        if not (origin and commodity):
            notes.append("Give a loading port and commodity to include freight-rate impact and sailing-time change.")
        elif base_lane is None:
            notes.append(f"No route-freight forecast for {origin} \u2192 {failed}; freight impact is not shown.")
        return {
            "failed_port": failed,
            "failed_port_info": {
                "country": (failed_info or {}).get("country"),
                "lat": f_coord[0] if f_coord else None, "lon": f_coord[1] if f_coord else None,
                "congestion": f_cong,
                "max_draft_m": (failed_info or {}).get("max_draft_m"),
            },
            "cargo_weight_tons": cargo,
            "commodity": commodity,
            "origin_port": origin,
            "shipment_date": str(when),
            "planned_vessel": planned,
            "baseline": {
                "rate_usd_per_ton": round(base_lane["rate"], 2) if base_lane else None,
                "transit_days": base_transit, "discharge_days": base_discharge,
            },
            "live_ais_used": live_ais,
            "options": ordered,
            "recommendation": (
                f"No substitute port can help: the loading port {origin} cannot handle any vessel that can carry "
                f"{cargo:,.0f} t. Change the loading port, vessel or parcel size first."
                if origin_blocked else ps.build_recommendation(failed, ordered)),
            "map": ps.build_map({"port": failed, "lat": f_coord[0] if f_coord else None,
                                 "lon": f_coord[1] if f_coord else None}, ordered),
            "weights": ps.DEFAULT_WEIGHTS,
            "assumptions": ps.ASSUMPTIONS,
            "notes": notes,
        }

    def _canonical_origin(self, name):
        want = self._norm_port_name(name)
        for cand in self.meta.get("origins", []) or []:
            if want == self._norm_port_name(cand):
                return cand
        return str(name).strip()

    # ------------------------------------------------------------------
    # Disruption Engine (Step 2): wires app/disruption_engine.py into the
    # route forecast (freight impact on the affected lane) and, when the
    # disrupted port is a discharge port, the Port Substitution Engine
    # (ranked alternatives). See app/disruption_engine.py's docstring for
    # what the impact numbers do and do not represent.
    # ------------------------------------------------------------------
    def _is_known_destination(self, name):
        want = self._norm_port_name(name)
        for cand in self._known_destinations():
            info = port_utils.get_port(cand) or {}
            if want in (self._norm_port_name(cand), self._norm_port_name(info.get("alias"))):
                return True
        return False

    def _is_known_origin(self, name):
        want = self._norm_port_name(name)
        return any(self._norm_port_name(cand) == want for cand in (self.meta.get("origins") or []))

    def _port_role(self, name):
        """(canonical_name, role) where role is 'destination', 'origin', or
        'unknown'. Membership in the project's own origin/destination lists
        decides the role — NOT merely whether the port has infrastructure
        data on file, since a loading port like Newcastle also has a
        PORT_INFRA record and would otherwise be misread as a destination."""
        if self._is_known_destination(name):
            return self._canonical_destination(name), "destination"
        if self._is_known_origin(name):
            return self._canonical_origin(name), "origin"
        return str(name).strip(), "unknown"

    def simulate_disruption(self, req):
        key_parts = (
            str(req.event_type), str(req.port), float(req.severity), req.duration_days,
            str(req.origin_port or ""), str(req.destination_port or ""), str(req.commodity or ""),
            str(req.shipment_date or date.today()), float(req.cargo_weight_tons),
            req.stockpile_buffer_days, bool(req.include_alternatives),
            tuple(self.meta.get("destinations", [])), tuple(self.meta.get("origins", [])),
        )
        return self._decision_cached("disruption", key_parts, lambda: self._simulate_disruption_impl(req))

    def _simulate_disruption_impl(self, req):
        from app import disruption_engine as de

        if req.event_type not in de.EVENT_PROFILES:
            raise ValueError(
                f"Unknown event type '{req.event_type}'. Known types: "
                f"{', '.join(sorted(de.EVENT_PROFILES))}."
            )
        port, role = self._port_role(req.port)
        port_info = port_utils.get_port(port)
        if port_info is None:
            raise ValueError(f"Unknown port '{req.port}': no infrastructure data on file.")

        return self._build_disruption_response(
            event_type=req.event_type, port=port, role=role, port_info=port_info,
            severity_fraction=float(req.severity) / 100.0, source="simulated",
            duration_days=req.duration_days, stockpile_buffer_days=req.stockpile_buffer_days,
            origin_port_raw=req.origin_port, destination_port_raw=req.destination_port,
            commodity_raw=req.commodity, shipment_date=req.shipment_date,
            cargo_weight_tons=req.cargo_weight_tons, include_alternatives=req.include_alternatives,
        )

    # ---- Live mode (Step 4): same engine, severity from marine_weather.py --
    def live_disruption(self, req):
        key_parts = (
            str(req.port), req.duration_days, str(req.origin_port or ""), str(req.destination_port or ""),
            str(req.commodity or ""), str(req.shipment_date or date.today()), float(req.cargo_weight_tons),
            req.stockpile_buffer_days, bool(req.include_alternatives),
            tuple(self.meta.get("destinations", [])), tuple(self.meta.get("origins", [])),
            # Short TTL cache key includes a 5-minute time bucket so a stale
            # marine reading isn't served forever, without hammering the
            # weather API on every page view either.
            int(time.time() // 300),
        )
        return self._decision_cached("live_disruption", key_parts, lambda: self._live_disruption_impl(req))

    def _live_disruption_impl(self, req):
        from app import disruption_engine as de
        from app import marine_weather as mw
        try:
            from app.ais_stream import PORT_COORDS as coords
        except Exception:
            coords = {}

        port, role = self._port_role(req.port)
        port_info = port_utils.get_port(port)
        if port_info is None:
            raise ValueError(f"Unknown port '{req.port}': no infrastructure data on file.")
        coord = coords.get(port)
        if coord is None:
            raise ValueError(f"No coordinates on file for '{port}'; live conditions cannot be fetched for it.")

        live = mw.get_live_assessment(coord[0], coord[1])
        if live["severity"] is None:
            raise ValueError(
                f"Live marine conditions are currently unavailable for {port} "
                f"({live['conditions'].get('error') or 'no data returned'}). Try again shortly, or use Simulate mode."
            )

        response = self._build_disruption_response(
            event_type="extreme_weather", port=port, role=role, port_info=port_info,
            severity_fraction=live["severity"], source="live",
            duration_days=req.duration_days, stockpile_buffer_days=req.stockpile_buffer_days,
            origin_port_raw=req.origin_port, destination_port_raw=req.destination_port,
            commodity_raw=req.commodity, shipment_date=req.shipment_date,
            cargo_weight_tons=req.cargo_weight_tons, include_alternatives=req.include_alternatives,
        )
        response["live_conditions"] = live
        return response

    def _build_disruption_response(
        self, *, event_type, port, role, port_info, severity_fraction, source,
        duration_days, stockpile_buffer_days, origin_port_raw, destination_port_raw,
        commodity_raw, shipment_date, cargo_weight_tons, include_alternatives,
    ):
        """Shared tail of both the Simulate and Live disruption paths: run the
        impact model, price the lane if one is given, and (for a discharge
        port) compare waiting it out against the best alternative port. Only
        the severity value and its `source` label differ between the two
        callers — see app/disruption_engine.py's module docstring."""
        from app import disruption_engine as de

        result = de.assess_disruption(
            event_type, port, severity_fraction, port_info, source=source,
            duration_days=duration_days, stockpile_buffer_days=stockpile_buffer_days,
        )

        # Default the missing end of the lane to the disrupted port itself,
        # so "a cyclone at Paradip" alone is enough to price the Paradip leg
        # once a commodity is picked, without re-typing the port just chosen.
        origin = self._canonical_origin(origin_port_raw) if origin_port_raw else (port if role == "origin" else None)
        destination = self._canonical_destination(destination_port_raw) if destination_port_raw else (port if role == "destination" else None)
        commodity = (commodity_raw or "").strip() or None

        lane = None
        notes = []
        if origin and destination and commodity:
            when = shipment_date or date.today()
            try:
                base = self._route_forecast(origin, destination, commodity, when)
                base_rate = float(base["forecast"])
                pressure = result["freight_pressure_pct"]
                adjusted_rate = round(base_rate * (1.0 + pressure), 2)
                delta = round(adjusted_rate - base_rate, 2)
                lane = {
                    "origin_port": origin, "destination_port": destination, "commodity": commodity,
                    "baseline_rate_usd_per_ton": round(base_rate, 2),
                    "adjusted_rate_usd_per_ton": adjusted_rate,
                    "freight_pressure_pct": pressure,
                    "delta_usd_per_ton": delta,
                    "total_impact_usd": round(delta * float(cargo_weight_tons), 0),
                    "note": (
                        "The disruption is applied as a flat freight-pressure uplift on top of the "
                        "model's own forecast for this lane; it does not re-run the forecast model itself."
                    ),
                }
            except Exception:
                notes.append(f"No route-freight forecast for {origin} \u2192 {destination}; freight impact is not shown.")
        elif not (origin and destination):
            notes.append(
                "Give both a loading and a discharge port (or leave one blank to default to the "
                f"disrupted port, {port}) plus a commodity to see freight-rate impact on a lane."
            )
        elif not commodity:
            notes.append("Give a commodity to see freight-rate impact on this lane.")

        alternatives = None
        decision = None
        if role == "destination" and include_alternatives:
            try:
                from app.schemas import PortSubstitutionRequest
                sub_req = PortSubstitutionRequest(
                    failed_port=port, cargo_weight_tons=cargo_weight_tons, commodity=commodity,
                    origin_port=origin, shipment_date=shipment_date, use_live_ais=False,
                )
                alternatives = self.port_substitution(sub_req)
                best = next((o for o in alternatives["options"] if o["feasible"]), None)
                wait_delta = lane["delta_usd_per_ton"] if lane else None
                alt_delta = best["freight"]["delta_usd_per_ton"] if best else None
                cargo = float(cargo_weight_tons)
                decision = {
                    "cargo_weight_tons": cargo,
                    "wait": {
                        "port": port,
                        "expected_delay_days": result["total_eta_impact_days"],
                        "freight_delta_usd_per_ton": wait_delta,
                        # Total $ exposure on this parcel if the plan stays as-is and the
                        # disruption's freight pressure holds — same calc as lane.total_impact_usd,
                        # duplicated here so a caller with only `decision` (no `lane`) still gets it.
                        "freight_impact_usd": (round(wait_delta * cargo, 0) if wait_delta is not None else None),
                    },
                    "alternative": ({
                        "port": best["port"],
                        "expected_delay_days": best["delay"]["total_days"],
                        "freight_delta_usd_per_ton": alt_delta,
                        "freight_impact_usd": (round(alt_delta * cargo, 0) if alt_delta is not None else None),
                        "distance_from_disrupted_port_nm": best["distance"]["from_failed_nm"],
                    } if best else None),
                }
            except Exception as exc:
                notes.append(f"Could not compute alternative discharge ports for this disruption: {exc}")
        elif role == "origin" and include_alternatives:
            notes.append(
                f"{port} is a loading port; to compare alternative loading ports for this lane, use "
                "compare-origins directly (its forecasts do not yet include this disruption's freight pressure)."
            )

        return {
            "port": port,
            "port_role": role,
            "disruption": result,
            "lane": lane,
            "alternatives": alternatives,
            "decision": decision,
            "notes": notes,
        }

    def compare_origins(self, req):
        key_parts = (
            tuple(self.meta.get("origins", [])),
            str(req.commodity), str(req.destination_port),
            str(req.shipment_date), float(req.cargo_weight_tons),
            getattr(req, "vessel_type", None), getattr(req, "contract_duration_months", None),
            getattr(req, "total_program_tons", None),
        )
        return self._decision_cached("compare", key_parts, lambda: self._compare_origins_impl(req))

    def _compare_origins_impl(self, req):
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
                return ("error", {"origin_port": origin, "error": "No port infrastructure data available for this origin."})
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
                        "lookback_hours": 24, "source": "AISStream live AIS feed (this origin only, last 24h)",
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
                "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
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
        # Each row is dominated by I/O (a lane model load on cache miss,
        # plus an optional AIS lookup) rather than CPU work, so it's worth
        # running every origin concurrently rather than throttling to a
        # small worker count sized for CPU-bound work.
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(origins) or 1, 8)) as pool:
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
        key_parts = (
            tuple(self.meta.get("origins", [])), tuple(self.meta.get("commodities", [])),
            str(req.current_port), getattr(req, "vessel_type", None),
            str(getattr(req, "commodity", None) or ""),
            getattr(req, "cargo_weight_tons", None), date.today().isoformat(),
        )
        return self._decision_cached("idle", key_parts, lambda: self._idle_alternatives_impl(req))

    def _idle_alternatives_impl(self, req):
        """Rank next-best loading ports for an idle vessel.

        HISTORY: this used to batch a BDRY forecast + risk-classifier call
        across commodities, then optionally overlay a route-freight number
        when the held-out guardrail passed. The BDRY batch is gone — every
        candidate's rate now comes directly from route_freight.predict();
        candidates with no route-freight coverage for that lane/commodity
        are skipped and reported in `errors` instead of falling back.
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
            jobs.append((origin, origin_info, distance_nm, ballast_days))

        # Flatten to one job per (origin, commodity) pair — up to 10 origins
        # x 3 commodities when no commodity filter is given — and run them
        # concurrently. This used to be a plain nested for-loop, so all ~30
        # combinations ran one at a time; that was the actual source of the
        # slowness (worse than compare-origins, which already parallelized
        # its equivalent fan-out). Safe to do here for the same reason it
        # was safe there: the per-lane model cache underneath _route_forecast
        # loads outside its lock now, so concurrent lookups for different
        # lanes genuinely run in parallel instead of queueing.
        def build_candidate(job):
            origin, origin_info, distance_nm, ballast_days, commodity = job
            try:
                core = self._route_forecast(origin, req.current_port, commodity, shipment_date)
            except ValueError as exc:
                return ("error", {"origin_port": origin, "commodity": commodity, "error": str(exc)})

            rate = core["forecast"]
            risk = core["risk"]

            recommended_vessel = None
            try:
                feasible_candidates, _rejected = port_utils.feasible_vessels_both_ports(cargo_weight, origin_info, dest_info, origin_name=origin, destination_name=req.current_port)
                if feasible_candidates:
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

        pairs = [
            (origin, origin_info, distance_nm, ballast_days, commodity)
            for origin, origin_info, distance_nm, ballast_days in jobs
            for commodity in commodities
        ]

        candidates = []
        errors = []
        if pairs:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(pairs), 8)) as pool:
                for kind, row in pool.map(build_candidate, pairs):
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
