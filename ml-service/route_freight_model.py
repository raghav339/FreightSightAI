"""Optional route-specific freight-rate model.

This model trains on verified production observations, or on explicitly labelled
synthetic MVP observations when `allow_synthetic=True`. Synthetic rows are
never treated as observed market quotes. It never converts BDRY/BDI/AIS/TCE into
an observed freight rate. If a lane has no eligible route-rate observations,
that lane remains on the existing market-proxy fallback.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.base import clone
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "production"
MODELS = ROOT / "models"
OBS_FILE = DATA / "route_freight_observations.csv"
META_FILE = MODELS / "route_freight_model_metadata.json"
SCHEMA_VERSION = "1.0"
MIN_OBSERVATIONS = 24

NUMERIC = ["cargo_size_t", "lag1", "lag2", "lag3", "rolling_mean_3", "rolling_std_3", "month_sin", "month_cos"]
CATEGORICAL = ["commodity", "vessel_class", "observation_type"]


def _key(origin: str, destination: str, route_id: str) -> str:
    return f"{origin.strip()}|{destination.strip()}|{route_id.strip()}"


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_verified(path: Path | None = None, allow_synthetic: bool = False) -> pd.DataFrame:
    source = Path(path) if path else OBS_FILE
    if not source.exists():
        return pd.DataFrame()
    df = pd.read_csv(source)
    if df.empty:
        return df
    for c in ("observation_date", "publication_date", "retrieval_date"):
        if c in df:
            df[c] = pd.to_datetime(df[c], errors="coerce")
    df["freight_usd_per_t"] = pd.to_numeric(df.get("freight_usd_per_t"), errors="coerce")
    df["cargo_size_t"] = pd.to_numeric(df.get("cargo_size_t"), errors="coerce")
    status = df.get("verification_status", pd.Series(dtype=str)).astype(str).str.lower()
    valid_status = status.eq("verified") | (allow_synthetic & status.eq("synthetic"))
    mask = (
        valid_status
        & df.get("rate_type", pd.Series(dtype=str)).astype(str).str.lower().eq("freight_usd_per_t")
        & df["observation_date"].notna()
        & df["freight_usd_per_t"].notna()
        & (df["freight_usd_per_t"] > 0)
        & df.get("route_id", pd.Series(dtype=str)).astype(str).str.len().gt(0)
    )
    return df.loc[mask].copy().sort_values(["route_id", "observation_date"])


def _monthly_series(group: pd.DataFrame) -> pd.DataFrame:
    g = group.sort_values("observation_date").copy()
    g["month"] = g["observation_date"].dt.to_period("M").dt.to_timestamp()
    # Multiple public observations can exist in the same month. Median is
    # robust to one-off fixtures while retaining the published rate scale.
    m = g.groupby("month", as_index=False).agg(
        freight_usd_per_t=("freight_usd_per_t", "median"),
        cargo_size_t=("cargo_size_t", "median"),
        commodity=("commodity", "first"),
        vessel_class=("vessel_class", "first"),
        observation_type=("observation_type", lambda x: "mixed" if x.nunique() > 1 else x.iloc[0]),
    )
    return m.sort_values("month").reset_index(drop=True)


def _features(group: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    g = _monthly_series(group)
    g["lag1"] = g["freight_usd_per_t"].shift(1)
    g["lag2"] = g["freight_usd_per_t"].shift(2)
    g["lag3"] = g["freight_usd_per_t"].shift(3)
    g["rolling_mean_3"] = g["freight_usd_per_t"].shift(1).rolling(3, min_periods=2).mean()
    g["rolling_std_3"] = g["freight_usd_per_t"].shift(1).rolling(3, min_periods=2).std().fillna(0)
    g["month_sin"] = np.sin(2 * np.pi * g["month"].dt.month / 12)
    g["month_cos"] = np.cos(2 * np.pi * g["month"].dt.month / 12)
    g = g.dropna(subset=["lag1", "lag2", "lag3", "rolling_mean_3"])
    x = g[["month"] + NUMERIC + CATEGORICAL].copy()
    return x, g["freight_usd_per_t"]


def train(output_dir: str | Path | None = None, data_dir: str | Path | None = None, allow_synthetic: bool = False) -> dict[str, Any]:
    out = Path(output_dir) if output_dir else MODELS
    data_root = Path(data_dir) if data_dir else DATA
    obs_file = data_root / "route_freight_observations.csv"
    out.mkdir(parents=True, exist_ok=True)
    df = load_verified(obs_file, allow_synthetic=allow_synthetic)
    meta_file = out / "route_freight_model_metadata.json"
    if df.empty:
        for h in (1, 2, 3):
            stale = out / f"route_freight_model_h{h}.joblib"
            if stale.exists():
                stale.unlink()
        meta = {
            "status": "inactive",
            "reason": "No eligible route_freight_observations.csv rows with USD/tonne targets.",
            "schema_version": SCHEMA_VERSION,
            "min_observations_per_route": MIN_OBSERVATIONS,
            "target": "observed_freight_usd_per_t" if not allow_synthetic else "synthetic_route_freight_usd_per_t",
            "data_mode": "synthetic_mvp" if allow_synthetic else "verified_production",
        }
        meta_file.write_text(json.dumps(meta, indent=2))
        return meta

    bundles: dict[str, dict[int, Pipeline]] = {}
    metrics: dict[str, Any] = {}
    skipped: dict[str, str] = {}

    for key, g in df.groupby(df.apply(lambda r: _key(r.origin, r.destination, r.route_id), axis=1)):
        if len(g) < MIN_OBSERVATIONS:
            skipped[key] = f"Only {len(g)} verified observations; need {MIN_OBSERVATIONS}."
            continue
        x, y = _features(g)
        if len(x) < 18:
            skipped[key] = f"Only {len(x)} usable lagged observations after feature construction."
            continue
        # _features() returns a reset-index monthly frame. Use its own
        # month column for chronological splitting so grouped routes whose
        # original CSV index does not start at zero are handled correctly.
        months = pd.to_datetime(x["month"]).sort_values().unique()
        split = months[max(1, int(len(months) * 0.8)) - 1]
        train_idx = x.index[pd.to_datetime(x["month"]) <= split]
        test_idx = x.index[pd.to_datetime(x["month"]) > split]
        if len(train_idx) < 12 or len(test_idx) < 3:
            skipped[key] = "Insufficient chronological train/test separation."
            continue

        pre = ColumnTransformer([
            ("num", "passthrough", NUMERIC),
            ("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL),
        ])
        base = Pipeline([
            ("pre", pre),
            ("rf", RandomForestRegressor(
                n_estimators=500,
                max_depth=14,
                min_samples_leaf=2,
                random_state=42,
                n_jobs=-1,
            )),
        ])

        # Direct H+1/H+2/H+3 targets based on chronological observations in
        # the same lane. Missing calendar months are intentionally not filled.
        work = _monthly_series(g)
        for h in (1, 2, 3):
            target = work["freight_usd_per_t"].shift(-h)
            fh = x.copy()
            target_by_month = work.set_index("month")["freight_usd_per_t"].shift(-h)
            fh["target"] = fh["month"].map(target_by_month)
            fit = fh.dropna(subset=["target"])
            fit_train = fit.loc[fit.index.isin(train_idx)]
            fit_test = fit.loc[fit.index.isin(test_idx)]
            if len(fit_train) < 10 or len(fit_test) < 2:
                continue
            model = clone(base)
            model.fit(fit_train[NUMERIC + CATEGORICAL], fit_train["target"])
            pred = model.predict(fit_test[NUMERIC + CATEGORICAL])
            naive = fit_test["lag1"].to_numpy()
            
            movavg = fit_test["rolling_mean_3"].to_numpy()
            mae = float(mean_absolute_error(fit_test["target"], pred))
            naive_mae = float(mean_absolute_error(fit_test["target"], naive))
            movavg_mae = float(mean_absolute_error(fit_test["target"], movavg))
            rmse = float(np.sqrt(mean_squared_error(fit_test["target"], pred)))
            # A route model that cannot beat "do nothing" (naive persistence)
            # is not earning its complexity. This is the exact failure mode
            # that produced the real, disclosed finding referenced in the
            # project fix list (route H+1 MAE 5.76 vs. naive 3.46) — the bar
            # here is intentionally the same one applied to the BDRY model in
            # train.py, so the two pipelines can't silently drift apart on
            # what counts as "beats baseline".
            beats_naive = mae < naive_mae
            beats_movavg = mae < movavg_mae
            bundles.setdefault(key, {})[h] = model
            metrics.setdefault(key, {})[str(h)] = {
                "train_rows": int(len(fit_train)),
                "test_rows": int(len(fit_test)),
                "test_period": {"start": str(pd.to_datetime(fit_test["month"]).min().date()),
                                 "end": str(pd.to_datetime(fit_test["month"]).max().date())},
                "mae_usd_per_t": round(mae, 4),
                "naive_mae_usd_per_t": round(naive_mae, 4),
                "moving_average_mae_usd_per_t": round(movavg_mae, 4),
                "improvement_pct": round((naive_mae - mae) / naive_mae * 100, 2) if naive_mae else None,
                "improvement_pct_vs_moving_average": round((movavg_mae - mae) / movavg_mae * 100, 2) if movavg_mae else None,
                "rmse_usd_per_t": round(rmse, 4),
                "beats_naive_persistence": beats_naive,
                "beats_moving_average": beats_movavg,
                # Primary pass/fail bar used to decide whether the API is
                # allowed to serve this route model as the authoritative
                # forecast (see app/utils.py ModelBundle.predict). Naive
                # persistence is the bar, per the disclosed finding above —
                # beating a 3-month moving average is tracked but is not by
                # itself enough to earn trust.
                "model_beats_baseline": beats_naive,
            }

    for h in (1, 2, 3):
        artifact = {key: bundle[h] for key, bundle in bundles.items() if h in bundle}
        if artifact:
            joblib.dump(artifact, out / f"route_freight_model_h{h}.joblib")

    
    total = sum(len(h_metrics) for h_metrics in metrics.values())
    failing = [
        (key, h) for key, h_metrics in metrics.items()
        for h in h_metrics if not h_metrics[h]["model_beats_baseline"]
    ]
    print("=" * 78)
    print("ROUTE-FREIGHT MODEL: baseline comparison (model vs. naive persistence)")
    print("=" * 78)
    if total == 0:
        print("No route+horizon models were trained (no lane had enough eligible data).")
    for key, h_metrics in metrics.items():
        for h, m in sorted(h_metrics.items(), key=lambda kv: int(kv[0])):
            status = "PASS" if m["model_beats_baseline"] else "FAIL — DOES NOT BEAT NAIVE PERSISTENCE"
            print(
                f"[{status}] {key} H+{h}: model MAE={m['mae_usd_per_t']} | "
                f"naive MAE={m['naive_mae_usd_per_t']} | moving_avg_3m MAE={m['moving_average_mae_usd_per_t']} "
                f"(n={m['test_rows']}, {m['test_period']['start']}..{m['test_period']['end']})"
            )
    print("-" * 78)
    if failing:
        print(
            f"WARNING: {len(failing)}/{total} route+horizon model(s) FAILED to beat naive "
            "persistence on held-out data. These will NOT be served as the authoritative "
            "forecast for their lane — the API falls back to the BDRY market-proxy forecast "
            "for that origin/destination/horizon instead of silently trusting a losing model."
        )
        for key, h in failing:
            print(f"  - {key} H+{h}")
    else:
        print(f"All {total} route+horizon model(s) beat naive persistence on held-out data.")
    print("=" * 78)

    meta = {
        "status": "active" if bundles else "inactive",
        "schema_version": SCHEMA_VERSION,
        "target": "observed_freight_usd_per_t" if not allow_synthetic else "synthetic_route_freight_usd_per_t",
            "data_mode": "synthetic_mvp" if allow_synthetic else "verified_production",
        "source_file": str(obs_file),
        "dataset_sha256": _hash_file(obs_file),
        "eligible_rows": int(len(df)),
        "verified_rows": int((df.get("verification_status", pd.Series(dtype=str)).astype(str).str.lower() == "verified").sum()),
        "synthetic_rows": int((df.get("verification_status", pd.Series(dtype=str)).astype(str).str.lower() == "synthetic").sum()),
        "routes_with_models": sorted(bundles),
        "metrics": metrics,
        "skipped_routes": skipped,
        "minimum_observations_per_route": MIN_OBSERVATIONS,
        "features": NUMERIC + CATEGORICAL,
        "interval_note": "Prediction bounds, when exposed, are ensemble-tree percentiles and are not statistical confidence intervals.",
        
        "baseline_summary": {
            "total_route_horizon_models": total,
            "passed": total - len(failing),
            "failed": len(failing),
            "failed_route_horizons": [f"{key} H+{h}" for key, h in failing],
        },
    }
    meta_file.write_text(json.dumps(meta, indent=2))
    return meta


class RouteFreightModel:
    def __init__(self, models_dir: str | Path | None = None, data_dir: str | Path | None = None):
        self.models_dir = Path(models_dir) if models_dir else MODELS
        self.data_dir = Path(data_dir) if data_dir else DATA
        self.models = {}
        for h in (1, 2, 3):
            p = self.models_dir / f"route_freight_model_h{h}.joblib"
            if p.exists():
                self.models[h] = joblib.load(p)
        meta_file = self.models_dir / "route_freight_model_metadata.json"
        self.meta = json.loads(meta_file.read_text()) if meta_file.exists() else {"status": "inactive"}
        self.data_mode = "verified_production"
        self.data = load_verified(self.data_dir / "route_freight_observations.csv")

        # Guard against stale model artifacts: a handful of verified
        # production rows can accumulate (e.g. a few manually-verified
        # observations) long before any single lane reaches
        # MIN_OBSERVATIONS, so the on-disk .joblib files may still be the
        # ones from an earlier `train(allow_synthetic=True)` run. Loading
        # production data in that state would pair synthetic-trained
        # models with production rows for entirely different lanes,
        # silently breaking predict() for every route (no key overlap, so
        # every lookup falls through to "no prior observations"). If the
        # loaded models don't correspond to any route in the freshly
        # loaded data, treat production as not-yet-usable and fall back
        # to the synthetic MVP dataset instead.
        model_keys = {key for bundle in self.models.values() for key in bundle}
        data_keys = set()
        if not self.data.empty:
            data_keys = set(self.data.apply(lambda r: _key(r.origin, r.destination, r.route_id), axis=1))
        stale_models = bool(model_keys) and not (model_keys & data_keys)

        if self.data.empty or stale_models:
            synthetic = self.data_dir.parent / "synthetic" / "route_freight_observations.csv"
            self.data = load_verified(synthetic, allow_synthetic=True)
            if not self.data.empty:
                self.data_mode = "synthetic_mvp"

    def has_route(self, origin: str, destination: str, route_id: str | None = None, commodity: str | None = None) -> bool:
        if self.data.empty:
            return False
        keys = self.data.apply(lambda r: _key(r.origin, r.destination, r.route_id), axis=1)
        prefix = f"{origin}|{destination}|"
        matching = {k for k in keys if k.startswith(prefix)}
        if commodity:
            wanted = commodity.strip().lower().replace(" ", "_").replace("&", "and")
            matching = {k for k in matching if any(str(c).strip().lower().replace(" ", "_").replace("&", "and") == wanted for c in self.data.loc[keys.isin([k]), "commodity"])}
        if route_id:
            matching = {k for k in matching if k.endswith(f"|{route_id}")}
        return any(k in self.models[h] for h in self.models for k in matching)

    def predict(
        self,
        origin: str,
        destination: str,
        when: str | pd.Timestamp,
        route_id: str | None = None,
        commodity: str | None = None,
        cargo_size_t: float | None = None,
        vessel_class: str | None = None,
    ) -> dict[str, Any] | None:
        if self.data.empty or not self.models:
            return None
        candidates = []
        for key in self.models.get(1, {}):
            o, d, rid = key.split("|", 2)
            if o != origin or d != destination or (route_id and rid != route_id):
                continue
            if commodity:
                rows = self.data[self.data.apply(lambda r: _key(r.origin, r.destination, r.route_id) == key, axis=1)]
                wanted = commodity.strip().lower().replace(" ", "_").replace("&", "and")
                route_commodity = str(rows.iloc[0].commodity).strip().lower().replace(" ", "_").replace("&", "and") if not rows.empty else ""
                if route_commodity != wanted:
                    continue
            candidates.append(key)
        if not candidates:
            return None
        key = candidates[0]
        route_rows = self.data[self.data.apply(lambda r: _key(r.origin, r.destination, r.route_id) == key, axis=1)].copy()
        route_rows = _monthly_series(route_rows)
        when = pd.Timestamp(when)
        prior = route_rows[route_rows.month < when.to_period("M").to_timestamp()]
        if len(prior) < 3:
            return None
        latest = prior.iloc[-1]
        # BUGFIX: cargo_size_t and vessel_class are real model inputs (see
        # NUMERIC/CATEGORICAL above) — a 50,000t Supramax shipment and a
        # 150,000t Capesize shipment on the same route/date used to produce
        # the identical prediction, because both silently fell back to
        # whatever the route's most recent *historical* observation
        # happened to record, ignoring what the current request actually
        # asked for. Use the request's own values when supplied, and only
        # fall back to the historical observation for whichever of the two
        # the caller didn't provide.
        request_cargo_size_t = (
            float(cargo_size_t) if cargo_size_t is not None and cargo_size_t > 0 else None
        )
        request_vessel_class = (
            str(vessel_class).strip() if vessel_class not in (None, "") else None
        )
        base = {
            "cargo_size_t": (
                request_cargo_size_t if request_cargo_size_t is not None
                else float(latest.cargo_size_t or 0)
            ),
            "lag1": float(prior.iloc[-1].freight_usd_per_t),
            "lag2": float(prior.iloc[-2].freight_usd_per_t),
            "lag3": float(prior.iloc[-3].freight_usd_per_t),
            "rolling_mean_3": float(prior.iloc[-3:].freight_usd_per_t.mean()),
            "rolling_std_3": float(prior.iloc[-3:].freight_usd_per_t.std() or 0),
            "month_sin": float(np.sin(2 * np.pi * when.month / 12)),
            "month_cos": float(np.cos(2 * np.pi * when.month / 12)),
            "commodity": latest.commodity,
            "vessel_class": (
                request_vessel_class if request_vessel_class is not None
                else latest.vessel_class
            ),
            "observation_type": latest.observation_type,
        }
        cargo_size_source = "request" if request_cargo_size_t is not None else "historical"
        vessel_class_source = "request" if request_vessel_class is not None else "historical"
        curve = []
        for h in (1, 2, 3):
            model = self.models.get(h, {}).get(key)
            if model is None:
                continue
            row = pd.DataFrame([base])
            pred = float(model.predict(row[NUMERIC + CATEGORICAL])[0])
            tree_values = None
            try:
                Xt = model.named_steps["pre"].transform(row[NUMERIC + CATEGORICAL])
                rf = model.named_steps["rf"]
                tree_values = np.array([est.predict(Xt)[0] for est in rf.estimators_], dtype=float)
            except Exception:
                tree_values = None
            last_rate = float(prior.iloc[-1].freight_usd_per_t)
            
            horizon_metrics = self.meta.get("metrics", {}).get(key, {}).get(str(h), {})
            model_beats_baseline = horizon_metrics.get("model_beats_baseline")
            item = {
                "horizon_months": h,
                "target_date": str((when + pd.offsets.MonthBegin(h)).date()),
                "predicted_rate_usd_per_ton": round(pred, 2),
                "rate_change_pct_vs_last_observed": round((pred - last_rate) / last_rate * 100, 3) if last_rate else None,
                "basis": "synthetic_route_freight" if self.data_mode == "synthetic_mvp" else "observed_route_freight",
                "route_id": key.split("|", 2)[2],
                "feature_source_date": str(pd.Timestamp(latest.month).date()),
                "model_beats_baseline": model_beats_baseline,
                "baseline_mae_usd_per_t": horizon_metrics.get("naive_mae_usd_per_t"),
                "model_mae_usd_per_t": horizon_metrics.get("mae_usd_per_t"),
            }
            if tree_values is not None:
                item["lower_bound"] = round(float(np.percentile(tree_values, 10)), 2)
                item["upper_bound"] = round(float(np.percentile(tree_values, 90)), 2)
                item["confidence"] = "ensemble_spread"
            curve.append(item)
        if not curve:
            return None
        
        h1_beats_baseline = next((c.get("model_beats_baseline") for c in curve if c["horizon_months"] == 1), None)
        # Actual historical route freight (not BDRY) for the "route-aware"
        # chart: the last up-to-12 monthly observations that fed the model,
        # in the same {"month","value"} shape the BDRY history endpoint
        # already uses, so the frontend can plot a route-specific
        # history-plus-forecast series instead of always defaulting to BDRY.
        history = [
            {"month": str(row.month.date())[:7], "value": round(float(row.freight_usd_per_t), 2)}
            for row in prior.tail(12).itertuples()
        ]
        return {
            "forecast_type": "route_specific",
            "data_confidence": ("low" if self.data_mode == "synthetic_mvp" else ("high" if len(prior) >= 36 else "medium")),
            "route": f"{origin}-{destination}",
            "route_id": key.split("|", 2)[2],
            "commodity": latest.commodity,
            "last_observed_freight_usd_per_ton": round(float(prior.iloc[-1].freight_usd_per_t), 2),
            "last_available_freight_usd_per_ton": round(float(prior.iloc[-1].freight_usd_per_t), 2),
            "predicted_freight_rate_usd_per_ton": curve[0]["predicted_rate_usd_per_ton"],
            "forecasts": curve,
            "history": history,
            "source": "route_freight_observations.csv",
            "source_data_status": "synthetic_mvp" if self.data_mode == "synthetic_mvp" else "verified_production",
            "data_mode": self.data_mode,
            "model_beats_baseline": h1_beats_baseline,
            "cargo_size_t_used": base["cargo_size_t"],
            "cargo_size_source": cargo_size_source,
            "vessel_class_used": base["vessel_class"],
            "vessel_class_source": vessel_class_source,
            "disclaimer": ("Forecast is trained on synthetic route freight rates for MVP demonstration only; values are not broker quotes or observed market rates." if self.data_mode == "synthetic_mvp" else "Forecast is trained on verified published/observed route freight-rate observations. Bounds are ensemble spread, not statistical confidence intervals."),
        }