"""AIS-enhanced route-level freight-market model.

IMPORTANT DATA CONTRACT
-----------------------
The supplied real dataset does not contain historical route freight-rate
observations in USD/t.  Therefore this model does NOT pretend that BDRY ETF
price is a route freight rate.  It predicts the next 1/2/3 month *dry-bulk
freight-market proxy* using route-specific distance and AIS-derived port
activity.  If a calibrated current spot rate (USD/t) is supplied at inference,
the predicted percentage move is applied to that spot rate to produce an
indicative route rate.  That calibration is explicitly shown in the API.

The route features are currently derived from IMF PortWatch's AIS-derived
daily port activity file.  Direct AIS can be supplied later through
data/production/ais_route_monthly.csv with the documented schema.
"""
from __future__ import annotations
import json, math
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
try:
    from route_freight_model import RouteFreightModel
except Exception:
    RouteFreightModel = None
try:
    from app.ais_stream import collector as ais_collector
except Exception:
    ais_collector = None
from app.data_freshness import classify_ais_freshness

ROOT = Path(__file__).resolve().parents[1] if Path(__file__).resolve().parent.name == "app" else Path(__file__).resolve().parent
DATA = ROOT / "data" / "production"
MODELS = ROOT / "models"
FEATURE_FILE = DATA / "route_monthly_features.csv"

ORIGINS = ["Newcastle","Hay Point","Gladstone","Norfolk","Baltimore","Nacala",
           "Beira","Vostochny","Murmansk","Samarinda","Taboneo"]
DESTINATIONS = ["Paradip","Visakhapatnam","Gangavaram","Gopalpur","Dhamra",
                "Sagar Sandheads","Haldia","Chennai","Kamarajar","Tuticorin"]

NUMERIC = [
    "bdry_proxy","distance_nm",
    "origin_portcalls_dry_bulk","origin_portcalls_cargo","origin_portcalls",
    "origin_import_dry_bulk","origin_export_dry_bulk",
    "destination_portcalls_dry_bulk","destination_portcalls_cargo","destination_portcalls",
    "destination_import_dry_bulk","destination_export_dry_bulk",
    "origin_ais_coverage","destination_ais_coverage",
    "month_sin","month_cos",
]
CATEGORICAL = ["origin","destination"]

def _load_features() -> pd.DataFrame:
    if not FEATURE_FILE.exists():
        raise FileNotFoundError(f"Missing {FEATURE_FILE}. Run build_route_features.py first.")
    df = pd.read_csv(FEATURE_FILE, parse_dates=["month"]).sort_values(["month","origin","destination"])
    df["month_sin"] = np.sin(2*np.pi*df["month"].dt.month/12)
    df["month_cos"] = np.cos(2*np.pi*df["month"].dt.month/12)
    # Targets are the future global freight-market proxy. The model is
    # route-aware because route/AIS features and route identifiers are inputs.
    for h in (1,2,3):
        target = df[["month","bdry_proxy"]].drop_duplicates("month").set_index("month")["bdry_proxy"].shift(-h)
        df[f"target_h{h}"] = df["month"].map(target)
    return df

def train(output_dir: str | Path | None = None):
    out = Path(output_dir) if output_dir else MODELS
    out.mkdir(parents=True, exist_ok=True)
    df = _load_features()
    df = df[df["month"] >= pd.Timestamp("2019-01-01")].copy()
    # Do not train on months where the route feature source is unavailable.
    # This avoids learning a "zero AIS activity" pattern caused by missing data.
    coverage = (df["origin_ais_coverage"] + df["destination_ais_coverage"]) > 0
    df = df[coverage].copy()
    months = sorted(df["month"].unique())
    split_idx = max(1, int(len(months)*0.8))
    split_month = pd.Timestamp(months[split_idx])
    train_df = df[df.month < split_month].copy()
    test_df = df[df.month >= split_month].copy()
    artifacts, metrics = {}, {}
    for h in (1,2,3):
        target=f"target_h{h}"
        tr=train_df.dropna(subset=[target]).copy()
        te=test_df.dropna(subset=[target]).copy()
        if tr.empty or te.empty:
            continue
        pre=ColumnTransformer([
            ("num","passthrough",NUMERIC),
            ("cat",OneHotEncoder(handle_unknown="ignore"),CATEGORICAL),
        ])
        model=Pipeline([
            ("pre",pre),
            ("rf",RandomForestRegressor(
                n_estimators=400,max_depth=16,min_samples_leaf=2,
                random_state=42,n_jobs=-1))
        ])
        model.fit(tr[NUMERIC+CATEGORICAL],tr[target])
        pred=model.predict(te[NUMERIC+CATEGORICAL])
        mae=float(mean_absolute_error(te[target],pred))
        rmse=float(math.sqrt(mean_squared_error(te[target],pred)))

        # Baseline guardrail (same bar applied in train.py and
        # route_freight_model.py): "next h months' proxy == current known
        # bdry_proxy" (naive persistence, zero learned parameters). If this
        # RandomForest can't beat that, its route-specific inputs (distance,
        # AIS port activity) aren't earning their keep and callers should
        # know that honestly rather than silently trusting the prediction.
        naive_pred = te["bdry_proxy"].to_numpy()
        naive_mae = float(mean_absolute_error(te[target], naive_pred))
        naive_rmse = float(math.sqrt(mean_squared_error(te[target], naive_pred)))
        beats_naive = mae < naive_mae

        joblib.dump(model,out/f"route_model_h{h}.joblib")
        artifacts[h]=model
        metrics[str(h)]={
            "test_rows":int(len(te)),
            "test_period":{"start":str(te.month.min().date()),"end":str(te.month.max().date())},
            "mae_proxy_points":round(mae,4),
            "rmse_proxy_points":round(rmse,4),
            "naive_mae_proxy_points":round(naive_mae,4),
            "naive_rmse_proxy_points":round(naive_rmse,4),
            "improvement_pct_vs_naive_persistence":round((naive_mae-mae)/naive_mae*100,2) if naive_mae else None,
            "beats_naive_persistence":beats_naive,
            # Alias matching the field name route_freight_model.py and
            # app/utils.py already gate on, so callers can check one
            # consistent key regardless of which route model answered.
            "model_beats_baseline":beats_naive,
            "target":"next_h_month_bdry_market_proxy",
        }
    latest=df.sort_values("month").iloc[-1]["month"]
    total=len(metrics)
    failing=[h for h,m in metrics.items() if not m["model_beats_baseline"]]
    print("="*78)
    print("ROUTE MODEL (AIS-enhanced market proxy): baseline comparison (model vs. naive persistence)")
    print("="*78)
    for h,m in sorted(metrics.items(), key=lambda kv: int(kv[0])):
        status = "PASS" if m["model_beats_baseline"] else "FAIL — DOES NOT BEAT NAIVE PERSISTENCE"
        print(f"[{status}] H+{h}: model MAE={m['mae_proxy_points']} | naive MAE={m['naive_mae_proxy_points']} "
              f"(n={m['test_rows']}, {m['test_period']['start']}..{m['test_period']['end']})")
    print("-"*78)
    if failing:
        print(f"WARNING: {len(failing)}/{total} horizon(s) FAILED to beat naive persistence on held-out data. "
              "Callers should not silently trust these horizons — see model_beats_baseline in the metadata/response.")
    else:
        print(f"All {total} horizon(s) beat naive persistence on held-out data.")
    print("="*78)
    meta={
        "model_type":"AIS-enhanced route-level dry-bulk market proxy",
        "target_definition":"future BDRY ETF price proxy, NOT USD/ton freight rate",
        "route_features_source":"IMF PortWatch AIS-derived daily port activity, aggregated monthly",
        "feature_file":"data/production/route_monthly_features.csv",
        "training_period":{"start":str(df.month.min().date()),"end":str(df.month.max().date())},
        "latest_route_feature_month":str(latest.date()),
        "origins":ORIGINS,"destinations":DESTINATIONS,
        "numeric_features":NUMERIC,"categorical_features":CATEGORICAL,
        "metrics":metrics,
        "baseline_summary":{
            "total_horizon_models":total,
            "passed":total-len(failing),
            "failed":len(failing),
            "failed_horizons":[f"H+{h}" for h in failing],
        },
        "calibration":"If current_spot_rate_usd_per_ton is provided, projected_rate = spot_rate * predicted_proxy/current_proxy.",
        "direct_ais_status":"AISStream live integration available; PortWatch remains the historical AIS-derived training fallback when live events are unavailable.",
    }
    (out/"route_model_metadata.json").write_text(json.dumps(meta,indent=2))
    return meta

class RouteModel:
    def __init__(self, models_dir: str | Path | None = None):
        self.models_dir=Path(models_dir) if models_dir else MODELS
        self.meta=json.loads((self.models_dir/"route_model_metadata.json").read_text())
        self.route_freight = RouteFreightModel(self.models_dir) if RouteFreightModel else None
        self.models={h:joblib.load(self.models_dir/f"route_model_h{h}.joblib") for h in (1,2,3)
                      if (self.models_dir/f"route_model_h{h}.joblib").exists()}
        self.features=pd.read_csv(FEATURE_FILE,parse_dates=["month"])
        self.features["month_sin"]=np.sin(2*np.pi*self.features.month.dt.month/12)
        self.features["month_cos"]=np.cos(2*np.pi*self.features.month.dt.month/12)
        bdry_path=self.models_dir.parent/"data"/"production"/"bdry.csv"
        self.bdry=pd.read_csv(bdry_path,parse_dates=["date"]) if bdry_path.exists() else pd.DataFrame()
        if not self.bdry.empty:
            self.bdry["month"]=self.bdry["date"].dt.to_period("M").dt.to_timestamp()
            self.bdry=self.bdry.groupby("month",as_index=False)["bdry_close"].mean().rename(columns={"bdry_close":"bdry_proxy"})

    def _query_live_ais(self, origin, destination):
        """Best-effort live AISStream query for this route. Returns None if
        the collector isn't configured/enabled or the query fails — callers
        must not assume a None result means "no traffic", only "no live
        data available right now" (see _ais_freshness for the distinction)."""
        if ais_collector is not None and ais_collector.enabled:
            try:
                return ais_collector.route_features(origin, destination, lookback_hours=24)
            except Exception:
                return None
        return None

    def _ais_freshness(self, live):
        """Classify how current this route's AIS/PortWatch features actually
        are, against the real wall-clock date — never against the requested
        shipment date (see app/data_freshness.py for why)."""
        last_message_at = getattr(ais_collector, "last_message_at", None) if ais_collector is not None else None
        return classify_ais_freshness(
            live_ais=live,
            ais_collector_last_message_at=last_message_at,
            portwatch_latest_month=self.meta.get("latest_route_feature_month"),
        )

    def _row(self, origin, destination, when, live=None):
        when=pd.Timestamp(when)
        exact=self.features[(self.features.origin==origin)&(self.features.destination==destination)]
        if exact.empty:
            raise ValueError(f"Unknown route {origin} -> {destination}.")
        # For future dates beyond the AIS feature horizon, carry the latest
        # route-specific operational state forward and update seasonality.
        prior=exact[exact.month<=when]
        source_row=(prior.iloc[-1] if not prior.empty else exact.iloc[0]).copy()
        source_month=pd.Timestamp(source_row["month"])
        row=source_row.copy()
        row["month"]=when
        row["month_sin"]=math.sin(2*math.pi*when.month/12)
        row["month_cos"]=math.cos(2*math.pi*when.month/12)
        if live is not None:
            try:
                o, d = live["origin"], live["destination"]
                # Map live operational observations onto the same feature contract used
                # by the model. These are deliberately inference-time overrides; they
                # do not rewrite the historical training table.
                row.loc["origin_portcalls_dry_bulk"] = o["unique_vessels"]
                row.loc["origin_portcalls_cargo"] = o["unique_vessels"]
                row.loc["origin_portcalls"] = o["unique_vessels"]
                row.loc["destination_portcalls_dry_bulk"] = d["unique_vessels"]
                row.loc["destination_portcalls_cargo"] = d["unique_vessels"]
                row.loc["destination_portcalls"] = d["unique_vessels"]
                row.loc["origin_ais_coverage"] = min(1.0, o["ais_messages"] / 50.0)
                row.loc["destination_ais_coverage"] = min(1.0, d["ais_messages"] / 50.0)
            except Exception:
                live=None
        return pd.DataFrame([row]), source_month, live

    def predict(self, origin, destination, shipment_date, current_spot_rate_usd_per_ton=None, commodity=None):
        # Freshness is assessed once per request and attached to every
        # response path below — including the direct route-freight path,
        # since route-level operational features (idle/congestion advice
        # elsewhere) still depend on how current the AIS/PortWatch inputs
        # actually are, independent of which model supplied the rate.
        live = self._query_live_ais(origin, destination)
        ais_status = self._ais_freshness(live)

        # Prefer a trained model whose target is an actual verified route-rate
        # observation. Exact route matching is intentional; no unrelated
        # destination/commodity row is substituted.
        if self.route_freight is not None:
            try:
                direct = self.route_freight.predict(origin, destination, shipment_date, commodity=commodity)
            except TypeError:
                # Backward-compatible support for lightweight test doubles / older route model adapters.
                direct = self.route_freight.predict(origin, destination, shipment_date)
            if direct is not None and direct.get("model_beats_baseline") is False:
                direct = None
            if direct is not None:
                direct["current_spot_rate_usd_per_ton"] = current_spot_rate_usd_per_ton
                direct["ais"] = ais_status.to_dict()
                for item in direct.get("forecasts", []):
                    if current_spot_rate_usd_per_ton is not None:
                        item["current_spot_rate_usd_per_ton"] = float(current_spot_rate_usd_per_ton)
                return direct

        # No lane-specific synthetic exception lives here. If a route does not
        # have an eligible direct route-freight model, use the shared AIS/BDRY
        # route-level market-proxy model below. This keeps every synthetic lane
        # on the same route-freight data contract.
        row,source_month,live=self._row(origin,destination,shipment_date,live=live)
        current_proxy=float(row["bdry_proxy"].iloc[0])
        if not self.bdry.empty:
            eligible=self.bdry[self.bdry["month"]<=pd.Timestamp(shipment_date)]
            if not eligible.empty:
                current_proxy=float(eligible.iloc[-1]["bdry_proxy"])
                row.loc[:, "bdry_proxy"]=current_proxy
        out=[]
        for h,model in self.models.items():
            pred=float(model.predict(row[NUMERIC+CATEGORICAL])[0])
            pct=(pred-current_proxy)/current_proxy if current_proxy else 0.0
            # Never silently trust a losing model: surface the same
            # naive-persistence guardrail here that route_freight_model.py
            # and train.py already expose, per horizon.
            horizon_metrics=self.meta.get("metrics",{}).get(str(h),{})
            model_beats_baseline=horizon_metrics.get("model_beats_baseline")
            item={"horizon_months":h,"predicted_market_proxy":round(pred,4),
                  "proxy_change_pct":round(pct*100,3),
                  "route_feature_month":str(source_month.date()),
                  "model_beats_baseline": model_beats_baseline,
                  "naive_mae_proxy_points": horizon_metrics.get("naive_mae_proxy_points"),
                  "model_mae_proxy_points": horizon_metrics.get("mae_proxy_points")}
            if current_spot_rate_usd_per_ton is not None:
                spot=float(current_spot_rate_usd_per_ton)
                item["indicative_route_rate_usd_per_ton"]=round(spot*(1+pct),2)
            out.append(item)
        h1_beats_baseline=next((f.get("model_beats_baseline") for f in out if f["horizon_months"]==1),None)
        disclaimer="Route-level operational features are AIS-derived, but historical route freight-rate labels are not present. USD/t is indicative only when calibrated from a user-supplied current spot rate."
        if not h1_beats_baseline:
            disclaimer += " This model did not beat naive persistence (assume no change) on held-out data for the H+1 horizon — treat it as low-confidence."
        if ais_status.status in ("stale", "unavailable"):
            disclaimer += f" {ais_status.note}"
        return {
            "route":f"{origin}-{destination}",
            "forecast_type":"ais_enhanced_route_proxy",
            "current_market_proxy":round(current_proxy,4),
            "current_spot_rate_usd_per_ton":current_spot_rate_usd_per_ton,
            "forecasts":out,
            "model_beats_baseline":h1_beats_baseline,
            # LIVE / RECENT / STALE / UNAVAILABLE — see app/data_freshness.py.
            # Always reflects the real age of the underlying data against
            # today's actual date, never against the requested shipment_date.
            "ais":ais_status.to_dict(),
            "disclaimer":disclaimer,
        }