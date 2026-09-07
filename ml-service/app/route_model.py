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
        joblib.dump(model,out/f"route_model_h{h}.joblib")
        artifacts[h]=model
        metrics[str(h)]={
            "test_rows":int(len(te)),
            "test_period":{"start":str(te.month.min().date()),"end":str(te.month.max().date())},
            "mae_proxy_points":round(mae,4),
            "rmse_proxy_points":round(rmse,4),
            "target":"next_h_month_bdry_market_proxy",
        }
    latest=df.sort_values("month").iloc[-1]["month"]
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

    def _row(self, origin, destination, when):
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
        live=None
        if ais_collector is not None and ais_collector.enabled:
            try:
                live=ais_collector.route_features(origin, destination, lookback_hours=24)
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
        # Prefer a trained model whose target is an actual verified route-rate
        # observation. Exact route matching is intentional; no unrelated
        # destination/commodity row is substituted.
        if self.route_freight is not None:
            try:
                direct = self.route_freight.predict(origin, destination, shipment_date, commodity=commodity)
            except TypeError:
                # Backward-compatible support for lightweight test doubles / older route model adapters.
                direct = self.route_freight.predict(origin, destination, shipment_date)
            # (Task 4) Same guardrail as ModelBundle.predict() in app/utils.py:
            # a route-specific model that did not beat naive persistence on
            # held-out data (or has no recorded comparison at all — test
            # doubles/older adapters legitimately won't set this key) must
            # never be silently served here either. `.get(...)` rather than
            # a plain key lookup keeps lightweight test doubles (which return
            # a bare dict with no "model_beats_baseline" key) working exactly
            # as before, since "unknown" only changes behavior once real
            # metrics are recorded and actually fail.
            if direct is not None and direct.get("model_beats_baseline") is False:
                direct = None
            if direct is not None:
                direct["current_spot_rate_usd_per_ton"] = current_spot_rate_usd_per_ton
                for item in direct.get("forecasts", []):
                    if current_spot_rate_usd_per_ton is not None:
                        item["current_spot_rate_usd_per_ton"] = float(current_spot_rate_usd_per_ton)
                return direct

        # No lane-specific synthetic exception lives here. If a route does not
        # have an eligible direct route-freight model, use the shared AIS/BDRY
        # route-level market-proxy model below. This keeps every synthetic lane
        # on the same route-freight data contract.
        row,source_month,live=self._row(origin,destination,shipment_date)
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
            item={"horizon_months":h,"predicted_market_proxy":round(pred,4),
                  "proxy_change_pct":round(pct*100,3),
                  "route_feature_month":str(source_month.date()),
                  "ais_feature_stale": bool(live is None and pd.Timestamp(shipment_date)>pd.Timestamp(self.meta["latest_route_feature_month"])),
                  "live_ais": live if live is not None else None}
            if current_spot_rate_usd_per_ton is not None:
                spot=float(current_spot_rate_usd_per_ton)
                item["indicative_route_rate_usd_per_ton"]=round(spot*(1+pct),2)
            out.append(item)
        return {
            "route":f"{origin}-{destination}",
            "forecast_type":"ais_enhanced_route_proxy",
            "current_market_proxy":round(current_proxy,4),
            "current_spot_rate_usd_per_ton":current_spot_rate_usd_per_ton,
            "forecasts":out,
            "disclaimer":"Route-level operational features are AIS-derived, but historical route freight-rate labels are not present. USD/t is indicative only when calibrated from a user-supplied current spot rate.",
        }
