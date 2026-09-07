import json
import os
from datetime import date
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from app import port_utils
from route_freight_model import RouteFreightModel
try:
    # Same optional-import pattern used in app/route_model.py: AIS is a
    # live, best-effort enhancement. If aisstream isn't configured/running
    # (no AISSTREAM_API_KEY, websocket-client missing, import error) the
    # rest of ModelBundle must keep working exactly as before.
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
)

MODELS_DIR = Path(__file__).resolve().parent / ".." / "models"

class ModelBundle:
    def __init__(self):
        with open(MODELS_DIR / "metadata.json") as f: self.meta=json.load(f)
        if self.meta.get("pipeline_version") != "real_monthly_v2":
            raise RuntimeError("Current model artifacts are not from the real monthly pipeline. Run python train.py after adding the seven real datasets.")
        self.reg=joblib.load(MODELS_DIR/"forecast_model.joblib")
        self.clf=joblib.load(MODELS_DIR/"risk_model.joblib")
        self.encoder=joblib.load(MODELS_DIR/"feature_encoder.joblib")
        # (Phase 4) Additional direct horizon models — H+2, H+3. Loaded
        # only if metadata says they were actually trained (older model
        # artifacts trained before this feature won't have them). Missing
        # an horizon file that metadata claims exists is a controlled
        # startup error, not a silent single-horizon fallback — a judge
        # asking for H+3 should get a real answer or an honest error, never
        # a relabeled H+1 number.
        self.horizon_models = {1: self.reg}
        # Route-level synthetic freight curve for the MVP. The model is
        # explicitly provenance-tagged and only used when no verified
        # production route observations exist. It does not replace the BDRY
        # risk model; it supplies the route-specific freight-rate level.
        try:
            self.route_freight = RouteFreightModel(MODELS_DIR, MODELS_DIR.parent / "data" / "production")
        except Exception:
            self.route_freight = None
        for h in self.meta.get("metrics", {}).get("horizons_available", [1]):
            if h == 1:
                continue
            path = MODELS_DIR / f"forecast_model_h{h}.joblib"
            if not path.exists():
                raise RuntimeError(
                    f"metadata.json declares horizon H+{h} available but {path.name} is missing. "
                    "Re-run train.py to regenerate all horizon models together."
                )
            self.horizon_models[h] = joblib.load(path)

    def _resolve_lookup(self, destination_port, commodity):
        """Deterministic fallback hierarchy for the destination+commodity
        market-feature lookup. Never falls back to an arbitrary/unrelated
        entry (no `next(iter(...))`) — every level is explicitly keyed to
        something the request actually asked for, and the level used is
        returned alongside the data so callers can be transparent about it.

        Note on scope: this pipeline's lookup table is keyed by
        destination+commodity only (see train.py) — it does not currently
        hold per-origin observations, so there is no "exact_route" (origin+
        destination+commodity) level to fall back from yet. That is a real
        limitation of the current data, not something this function should
        paper over; see README "Known limitations" for the honest statement.

        Levels, in order:
          1. destination_commodity — exact (destination, commodity) match.
          2. commodity             — average across all destinations for
                                      this commodity.
          3. global_proxy          — average across the entire lookup table.
        Raises RuntimeError if even the global proxy is unavailable (empty
        lookup table), rather than silently returning nothing.
        """
        table = self.meta["latest_lookup"]

        key = f"{destination_port}|{commodity}"
        exact = table.get(key)
        if exact is not None:
            return dict(exact), "destination_commodity"

        commodity_matches = [v for k, v in table.items() if k.endswith(f"|{commodity}")]
        if commodity_matches:
            averaged = {
                feat: float(np.mean([v[feat] for v in commodity_matches]))
                for feat in self.meta["numeric_features"]
            }
            return averaged, "commodity"

        if table:
            all_values = list(table.values())
            averaged = {
                feat: float(np.mean([v[feat] for v in all_values]))
                for feat in self.meta["numeric_features"]
            }
            return averaged, "global_proxy"

        raise RuntimeError(
            f"No trained market data available for destination='{destination_port}', "
            f"commodity='{commodity}', and no global proxy exists either (empty lookup table)."
        )

    def _feature_row(self, req):
        lookup, data_source_level = self._resolve_lookup(req.destination_port, req.commodity)
        values={k:lookup[k] for k in self.meta["numeric_features"]}
        values["month_num"]=req.shipment_date.month; values["quarter"]=(req.shipment_date.month-1)//3+1
        values["trade_signal_lag1"]=float(lookup.get("trade_signal_lag1", 0.0))
        values["trade_signal_yoy_growth"]=float(lookup.get("trade_signal_yoy_growth", 0.0))
        values["has_trade_signal"]=float(lookup.get("has_trade_signal", 0.0))
        # Request-specific physical/cargo fields remain decision-engine inputs; the rate model is trained on market/demand features.
        cat=self.encoder.transform(pd.DataFrame([[req.destination_port,req.commodity]],columns=self.meta["categorical_features"]))
        num=np.array([[values[n] for n in self.meta["numeric_features"]]],dtype=float)
        X=np.concatenate([num,cat],axis=1)
        return X, values, data_source_level, lookup

    def _local_drivers(self, values, top_n=3):
        """(3) Explainability — lightweight per-request 'top drivers'.

        Not SHAP: for each numeric feature we combine (a) the model's global
        importance for that feature with (b) how far this request's value
        sits from the training-set mean (z-score), and rank by the product.
        This is an honest proxy for "what's pushing this forecast away from
        the average case", not an exact per-prediction attribution.
        """
        stats = self.meta.get("numeric_feature_stats", {})
        importances = {d["feature"]: d["importance"] for d in self.meta.get("forecast_feature_importance", [])}
        scored = []
        for feat, val in values.items():
            st = stats.get(feat)
            if not st or not st.get("std"):
                continue
            z = (float(val) - st["mean"]) / st["std"]
            weight = importances.get(feat, 0.0)
            scored.append({
                "feature": feat,
                "value": round(float(val), 3),
                "typical_value": round(st["mean"], 3),
                "deviation_z": round(float(z), 2),
                "global_importance": round(weight, 4),
                "influence_score": round(abs(z) * weight, 4),
                "direction": "above typical" if z > 0 else "below typical",
            })
        scored.sort(key=lambda s: s["influence_score"], reverse=True)
        return scored[:top_n]

    def _forecast_curve(self, X, prev, shipment_date, data_source_level):
        """(Phase 4) Build the real multi-horizon forecast — one point per
        directly-trained horizon model (H+1, H+2, H+3, ...), using the SAME
        feature row X for every horizon (never a recursively-mutated
        month/quarter feature with everything else frozen — see train.py
        for why that anti-pattern is avoided).

        lower_bound/upper_bound: 10th/90th percentile of that horizon's 300
        individual trees' predictions for this exact input row — a
        standard non-parametric ensemble-uncertainty estimate, not a
        fabricated interval. confidence is 1 - (bound width / |level|),
        clamped to [0, 1]: a wide tree spread relative to the price level
        means the forest itself is unsure, and that shows up directly here.
        """
        curve = []
        for h in sorted(self.horizon_models.keys()):
            model_h = self.horizon_models[h]
            tree_preds = np.array([est.predict(X)[0] for est in model_h.estimators_])
            level_preds = prev + tree_preds
            point_delta = float(model_h.predict(X)[0])
            point_level = prev + point_delta
            lower = float(np.percentile(level_preds, 10))
            upper = float(np.percentile(level_preds, 90))
            width = max(upper - lower, 0.0)
            conf = 1.0 - (width / abs(point_level)) if point_level else 0.0
            conf = max(0.0, min(1.0, conf))
            target_date = shipment_date + pd.DateOffset(months=h)
            curve.append({
                "horizon": f"H+{h}",
                "date": target_date.strftime("%Y-%m-%d"),
                "predicted_rate": round(point_level, 2),
                "lower_bound": round(min(lower, upper), 2),
                "upper_bound": round(max(lower, upper), 2),
                "confidence": round(conf, 3),
            })
        return curve

    def _data_confidence(self, data_source_level, forecast_curve):
        """(Phase 2/3) high/medium/low, deterministic — never a guess.

        Starts from data_source_level (how directly this destination+
        commodity is represented in the training lookup — see
        _resolve_lookup) and is capped downward if the model's own
        ensemble uncertainty at H+1 is already wide, so a nominally
        'exact match' lookup feeding an uncertain model doesn't get
        reported as high confidence.
        """
        base = {"destination_commodity": "high", "commodity": "medium", "global_proxy": "low"}.get(data_source_level, "low")
        # A route-specific destination/commodity lookup does NOT mean an
        # observed route freight label exists. For the current BDRY-proxy
        # architecture, cap the data-confidence label at medium so the UI
        # cannot be read as claiming high-confidence route USD/t data.
        if base == "high":
            base = "medium"
        if forecast_curve:
            h1_conf = forecast_curve[0]["confidence"]
            if h1_conf < 0.5 and base == "high":
                base = "medium"
            if h1_conf < 0.25:
                base = "low"
        return base

    def predict(self, req):
        X,feature_values,data_source_level,lookup=self._feature_row(req)
        # (See train.py "target_transform" comment / metadata.json
        # target_transform for the full rationale.) The model was trained
        # to predict the CHANGE in BDRY relative to the most recently known
        # real value (bdry_lag1), not the absolute level — RandomForest
        # leaves cannot extrapolate beyond the level range seen during
        # training, which silently produced badly under-forecast levels on
        # a trending series. Reconstruct the level the same way training's
        # evaluation did, so every downstream field below stays in the same
        # USD-rate units the frontend/PDF/history already expect.
        prev=float(lookup["bdry_lag1"])
        predicted_delta=float(self.reg.predict(X)[0])
        forecast=prev+predicted_delta
        forecast_curve=self._forecast_curve(X, prev, req.shipment_date, data_source_level)
        data_confidence=self._data_confidence(data_source_level, forecast_curve)
        # This pipeline's only rate signal is BDRY (a global dry-bulk
        # market index), not a per-route freight observation — see
        # ml-service/data/README and metadata.json target_transform.
        # Stated plainly rather than left for the UI/PDF to guess at.
        forecast_type="market_proxy"
        forecast_basis="BDRY market proxy"
        forecast_source="BDRY historical market series; AIS/PortWatch operational features"
        training_data_mode=self.meta.get("data_source_mode", "unknown")
        route_freight_result = None
        if self.route_freight is not None:
            route_freight_result = self.route_freight.predict(
                req.origin_port, req.destination_port, req.shipment_date, commodity=req.commodity
            )
        # (Task 4) A route-specific model is only allowed to override the
        # BDRY market-proxy forecast if it actually beat naive persistence
        # on held-out data (see route_freight_model.py train()/predict()).
        # This is the exact guardrail for the disclosed finding that a
        # route model can score worse than "do nothing" (H+1 MAE 5.76 vs.
        # naive 3.46) — that result must never be silently served as if it
        # were the trustworthy forecast. Unknown (None, e.g. older metadata
        # without this field) is treated as NOT passing, not as a pass.
        route_model_beats_baseline = route_freight_result.get("model_beats_baseline") if route_freight_result else None
        use_route_freight = bool(route_freight_result and route_freight_result.get("forecasts"))
        route_model_fallback_note = None
        if use_route_freight and route_model_beats_baseline is not True:
            use_route_freight = False
            route_model_fallback_note = (
                f"Route-specific model for {req.origin_port}-{req.destination_port} did not "
                "beat the naive-persistence baseline on held-out data (or has no recorded "
                "baseline comparison); falling back to the BDRY market-proxy forecast for "
                "this request rather than serving an unverified route forecast."
            )
        if use_route_freight:
            # Use the synthetic route-rate forecast as the freight-rate target
            # while keeping the existing BDRY-based risk classifier intact.
            route_h1 = route_freight_result["forecasts"][0]
            prev = float(route_freight_result["last_available_freight_usd_per_ton"])
            forecast = float(route_h1["predicted_rate_usd_per_ton"])
            pct = (forecast - prev) / prev if prev else 0.0
            forecast_type = "synthetic_route" if route_freight_result.get("data_mode") == "synthetic_mvp" else "route_specific"
            forecast_basis = "Synthetic route freight rate (MVP)" if forecast_type == "synthetic_route" else "Verified route freight"
            forecast_source = "synthetic_route_freight_rates.csv (MVP development dataset)" if forecast_type == "synthetic_route" else "Verified route freight observations"
            training_data_mode = route_freight_result.get("data_mode", training_data_mode)
            # Convert the route model curve to the unified frontend contract.
            forecast_curve = [
                {
                    "horizon": f"H+{item['horizon_months']}",
                    "date": item["target_date"],
                    "predicted_rate": item["predicted_rate_usd_per_ton"],
                    "lower_bound": item.get("lower_bound"),
                    "upper_bound": item.get("upper_bound"),
                    "confidence": None,
                }
                for item in route_freight_result["forecasts"]
            ]
            data_source_level = "synthetic_route" if forecast_type == "synthetic_route" else "route_specific"
            data_confidence = "low" if forecast_type == "synthetic_route" else route_freight_result.get("data_confidence", "medium")
        probs = self.clf.predict_proba(X)[0]

        idx = int(np.argmax(probs))

        predicted_class = int(self.clf.classes_[idx])

        risk_classes = {
            0: "low",
            1: "medium",
            2: "high",
        }

        risk = risk_classes[predicted_class]
        confidence = float(probs[idx])
        
        # Reuse the SAME resolved lookup (and its data_source_level) that
        # built the feature row above, instead of re-querying independently.
        # Previously this line had its own fallback — `next(iter(...))` —
        # which on a miss would silently hand back an ARBITRARY unrelated
        # destination/commodity's data. Removed: the fallback hierarchy in
        # _resolve_lookup() is now the single source of truth for both the
        # feature row and this "previous rate" figure, so they can never
        # disagree about which data they're using.
        pct=(forecast-prev)/prev if prev else 0

        # Destination port's usable depth (prefer cargo pier depth, fall back to channel depth).
        dest_port_info = port_utils.get_port(req.destination_port)
        port_depth = None
        if dest_port_info:
            port_depth = (
                dest_port_info.get("cargo_depth_m")
                or dest_port_info.get("channel_depth_m")
                or dest_port_info.get("max_draft_m")
            )
        # Phase 6: origin port must be checked with the SAME constraint
        # engine as the destination — previously only the destination was
        # validated, so a vessel could be "recommended" that couldn't
        # actually load at the origin port.
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
                # Phase 24/25: an infeasible REQUESTED vessel must never break
                # the whole forecast. Previously this raised ValueError ->
                # HTTP 400 for the entire request, discarding the rate/risk
                # forecast along with it. Now: keep the forecast, report the
                # rejection reason, and fall back to the best feasible
                # vessel if one exists (or none, if truly no vessel fits).
                rej = next((r for r in rejected_candidates if r["vessel_class"] == requested_vessel), None)
                vessel_rejection_reason = (
                    rej["rejection_reason"] if rej
                    else build_not_recognized_vessel( vessel=requested_vessel)
                )
                if feasible_candidates:
                    vessel = recommendation["recommended_vessel"]
                    vessel_status = "REQUESTED_VESSEL_NOT_FEASIBLE_USING_RECOMMENDED"
                else:
                    vessel = recommendation["recommended_vessel"]  # informational only — see vessel_status
                    vessel_status = "NO_FEASIBLE_VESSEL"
        else:
            vessel = recommendation["recommended_vessel"]
            vessel_status = "RECOMMENDED_VESSEL" if feasible_candidates else "NO_FEASIBLE_VESSEL"

        note = recommendation["explanation"]
        # Make the vessel decision auditable: show the physical reason for the
        # selected class and surface the first rejected alternatives.
        recommended_vessel_reason = note
        if vessel_status == "REQUESTED_VESSEL_NOT_FEASIBLE_USING_RECOMMENDED" and vessel_rejection_reason:
            recommended_vessel_reason = build_requested_rejected( vessel=requested_vessel, reason=vessel_rejection_reason,
                selected=vessel, note=note,
            )
        elif feasible_candidates:
            dims = []
            spec = next((c for c in feasible_candidates if c["vessel_class"] == vessel), feasible_candidates[0])
            if spec.get("typical_draft") is not None and dest_port_info and dest_port_info.get("max_draft_m") is not None:
                dims.append(build_draft_check_item( draft=spec["typical_draft"], limit=dest_port_info["max_draft_m"]
                ))
            if spec.get("typical_length") is not None and origin_port_info and origin_port_info.get("max_loa_m") is not None:
                dims.append(build_loa_check_item( loa=spec["typical_length"], limit=origin_port_info["max_loa_m"]
                ))
            if dims:
                recommended_vessel_reason = build_key_feasibility_checks( note=note, checks="; ".join(dims)
                )

        # Build detailed rejected-vessel reasons for the UI. The feasibility
        # engine intentionally keeps its raw reason for auditability; the UI
        # should not expose that English-only internal string when another
        # The decision engine is English-only.
        rejected_reasons = []
        for entry in rejected_candidates:
            item = dict(entry)
            kind = "generic"
            port_name = None
            value = None
            limit = None
            if float(entry.get("typical_dwt", 0) or 0) < float(req.cargo_weight_tons):
                kind = "cargo"
                item["rejection_reason"] = build_rejection_reason( kind=kind, cargo=req.cargo_weight_tons,
                    dwt=float(entry.get("typical_dwt", 0) or 0)
                )
            else:
                for label, port_name_candidate, info in (
                    ("origin port", req.origin_port, origin_port_info),
                    ("destination port", req.destination_port, dest_port_info),
                ):
                    ok, reason = port_utils.check_vessel_port_compatibility(
                        entry.get("vessel_class"), info, label=label
                    )
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
                item["rejection_reason"] = build_rejection_reason( kind=kind, port=port_name, value=value, limit=limit
                )
            rejected_reasons.append(item)

        turnaround=port_utils.port_turnaround_days(req.destination_port,req.cargo_weight_tons)
        congestion=port_utils.congestion_warning(req.origin_port,req.destination_port)
        direction_key="rise" if pct>0.03 else "fall" if pct<-0.03 else "flat"
        # Keep the technical port feasibility note in English only when it is
        # supplied by the static port database; the decision guidance itself
        # is localized below.
        summary, window, vessel_note, idle = build_prediction_text(
            commodity=req.commodity, destination=req.destination_port,
            forecast=forecast, risk=risk, direction=direction_key, note=note,
            vessel=vessel, turnaround=turnaround, pct_move=pct,
        )
        duration_note = f" over {req.contract_duration_months:.0f} months" if req.contract_duration_months else ""
        strategy=build_contract_text( pct_move=pct, risk=risk, duration_note=duration_note,
                                   total_program_tons=req.total_program_tons, cargo_weight_tons=req.cargo_weight_tons)
        trend=(
            [{"label":"route lag 3m","value":round(float(route_freight_result["forecasts"][0]["predicted_rate_usd_per_ton"]),2)},
             {"label":"route last available","value":round(prev,2)},
             {"label":"route forecast","value":round(forecast,2)}]
            if use_route_freight
            else [{"label":"BDRY lag 3m","value":round(float(lookup["bdry_lag3"]),2)},{"label":"BDRY lag 2m","value":round(float(lookup["bdry_lag2"]),2)},{"label":"last known","value":round(prev,2)},{"label":"forecast","value":round(forecast,2)}]
        )
        return {"route":f"{req.origin_port}-{req.destination_port}","predicted_freight_rate_usd_per_ton":round(forecast,2),"risk_label":risk,"risk_confidence":round(confidence,3),"recommended_vessel_type":vessel,"recommended_charter_window":window,"summary":summary,"trend_points":trend,"feasible_vessel_types":feasible,"vessel_constraint_note":vessel_note,"origin_port_info":self._port_info(req.origin_port),"destination_port_info":self._port_info(req.destination_port),"port_turnaround_days":turnaround,"idle_management_advice":idle,"congestion_warning":build_congestion_text(congestion),"contracting_strategy":strategy,"feature_importance":self.meta.get("forecast_feature_importance",[])[:5],"top_drivers":self._local_drivers(feature_values),"data_source_level":data_source_level,"vessel_status":vessel_status,"vessel_rejection_reason":vessel_rejection_reason,"rejected_vessel_types":rejected_reasons,"forecast_curve":forecast_curve,"forecast_type":forecast_type,"data_confidence":data_confidence,"training_data_mode":training_data_mode,
        "forecast_basis":forecast_basis,
        "forecast_source":forecast_source,
        "route_model_available": bool(route_freight_result and route_freight_result.get("forecasts")),
        "route_model_beats_baseline": route_model_beats_baseline,
        "route_model_fallback_note": route_model_fallback_note,
        "latest_feature_date":self.meta.get("training_run",{}).get("training_period",{}).get("end") or self.meta.get("training_run",{}).get("test_period",{}).get("end"),
        "risk_reliability":"low for high-risk class; medium overall" if self.meta.get("metrics",{}).get("risk_walk_forward_cv",{}).get("status") == "ok" else "medium",
        "recommended_vessel_reason":recommended_vessel_reason,
        "port_data_warning": build_port_data_warning() if (origin_port_info or {}).get("data_status") or (dest_port_info or {}).get("data_status") else None}

    def compare_origins(self, req):
        """(2) Rank every known loading port for the same cargo/destination/
        date. The rate/risk model is destination+commodity driven (a global
        BDRY-based market signal), so the forecast rate is the same across
        origins by design — what genuinely differs per origin is covered
        here: vessel feasibility at BOTH ends, load-port congestion, and
        estimated transit time.

        PERF: this used to run all N origins (11 today) fully sequentially —
        one model .predict() call plus two fresh sqlite connections/queries
        (origin AND the *same* destination, recomputed every single time)
        per origin. On a slow/free-tier CPU that easily adds up to well
        past the backend's per-request timeout even when ml-service is
        fully warm, which then LOOKS like a cold start (the backend retries
        and the frontend shows the generic "waking up" banner) when the
        real cost is this fan-out. Fixed two ways:
          1. The destination's AIS stats don't change per origin — fetch
             them once, not N times.
          2. Each origin's (predict + AIS-lookup) work is independent, so
             run the origins concurrently instead of one at a time.
        """
        from app.schemas import ForecastRequest
        import concurrent.futures
        origins = self.meta.get("origins", [])

        # NOTE: the old code also fetched AIS stats for req.destination_port
        # on every single origin iteration via route_features(), even
        # though the destination never changes across the loop AND that
        # destination half of the result was thrown away (only `origin` was
        # ever read into ais_congestion below). That was pure wasted work —
        # a full extra sqlite round trip, 11 times, for data nobody used —
        # so it's simply dropped rather than "fetched once and reused".
        ais_live = ais_collector is not None and ais_collector.enabled

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
                    # Decision summaries are generated in English only.
                    # per-origin comparison summary came back in English
                    # regardless of the caller context.
                )
                pred = self.predict(single)
            except Exception as exc:
                return ("error", {"origin_port": origin, "error": str(exc)})

            origin_info = port_utils.get_port(origin)
            if origin_info is None:
                # BUGFIX: an origin with no port-infrastructure data used to
                # be silently included in `results` with null feasibility/
                # congestion fields, looking like a valid (if unremarkable)
                # option. That data gap belongs in `errors`, surfaced to the
                # caller, not hidden inside an otherwise-normal-looking row.
                return ("error", {
                    "origin_port": origin,
                    "error": "No port infrastructure data available for this origin.",
                })
            origin_port_ok = None
            if pred.get("recommended_vessel_type"):
                origin_port_ok = port_utils.vessel_fits_port(pred["recommended_vessel_type"], origin_info)
            distance_nm = port_utils.get_distance_nm(origin, req.destination_port)
            transit_days = port_utils.estimate_transit_days(origin, req.destination_port)
            total_voyage_days = (
                round(transit_days + pred["port_turnaround_days"], 1)
                if transit_days is not None else None
            )

            # TASK 7: live AIS congestion signal per origin.
            # `origin_port_congestion` above stays the static
            # port_infra.json rating exactly as before (nothing depends on
            # it disappearing). This adds a second, clearly-labeled
            # `ais_congestion` field alongside it, populated only when a
            # live AISStream collector is actually connected. Any failure
            # here (feed down, unknown port for AIS, disabled collector)
            # must never break compare_origins — it just falls back to
            # "available": False and the static rating keeps doing its job.
            ais_congestion = {
                "available": False,
                "congestion_index": None,
                "unique_vessels": None,
                "avg_sog_kn": None,
                "lookback_hours": None,
                "source": None,
            }
            if ais_live:
                try:
                    o = ais_collector.port_congestion(origin, lookback_hours=24)
                    ais_congestion = {
                        "available": True,
                        "congestion_index": o["congestion_index"],
                        "unique_vessels": o["unique_vessels"],
                        "avg_sog_kn": o["avg_sog_kn"],
                        "lookback_hours": 24,
                        "source": "AISStream live AIS feed (this origin only, last 24h)",
                    }
                except Exception:
                    # Unknown port for AIS, feed error, etc. — keep the
                    # "available": False default and move on; the static
                    # typical_congestion rating below is unaffected.
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
                "feasible": bool(origin_port_ok) if origin_port_ok is not None else None,
            })

        results, errors = [], []
        # I/O (sqlite) releases the GIL and RandomForest.predict spends most
        # of its time inside numpy/BLAS, which also releases it — so a
        # thread pool gives real wall-clock overlap here even though this
        # is CPython. Bounded at 6 so this doesn't itself become a new
        # source of CPU contention on a small Render instance.
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(origins) or 1)) as pool:
            for kind, row in pool.map(build_row, origins):
                (results if kind == "ok" else errors).append(row)

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

    def _idle_market_predictions(self, destination_port, commodities, shipment_date):
        """Batch the BDRY/risk model work used by idle-alternatives.

        The normal ``predict()`` endpoint intentionally performs the complete
        decision-support pipeline (forecast curve, route-rate model, vessel
        feasibility, explainability, and decision text). Re-running that
        whole pipeline once per idle-vessel candidate is unnecessarily costly.
        This helper performs only the two model predictions actually needed by
        idle-alternatives: freight-rate proxy + risk classification.

        IMPORTANT: this preserves the same deterministic lookup hierarchy and
        the same delta-vs-last-known target reconstruction used by ``predict``.
        It merely batches the independent rows into one reg/classifier call.
        """
        rows = []
        lookup_by_commodity = {}
        for commodity in commodities:
            lookup, _level = self._resolve_lookup(destination_port, commodity)
            lookup_by_commodity[commodity] = lookup
            values = {k: lookup[k] for k in self.meta["numeric_features"]}
            values["month_num"] = shipment_date.month
            values["quarter"] = (shipment_date.month - 1) // 3 + 1
            values["trade_signal_lag1"] = float(lookup.get("trade_signal_lag1", 0.0))
            values["trade_signal_yoy_growth"] = float(lookup.get("trade_signal_yoy_growth", 0.0))
            values["has_trade_signal"] = float(lookup.get("has_trade_signal", 0.0))
            row = {n: values[n] for n in self.meta["numeric_features"]}
            row["port"] = destination_port
            row["commodity"] = commodity
            rows.append(row)

        if not rows:
            return {}

        frame = pd.DataFrame(rows)
        cat = self.encoder.transform(frame[["port", "commodity"]])
        num = frame[self.meta["numeric_features"]].to_numpy(dtype=float)
        X = np.concatenate([num, cat], axis=1)

        deltas = np.asarray(self.reg.predict(X), dtype=float)
        probabilities = self.clf.predict_proba(X)
        classes = list(self.clf.classes_)
        risk_classes = {0: "low", 1: "medium", 2: "high"}

        out = {}
        for i, commodity in enumerate(commodities):
            lookup = lookup_by_commodity[commodity]
            prev = float(lookup["bdry_lag1"])
            forecast = prev + float(deltas[i])
            idx = int(np.argmax(probabilities[i]))
            predicted_class = int(classes[idx])
            out[commodity] = {
                "forecast": float(forecast),
                "risk": risk_classes[predicted_class],
                "risk_confidence": float(probabilities[i][idx]),
                "prev": prev,
            }
        return out

    def idle_alternatives(self, req):
        """Rank next-best loading ports for an idle vessel.

        PERFORMANCE FIX:
        ``predict()`` is the full forecast/decision pipeline and is too
        expensive to run once for every ``origin x commodity`` candidate on a
        small Render CPU. The old implementation could execute up to 30 full
        pipelines for an ``Any`` commodity request. This version:

        1. batches the BDRY forecast + risk model across commodities;
        2. uses only the lightweight route-freight model when a route-specific
           lane is available and its held-out baseline guardrail passes;
        3. performs static vessel-feasibility checks directly instead of
           recalculating a full forecast for each candidate;
        4. reuses ballast distance/time already calculated once per origin.

        The returned API contract is unchanged.
        """
        origins = [
            origin for origin in self.meta.get("origins", [])
            if str(origin).strip().lower() != str(req.current_port).strip().lower()
        ]
        commodities = [req.commodity] if req.commodity else self.meta.get("commodities", [])
        cargo_weight = req.cargo_weight_tons or 50000.0
        vessel_type = req.vessel_type
        shipment_date = date.today()

        # Static destination data is identical for every candidate.
        dest_info = port_utils.get_port(req.current_port)

        # Pre-filter origins and compute ballast once per origin.
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

        # One batched BDRY/risk prediction for the complete commodity set.
        market_predictions = self._idle_market_predictions(
            req.current_port, commodities, shipment_date
        )

        candidates = []
        errors = []
        for origin, origin_info, distance_nm, ballast_days in jobs:
            for commodity in commodities:
                base = market_predictions.get(commodity)
                if base is None:
                    errors.append({
                        "origin_port": origin,
                        "commodity": commodity,
                        "error": "No market-proxy prediction available for this commodity.",
                    })
                    continue

                rate = base["forecast"]
                risk = base["risk"]

                # Preserve the project's route-specific guardrail. The route
                # model is allowed to replace the market-proxy level only when
                # its H+1 held-out evaluation beat naive persistence. Do this
                # before vessel recommendation so the recommendation sees the
                # same final rate that the old full-predict path used.
                if self.route_freight is not None:
                    try:
                        route_result = self.route_freight.predict(
                            origin,
                            req.current_port,
                            shipment_date,
                            commodity=commodity,
                        )
                    except Exception as exc:
                        route_result = None
                        errors.append({
                            "origin_port": origin,
                            "commodity": commodity,
                            "error": f"Route freight fallback unavailable: {exc}",
                        })
                    if (
                        route_result
                        and route_result.get("forecasts")
                        and route_result.get("model_beats_baseline") is True
                    ):
                        rate = float(route_result["forecasts"][0]["predicted_rate_usd_per_ton"])

                recommended_vessel = None
                try:
                    feasible_candidates, _rejected = port_utils.feasible_vessels_both_ports(
                        cargo_weight, origin_info, dest_info
                    )
                    if feasible_candidates:
                        recommendation = port_utils.recommend_vessel(
                            cargo_weight,
                            (
                                (dest_info or {}).get("cargo_depth_m")
                                or (dest_info or {}).get("channel_depth_m")
                                or (dest_info or {}).get("max_draft_m")
                            ),
                            port_name=req.current_port,
                            origin_port_name=origin,
                            predicted_rate=rate,
                            previous_rate=base["prev"],
                        )
                        recommended_vessel = recommendation.get("recommended_vessel")
                except Exception:
                    # Vessel recommendation is supplementary; never discard a
                    # valid freight/risk candidate because static port metadata
                    # is incomplete.
                    recommended_vessel = None

                # Discount earnings potential by ballast/idle time so a far,
                # high-rate option does not automatically beat a nearby one.
                score = rate / (1 + (ballast_days or 0) / 30.0)
                candidates.append({
                    "origin_port": origin,
                    "commodity": commodity,
                    "predicted_freight_rate_usd_per_ton": round(float(rate), 2),
                    "risk_label": risk,
                    "recommended_vessel_type": recommended_vessel or vessel_type,
                    "ballast_distance_nm": distance_nm,
                    "estimated_ballast_days": ballast_days,
                    "score": round(float(score), 3),
                    "note": build_idle_reposition_note(
                        origin=origin,
                        commodity=commodity,
                        current_port=req.current_port,
                    ),
                })

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

    def _port_info(self, name):
        info=port_utils.get_port(name)
        if not info: return {"name":name,"known":False}
        return {
            "name":name,"known":True,
            "max_loa_m":info.get("max_loa_m"),
            "max_beam_m":info.get("max_beam_m"),
            "max_draft_m":info.get("max_draft_m"),
            "cargo_handling_rate_tpd":info.get("cargo_handling_rate_tpd"),
            "typical_congestion":info.get("typical_congestion"),
            "notes":info.get("notes"),
            "data_status":info.get("data_status"),
            "source_note":info.get("source_note"),
        }
