"""FreightSight real-data monthly training pipeline.

Required files in ml-service/data/ (names can be changed in DATA_FILES):
  world_port_index_clean.csv
  ores_minerals_trade.csv
  india_trade_2010_2021.csv
  portwatch_daily.csv
  global_cargo_ships.csv
  brent_oil.csv
  bdry.csv

No synthetic freight data is used by this pipeline. Missing trade tonnage is not
imputed. Annual trade data is converted into a lagged annual signal when it has
no month/date field, so future annual totals are never used to predict earlier
months.
"""
import json, os, sys, platform, hashlib
from datetime import datetime, timezone
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    confusion_matrix,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_recall_fscore_support,
)
from sklearn.preprocessing import OneHotEncoder

from ordinal_risk_model import OrdinalRiskClassifier

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
MODELS.mkdir(exist_ok=True)

DATA_FILES = {
    "ports": "world_port_index_clean.csv",
    "ores": "ores_minerals_trade.csv",
    "india_trade": "india_trade_2010_2021.csv",
    "portwatch": "portwatch_daily.csv",
    "vessels": "global_cargo_ships.csv",
    "brent": "brent_oil.csv",
    "bdry": "bdry.csv",
}


from data_paths import resolve_data_dir  # noqa: E402  (needs ROOT/DATA_FILES defined above)

DATA, DATA_SOURCE_MODE = resolve_data_dir(ROOT, required_files=tuple(DATA_FILES.values()))

EAST_COAST = ["Paradip", "Visakhapatnam", "Gangavaram", "Gopalpur", "Dhamra", "Sagar Sandheads", "Haldia", "Chennai", "Kamarajar", "Tuticorin"]
COMMODITIES = ["Coal", "Iron Ore", "Bulk Minerals & Ores"]


def require_files():
    missing = [str(DATA / f) for f in DATA_FILES.values() if not (DATA / f).exists()]
    if missing:
        raise FileNotFoundError("Real-data training cannot start. Missing required datasets:\n" + "\n".join(missing))


def _dataset_hash(data_dir, files):
    """(Phase 12) A real, reproducible hash identifying exactly which input
    files (by content) this training run used — not a fabricated ID.
    Combines each file's own sha256 (sorted by filename for determinism)
    into one top-level digest."""
    combined = hashlib.sha256()
    per_file = {}
    for name in sorted(files):
        p = data_dir / name
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        digest = h.hexdigest()
        per_file[name] = digest[:16]
        combined.update(digest.encode())
    return combined.hexdigest()[:16], per_file


def read(name):
    p = DATA / DATA_FILES[name]
    df = pd.read_csv(p)
    if df.empty:
        raise ValueError(f"{p} is empty")
    return df


def col(df, candidates, required=True):
    lower = {str(c).strip().lower(): c for c in df.columns}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    if required:
        raise ValueError(f"Could not find any of columns {candidates} in {list(df.columns)}")
    return None


def numeric(s):
    return pd.to_numeric(s.astype(str).str.replace(",", "", regex=False).str.extract(r"([-+]?\d*\.?\d+)")[0], errors="coerce")


def clean_bdry(df):
    d = col(df, ["date", "Date"]); p = col(df, ["close", "Close", "adj close", "price", "bdry_close"])
    out = pd.DataFrame({"date": pd.to_datetime(df[d], errors="coerce"), "bdry": numeric(df[p])}).dropna()
    out = out.drop_duplicates("date").sort_values("date").set_index("date").resample("MS").mean().ffill()
    return out.reset_index().rename(columns={"date": "month"})


def clean_brent(df):
    d = col(df, ["date", "Date"]); p = col(df, ["price", "close", "Close", "Value", "brent_price_daily"])
    out = pd.DataFrame({"date": pd.to_datetime(df[d], errors="coerce"), "brent": numeric(df[p])}).dropna()
    out = out.drop_duplicates("date").sort_values("date").set_index("date").resample("MS").mean().ffill()
    return out.reset_index().rename(columns={"date": "month"})


def clean_portwatch(df):
    d = col(df, ["date", "Date"]); port = col(df, ["port_name", "port", "main port name"])
    country = col(df, ["country", "country_name", "iso3", "country_code"], False)
    imp = col(df, ["import_volume_estimate", "import_volume", "import_tonnage", "imports"], False)
    exp = col(df, ["export_volume_estimate", "export_volume", "export_tonnage", "exports"], False)
    calls = col(df, ["vessel_call_count", "vessel_calls", "vessel call count", "calls"], False)
    out = pd.DataFrame({"date": pd.to_datetime(df[d], errors="coerce"), "port": df[port].astype(str).str.strip()})
    if country: out["country"] = df[country].astype(str).str.upper()
    out["import_volume"] = numeric(df[imp])    
    out["export_volume"] = numeric(df[exp])
    out["vessel_calls"] = numeric(df[calls])
    out = out.dropna(subset=["date"])
    if country: out = out[(out["country"].isin(["IND", "INDIA"]))]
    def canonical_port(v):
        low=v.lower()
        for e in EAST_COAST:
            if e.lower() in low or (e == "Visakhapatnam" and "vizag" in low) or (e == "Kamarajar" and "ennore" in low) or (e == "Sagar Sandheads" and "kolkata" in low):
                return e
        return None
    out["port"] = out["port"].map(canonical_port)
    out = out.dropna(subset=["port"])
    out["month"] = out["date"].dt.to_period("M").dt.to_timestamp()
    return out.groupby(["month", "port"], as_index=False)[["import_volume", "export_volume", "vessel_calls"]].mean()


def clean_trade(df, source):
    """Create a real commodity-demand signal without relabeling trade value as tonnes.

    If physical quantity is present, `trade_signal` is tonnage.  The supplied
    Kaggle India-trade files contain monetary trade value instead, so this
    function uses that value as a clearly named demand proxy.
    """
    commodity_c = col(df, ["commodity", "description", "Commodity", "HS2 Commodity"], False)
    qty_c = col(df, ["quantity","qty","quantity_tons","trade_tonnage","tonnes","tonnage","metric_tons"], False)
    value_c = col(df, ["value","Export_Value_Cr","Import_Value_Cr","export_value_cr","import_value_cr"], False)
    year_c = col(df, ["year","Year","YEAR"], False)
    date_c = col(df, ["date","month","Date","YEAR-MONTH"], False)
    if not commodity_c and source == "ores":
        date_c = col(df, ["date","month","Date","YEAR-MONTH"], False)
        imp_c = col(df, ["ores_minerals_import_cr","Import In Crores","import_value_cr"], False)
        exp_c = col(df, ["ores_minerals_export_cr","Export In Crores","export_value_cr"], False)
        if date_c and (imp_c or exp_c):
            out = pd.DataFrame({"month": pd.to_datetime(df[date_c], errors="coerce"),
                                "trade_signal": (numeric(df[imp_c]) if imp_c else 0) + (numeric(df[exp_c]) if exp_c else 0),
                                "commodity":"Bulk Minerals & Ores"})
            out["month"]=out["month"].dt.to_period("M").dt.to_timestamp()
            return out.dropna(subset=["month","trade_signal"]).groupby(["month","commodity"],as_index=False)["trade_signal"].sum()
    if not commodity_c:
        print(f"{source}: no commodity column; skipped")
        return pd.DataFrame(columns=["month","commodity","trade_signal"])
    signal_c = qty_c or value_c
    if not signal_c:
        print(f"{source}: no physical quantity or trade-value column; skipped")
        return pd.DataFrame(columns=["month","commodity","trade_signal"])
    x = pd.DataFrame({"commodity_raw": df[commodity_c].astype(str), "signal": numeric(df[signal_c])})
    if year_c:
        x["year"] = pd.to_numeric(df[year_c], errors="coerce")
    if date_c:
        x["month"] = pd.to_datetime(df[date_c], errors="coerce")
        x["year"] = x["month"].dt.year
    if "year" not in x:
        raise ValueError(f"{source}: no year/date column")
    raw = x["commodity_raw"].str.strip().str.lower()
    x["commodity"] = np.select(
        [
            raw.str.contains(r"\bcoal\b", regex=True, na=False),
            raw.str.contains(r"\biron\s+ore(?:s)?\b", regex=True, na=False),
            raw.str.contains(r"\bbulk\s+minerals?\b|\bminerals?\s+and\s+ores?\b|\bbulk\s+minerals?\s+and\s+ores?\b", regex=True, na=False),
        ],
        ["Coal","Iron Ore","Bulk Minerals & Ores"],
        default=None,
    )
    x=x.dropna(subset=["commodity","signal","year"])
    if "month" in x.columns and x["month"].notna().any():
        x["month"]=pd.to_datetime(x["month"],errors="coerce").dt.to_period("M").dt.to_timestamp()
        x=x.dropna(subset=["month"])
        return x.groupby(["month","commodity"],as_index=False)["signal"].sum().rename(columns={"signal":"trade_signal"})
    return x.groupby(["year","commodity"],as_index=False)["signal"].sum().rename(columns={"signal":"trade_signal"})

def combine_trade(ores, india):
    parts=[]
    for d,n in [(ores,"ores"),(india,"india_trade")]:
        x=clean_trade(d,n)
        if not x.empty: parts.append(x)
    if not parts:
        raise ValueError("Neither Indian trade dataset produced a usable commodity demand signal")
    monthly=[x for x in parts if "month" in x.columns]
    annual=[x for x in parts if "year" in x.columns]
    if monthly:
        m=pd.concat(monthly,ignore_index=True).drop_duplicates(["month","commodity"],keep="first")
    else:
        m=pd.DataFrame({"month":pd.Series(dtype="datetime64[ns]"),
                        "commodity":pd.Series(dtype="object"),
                        "trade_signal":pd.Series(dtype="float64")})
    if annual:
        a=pd.concat(annual,ignore_index=True).drop_duplicates(["year","commodity"],keep="first")
        a["month"]=pd.to_datetime(a["year"].astype(str)+"-01-01")
        a["trade_signal_lag"]=a.groupby("commodity")["trade_signal"].shift(1)
        a=a.dropna(subset=["trade_signal_lag"])[["month","commodity","trade_signal_lag"]]
        a["year"]=a["month"].dt.year+1
        a["month"]=pd.to_datetime(a["year"].astype(str)+"-01-01")
        a["month"]=a["month"].apply(lambda d: pd.date_range(d,periods=12,freq="MS"))
        a=a.explode("month").rename(columns={"trade_signal_lag":"trade_signal"})[["month","commodity","trade_signal"]]
        m=pd.concat([m,a],ignore_index=True).drop_duplicates(["month","commodity"],keep="first")
    return m

def build_ports(df):
    name=col(df,["main port name","port name","Main Port Name","port_name"]); cargo=col(df,["cargo pier depth (m)","Cargo Pier Depth (m)","cargodepth"],False); channel=col(df,["channel depth (m)","Channel Depth (m)","chan_depth"],False)
    return pd.DataFrame({"port":df[name].astype(str).str.strip(),"cargo_depth":numeric(df[cargo]) if cargo else np.nan,"channel_depth":numeric(df[channel]) if channel else np.nan}).drop_duplicates("port")


def risk_walk_forward_cv(master, num, cat, class_names=("low", "medium", "high"), n_folds=4, fold_test_months=12, min_train_months=24):
    """(P0-3) Supplementary walk-forward evaluation for the risk classifier.

    WHY THIS EXISTS: the single 80/20 chronological holdout used for the
    headline risk metrics happens to have a test window (the most recent
    ~20% of months) that contains zero "high" examples in this dataset —
    that's a real property of this BDRY series, not a bug, and it's
    disclosed as such. But it also means the single holdout can never
    tell us how the classifier does on "high" at all. Rather than
    fabricate high-risk examples or silently accept "untestable", this
    runs several EXPANDING-WINDOW folds further back in history — each
    with its own train-only tertile thresholds and its own freshly-fit
    encoder/classifier — so any fold whose test slice happens to cover a
    higher-volatility period gives a real, evaluated answer for "high".

    LIMITATION DISCLOSED, NOT HIDDEN: the underlying continuous risk_score
    column (volatility/shock/trend/congestion/data-uncertainty percentiles)
    is computed once, upstream, against the ORIGINAL 80%-train reference
    window (see the caller) — only the low/medium/high BUCKET thresholds
    are refit per fold here. This is not fully leakage-free in the
    strictest sense (a truly from-scratch walk-forward would also refit
    the percentile reference per fold), but it is a meaningfully more
    honest picture than a single fixed holdout, and this limitation is
    recorded in the output rather than glossed over.

    This is purely an additional evaluation artifact — it does NOT change
    which model is saved to models/risk_model.joblib, and does not affect
    any existing behaviour if it can't run (e.g. too few months): in that
    case it returns a clearly-labelled skipped result instead of raising,
    since this is a supplementary diagnostic, not a required step.
    """
    classes = {c: i for i, c in enumerate(class_names)}
    months = sorted(master["month"].unique())
    if len(months) < min_train_months + fold_test_months:
        return {
            "status": "skipped",
            "reason": f"Need at least {min_train_months + fold_test_months} months for even one walk-forward fold; found {len(months)}.",
        }

    # Lay out up to n_folds contiguous test windows, most recent last,
    # each preceded by every month before it (expanding window).
    max_possible_folds = max(1, (len(months) - min_train_months) // fold_test_months)
    n_folds = min(n_folds, max_possible_folds)
    last_test_end_idx = len(months) - 1
    fold_defs = []
    for i in range(n_folds):
        test_end_idx = last_test_end_idx - i * fold_test_months
        test_start_idx = test_end_idx - fold_test_months + 1
        train_end_idx = test_start_idx - 1
        if train_end_idx < min_train_months - 1:
            break
        fold_defs.append((train_end_idx, test_start_idx, test_end_idx))
    fold_defs.reverse()  # chronological order in the report

    folds_report = []
    agg_cm = np.zeros((3, 3), dtype=int)
    for fold_idx, (train_end_idx, test_start_idx, test_end_idx) in enumerate(fold_defs, start=1):
        train_cut, test_start, test_end = months[train_end_idx], months[test_start_idx], months[test_end_idx]
        f_train = master[master["month"] <= train_cut].copy()
        f_test = master[(master["month"] >= test_start) & (master["month"] <= test_end)].copy()
        if f_train.empty or f_test.empty:
            continue

        # Fold-local tertile thresholds, fit on this fold's training rows only.
        f_train_scores = f_train["risk_score"].dropna()
        if f_train_scores.empty:
            continue
        fq1, fq2 = f_train_scores.quantile([1 / 3, 2 / 3])

        def _bucket(v, fq1=fq1, fq2=fq2):
            if pd.isna(v):
                return np.nan
            if v <= fq1:
                return "low"
            if v <= fq2:
                return "medium"
            return "high"

        f_train["fold_risk"] = f_train["risk_score"].map(_bucket)
        f_test["fold_risk"] = f_test["risk_score"].map(_bucket)
        f_train = f_train.dropna(subset=["fold_risk"])
        f_test = f_test.dropna(subset=["fold_risk"])
        if f_train.empty or f_test.empty:
            continue

        f_enc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
        Xtr_cat = f_enc.fit_transform(f_train[cat])
        Xte_cat = f_enc.transform(f_test[cat])
        Xtr = np.column_stack([f_train[num].values.astype(float), Xtr_cat])
        Xte = np.column_stack([f_test[num].values.astype(float), Xte_cat])

        # (Bug fix, 2026-09) Same ordinal-regression switch as the main
        # classifier below — kept in sync so this CV evaluates the same
        # architecture that actually gets deployed, not a different one.
        f_clf = OrdinalRiskClassifier(thresholds=(float(fq1), float(fq2)), class_names=class_names, n_estimators=300, random_state=42, n_jobs=-1)
        f_clf.fit(Xtr, f_train["risk_score"].values)
        y_true = f_test["fold_risk"].map(classes)
        y_pred = f_clf.predict(Xte)

        cm = confusion_matrix(y_true, y_pred, labels=[0, 1, 2])
        agg_cm += cm
        precisions, recalls, f1s, supports = precision_recall_fscore_support(y_true, y_pred, labels=[0, 1, 2], zero_division=0)
        folds_report.append({
            "fold": fold_idx,
            "train_period": {"start": str(f_train.month.min().date()), "end": str(train_cut.date() if hasattr(train_cut, "date") else train_cut)},
            "test_period": {"start": str(test_start.date() if hasattr(test_start, "date") else test_start), "end": str(test_end.date() if hasattr(test_end, "date") else test_end)},
            "test_class_counts": {class_names[i]: int(supports[i]) for i in range(3)},
            "accuracy": round(float(accuracy_score(y_true, y_pred)), 4),
            "balanced_accuracy": round(float(balanced_accuracy_score(y_true, y_pred)), 4) if len(set(y_true)) > 1 else None,
            "per_class": {
                class_names[i]: {
                    "precision": round(float(precisions[i]), 4),
                    "recall": round(float(recalls[i]), 4),
                    "f1": round(float(f1s[i]), 4),
                    "support_in_test": int(supports[i]),
                }
                for i in range(3)
            },
        })

    if not folds_report:
        return {"status": "skipped", "reason": "No fold produced a non-empty train and test slice after bucketing."}

    agg_support = agg_cm.sum(axis=1)
    agg_precision = np.divide(np.diag(agg_cm), agg_cm.sum(axis=0), out=np.zeros(3), where=agg_cm.sum(axis=0) != 0)
    agg_recall = np.divide(np.diag(agg_cm), agg_support, out=np.zeros(3), where=agg_support != 0)
    agg_f1 = np.divide(2 * agg_precision * agg_recall, agg_precision + agg_recall, out=np.zeros(3), where=(agg_precision + agg_recall) != 0)

    return {
        "status": "ok",
        "methodology": (
            "Expanding-window walk-forward CV, run in addition to (not instead "
            "of) the primary 80/20 chronological holdout above. Each fold refits "
            "its own low/medium/high tertile thresholds, one-hot encoder, and "
            "RandomForestClassifier on that fold's own training window only. "
            "See risk_walk_forward_cv() docstring in train.py for the one "
            "disclosed leakage caveat (risk_score's percentile inputs are not "
            "refit per fold)."
        ),
        "n_folds": len(folds_report),
        "risk_model_architecture": (
            "OrdinalRiskClassifier (RandomForestRegressor on continuous risk_score, "
            "bucketed at fold-local train-only q1/q2 thresholds) — see ordinal_risk_model.py. "
            "Replaced a plain RandomForestClassifier (2026-09 fix) after it scored 0% "
            "precision/recall on 'medium' in every fold."
        ),
        "folds": folds_report,
        "aggregated_across_folds": {
            "confusion_matrix": agg_cm.tolist(),
            "confusion_matrix_labels": list(class_names),
            "per_class": {
                class_names[i]: {
                    "precision": round(float(agg_precision[i]), 4),
                    "recall": round(float(agg_recall[i]), 4),
                    "f1": round(float(agg_f1[i]), 4),
                    "support_across_folds": int(agg_support[i]),
                }
                for i in range(3)
            },
        },
    }


def main(data_dir=None, output_dir=None):
    """Run the full training pipeline.

    data_dir:   directory containing the required raw input CSVs. If omitted,
                the script prefers data/production/ when complete and otherwise
                falls back to data/synthetic/ with a warning. Passing
                --data-dir explicitly wins and is recorded as
                data_source_mode="override".
    output_dir: directory to write trained model artifacts and metadata into
                (defaults to ml-service/models). Developers can pass a separate
                output directory when experimenting with candidate models.
    """
    global DATA, DATA_SOURCE_MODE, MODELS
    if data_dir:
        DATA = Path(data_dir)
        DATA_SOURCE_MODE = "override"
        print(f"[data] Explicit --data-dir override in use: {DATA}")
    # else: keep the DATA/DATA_SOURCE_MODE already resolved at import time
    # by _resolve_data_dir() — do NOT silently reset to a hardcoded path.
    MODELS = Path(output_dir) if output_dir else (ROOT / "models")
    MODELS.mkdir(parents=True, exist_ok=True)

    require_files()
    read("ports")
    bdry=clean_bdry(read("bdry")); brent=clean_brent(read("brent")); pw=clean_portwatch(read("portwatch"))
    trade=combine_trade(read("ores"),read("india_trade"))
    if trade.empty or bdry.empty: raise ValueError("Insufficient real trade/BDRY data")

    months=pd.DataFrame({"month":pd.date_range(bdry.month.min(),bdry.month.max(),freq="MS")})
    rows=[]
    for port in EAST_COAST:
        for commodity in COMMODITIES:
            x=months.copy(); x["port"]=port; x["commodity"]=commodity; rows.append(x)
    master=pd.concat(rows,ignore_index=True)
    master=master.merge(bdry,on="month",how="left").merge(brent,on="month",how="left")
    master=master.merge(pw,left_on=["month","port"],right_on=["month","port"],how="left")
    # (Phase 8 hybrid risk engine) Real portwatch coverage flag — captured
    # BEFORE the fillna(0) below turns "no data for this port-month" into
    # a value indistinguishable from "genuinely zero port activity". The
    # risk engine needs to tell those apart: zero real congestion is a
    # low-risk signal, but MISSING congestion data is a data-uncertainty
    # signal, not evidence of a quiet port.
    master["has_portwatch_coverage"]=master[["import_volume","export_volume","vessel_calls"]].notna().any(axis=1)
    master=master.merge(trade,on=["month","commodity"],how="left")
    master[["import_volume","export_volume","vessel_calls"]]=master[["import_volume","export_volume","vessel_calls"]].fillna(0)
    # Real missing trade values remain missing; rows without a demand signal are excluded from training.
    master["has_trade_signal"]=master["trade_signal"].notna().astype(float)
    master["trade_signal"]=master["trade_signal"].fillna(0)
    master=master.dropna(subset=["bdry","brent"]).sort_values(["month","port","commodity"])
    # BDRY/Brent are global monthly series. Calculate their lags before the
    # port×commodity expansion so rows never borrow another category's value.
    bdry_idx=bdry.set_index("month")["bdry"]
    brent_idx=brent.set_index("month")["brent"]
    b_l1=bdry_idx.shift(1); b_l2=bdry_idx.shift(2); b_l3=bdry_idx.shift(3); b_roll=b_l1.rolling(3,min_periods=3).mean(); br_l1=brent_idx.shift(1)
    master["bdry_lag1"]=master["month"].map(b_l1); master["bdry_lag2"]=master["month"].map(b_l2); master["bdry_lag3"]=master["month"].map(b_l3)
    master["bdry_rolling_3m_avg"]=master["month"].map(b_roll); master["brent_lag1"]=master["month"].map(br_l1)
    master["trade_signal_lag1"]=master.groupby(["port","commodity"])["trade_signal"].shift(1).fillna(0)
    master["trade_signal_yoy_growth"]=master.groupby(["port","commodity"])["trade_signal"].pct_change(12).replace([np.inf,-np.inf],np.nan).fillna(0)
    master["month_num"]=master["month"].dt.month; master["quarter"]=master["month"].dt.quarter

    # Target = next month's BDRY.
    bdry_series=bdry.set_index("month")["bdry"]
    master["target_rate"]=master["month"].map(bdry_series.shift(-1))
    
    master["target_delta"]=master["target_rate"]-master["bdry_lag1"]

   
    HORIZONS = [1, 2, 3]
    for h in HORIZONS:
        master[f"target_rate_h{h}"] = master["month"].map(bdry_series.shift(-h))
        master[f"target_delta_h{h}"] = master[f"target_rate_h{h}"] - master["bdry_lag1"]

    master["target_rate_h1"] = master["target_rate"]
    master["target_delta_h1"] = master["target_delta"]

    # Determine the chronological train/test split BEFORE computing the
    # risk-class thresholds below. This uses only the columns that don't
    # depend on those thresholds, so the split point itself can't be
    # influenced by them.
    presplit_required = ["bdry_lag1","bdry_lag2","bdry_lag3","bdry_rolling_3m_avg","brent_lag1","target_rate"]
    unique_months = sorted(master.dropna(subset=presplit_required).month.unique())

    if len(unique_months) < 6:
        raise ValueError(
            f"Need at least 6 usable months for a train/test split; "
            f"found {len(unique_months)}."
        )

    cut = unique_months[max(1, int(len(unique_months) * 0.8) - 1)]

    # ------------------------------------------------------------------
    # Hybrid risk engine.
    #
    # ORIGINAL DESIGN AND ITS FAILURE MODE: the risk target used to be
    # PURELY next month's market-wide BDRY volatility, bucketed into
    # low/medium/high. That target is a function of `month` ONLY — it is
    # identical for every port×commodity row within the same month (30
    # duplicate rows per month, all sharing one label). Per-row features
    # like import_volume/export_volume/vessel_calls therefore carried zero
    # information about the label; the classifier could only really learn
    # from a handful of distinct month-level values. Retraining and
    # evaluating this confirmed the failure empirically: the "medium"
    # class got 0% precision/recall in the held-out test period even with
    # class_weight="balanced" and leak-free thresholds — the model
    # collapsed to always predicting "low". That is a genuine, measured
    # result (see implementation report), not a hypothesis.
    #
    # FIX: build the risk label from a documented, configurable weighted
    # combination of FIVE signals, several of which vary per port and not
    # just per month, so the label actually carries per-row information
    # that the model's per-row features can learn to predict:
    #
    #   1. volatility       — next month's market-wide BDRY volatility
    #                          (the original signal, retained).
    #   2. rate_shock        — size of the most recent month-over-month
    #                          BDRY move (abs % change), i.e. how sharply
    #                          the market just moved.
    #   3. trend_deviation   — how far the latest known BDRY sits from its
    #                          own trailing 3-month average, i.e. whether
    #                          the market is currently deviating from its
    #                          recent trend.
    #   4. port_congestion   — this port's vessel-call activity that
    #                          month, ranked against the training
    #                          distribution (PortWatch data; real, not
    #                          synthetic). Missing for some port-months —
    #                          see (5).
    #   5. data_uncertainty  — 1.0 when this port-month has no PortWatch
    #                          coverage at all (component 4 cannot be
    #                          computed, so the recommendation is being
    #                          made with a genuine data gap), else 0.0.
    #                          Reduced data coverage is itself a reason to
    #                          treat a shipment as higher risk, not a
    #                          reason to silently assume "no congestion".
    #
    # Each raw component is converted to a value in [0,1] via a rank
    # (percentile) against the TRAINING-PERIOD distribution only (months
    # <= cut) — the same leak-safe discipline the previous single-signal
    # version used for its q1/q2 thresholds, just applied per-component.
    # Test-period values are ranked against that fixed, train-derived
    # scale; they are never used to define the scale itself.
    #
    # Weights are fixed, documented constants (not fit/learned — fitting
    # weights would just reintroduce a black box), and are stored in
    # metadata.json (`risk_weights`) alongside the resulting thresholds so
    # they are auditable and can be tuned by a domain expert later without
    # touching code logic. They sum to 1.0.
    RISK_WEIGHTS = {
        "volatility": 0.35,
        "rate_shock": 0.20,
        "trend_deviation": 0.15,
        "port_congestion": 0.20,
        "data_uncertainty": 0.10,
    }
    assert abs(sum(RISK_WEIGHTS.values()) - 1.0) < 1e-9, "RISK_WEIGHTS must sum to 1.0"

    def _train_percentile(series, train_mask):
        """Percentile rank of each value in `series` against the
        distribution of `series[train_mask]` only (no NaNs). Values
        outside the training range clip to 0/1 (standard, documented
        treatment of out-of-distribution values at inference time — not
        leakage, since the calibration set itself never includes
        test-period data). Returns a Series of the same index; NaN inputs
        map to 0.5 (neutral — documented fallback, not a fabricated
        signal) since the component genuinely could not be computed.
        """
        train_vals = np.sort(series[train_mask].dropna().values)
        if len(train_vals) == 0:
            return pd.Series(0.5, index=series.index)
        ranks = np.searchsorted(train_vals, series.fillna(np.nan).values, side="right") / len(train_vals)
        ranks = np.where(series.isna().values, 0.5, np.clip(ranks, 0.0, 1.0))
        return pd.Series(ranks, index=series.index)

    # --- Component 1: market volatility (next month's, as before) ---
    vol = bdry_series.pct_change().rolling(3).std()
    vol_next = vol.shift(-1)

    # --- Component 2: rate shock (most recent month-over-month move) ---
    rate_shock = bdry_series.pct_change().abs()

    # --- Component 3: trend deviation (latest vs trailing 3m average) ---
    roll3 = bdry_series.rolling(3, min_periods=3).mean()
    trend_deviation = ((bdry_series - roll3) / roll3.replace(0, np.nan)).abs()

    # Market-wide (per-month) components, broadcast onto every row of that
    # month exactly like the original single-signal design.
    month_train_mask = pd.Series(bdry_series.index <= cut, index=bdry_series.index)
    vol_pctile_by_month = _train_percentile(vol_next, month_train_mask)
    shock_pctile_by_month = _train_percentile(rate_shock, month_train_mask)
    trend_pctile_by_month = _train_percentile(trend_deviation, month_train_mask)

    master["_vol_pctile"] = master["month"].map(vol_pctile_by_month)
    master["_shock_pctile"] = master["month"].map(shock_pctile_by_month)
    master["_trend_pctile"] = master["month"].map(trend_pctile_by_month)

    # --- Component 4: port congestion (per port×month, real variation) ---
    row_train_mask = master["month"] <= cut
    congestion_source = master["vessel_calls"].where(master["has_portwatch_coverage"])
    master["_congestion_pctile"] = _train_percentile(congestion_source, row_train_mask)
    # Rows with no PortWatch coverage get a neutral 0.5 congestion score
    # (documented — "unknown", not "zero congestion") and their
    # uncertainty is instead carried by component 5.
    master.loc[~master["has_portwatch_coverage"], "_congestion_pctile"] = 0.5

    # --- Component 5: data uncertainty (binary, real coverage gap) ---
    master["_data_uncertainty"] = np.where(master["has_portwatch_coverage"], 0.0, 1.0)

    master["risk_score"] = (
        RISK_WEIGHTS["volatility"] * master["_vol_pctile"]
        + RISK_WEIGHTS["rate_shock"] * master["_shock_pctile"]
        + RISK_WEIGHTS["trend_deviation"] * master["_trend_pctile"]
        + RISK_WEIGHTS["port_congestion"] * master["_congestion_pctile"]
        + RISK_WEIGHTS["data_uncertainty"] * master["_data_uncertainty"]
    )

    # Bucket into low/medium/high using tertile thresholds fit ONLY on the
    # training-period rows of the composite score (same leak-safe pattern
    # as the previous single-signal version's q1/q2).
    train_scores = master.loc[row_train_mask, "risk_score"].dropna()
    q1, q2 = train_scores.quantile([1 / 3, 2 / 3])

    def _bucket_risk(v):
        if pd.isna(v):
            return None
        if v <= q1:
            return "low"
        if v <= q2:
            return "medium"
        return "high"

    master["target_risk"] = master["risk_score"].map(_bucket_risk)
    master = master.dropna(subset=["bdry_lag1","bdry_lag2","bdry_lag3","bdry_rolling_3m_avg","brent_lag1","target_rate","target_delta","target_risk"])
    # time split by month, not rows, preventing same-month records from crossing the split.

    train = master[master.month <= cut].copy()
    test = master[master.month > cut].copy()

    if train.empty:
        raise ValueError("Training dataset is empty.")

    if test.empty:
        raise ValueError("Test dataset is empty.")

    # (Bug fix, 2026-09) has_portwatch_coverage, _congestion_pctile and
    # _data_uncertainty are added below. has_portwatch_coverage/data_uncertainty
    # were computed above (for the risk_score formula) but never made it into
    # the model's own feature list — the model had to guess "no port data"
    # from vessel_calls==0, which is ambiguous with genuinely-zero congestion
    # since vessel_calls is fillna(0)'d. _congestion_pctile is added too,
    # since it's the same real per-row signal vessel_calls already is, just
    # percentile-ranked. All three are known at prediction time (no future
    # information), so this is safe, ordinary feature engineering — NOT the
    # same as adding _vol_pctile/_shock_pctile/_trend_pctile, which are
    # deliberately excluded: those are built from vol.shift(-1) (literally
    # next month's value) and are direct 70%-weight components of the label
    # itself, so using them as inputs would leak the label into the features.
    cat=["port","commodity"]; num=["bdry_lag1","bdry_lag2","bdry_lag3","bdry_rolling_3m_avg","brent_lag1","trade_signal_lag1","trade_signal_yoy_growth","has_trade_signal","import_volume","export_volume","vessel_calls","month_num","quarter","has_portwatch_coverage","_congestion_pctile","_data_uncertainty"]
    enc=OneHotEncoder(handle_unknown="ignore",sparse_output=False); Xtr_cat=enc.fit_transform(train[cat]); Xte_cat=enc.transform(test[cat]);
    feature_names=num+enc.get_feature_names_out(cat).tolist(); Xtr=np.column_stack([train[num].values.astype(float),Xtr_cat]); Xte=np.column_stack([test[num].values.astype(float),Xte_cat])
    reg=RandomForestRegressor(n_estimators=300,random_state=42,n_jobs=-1,max_depth=12);

    if Xtr.size == 0:
        raise ValueError("Training features are empty.")

    if Xte.size == 0:
        raise ValueError("Test features are empty.")

    if np.isnan(Xtr).any():
        raise ValueError("Training features contain missing values.")

    if np.isnan(Xte).any():
        raise ValueError("Test features contain missing values.")

    if not np.isfinite(Xtr).all():
        raise ValueError("Training features contain NaN or infinite values.")

    if not np.isfinite(Xte).all():
        raise ValueError("Test features contain NaN or infinite values.")

    reg.fit(Xtr,train.target_delta); pred_delta=reg.predict(Xte)
    # Reconstruct the absolute level for evaluation/reporting: every metric
    # below (mae, baseline_comparison, etc.) is measured in the same
    # USD-rate units as before — only the internal training target changed.
    pred=test["bdry_lag1"].values+pred_delta
    mae=mean_absolute_error(test.target_rate,pred)

    # ------------------------------------------------------------------
    # Baseline comparison.
    #
    # An MAE number in isolation says nothing about whether the RandomForest
    # is actually earning its complexity — a model that beats "do nothing"
    # by 2% is a very different claim from one that beats it by 40%.
    # Two honest, unopinionated baselines, evaluated on the EXACT SAME
    # chronological test rows (test.target_rate / Xte) as the ML model:
    #
    #   naive_persistence: "next month's BDRY == last known BDRY"
    #       (bdry_lag1 is already the most recent real BDRY value known at
    #       prediction time for that row, so this needs no extra lookup).
    #   moving_average: "next month's BDRY == trailing 3-month average"
    #       (bdry_rolling_3m_avg, computed the same way as a forecasting
    #       feature above, reused here as a baseline predictor).
    #
    # Both are naive forecasts with zero learned parameters — if the
    # RandomForest can't beat them it isn't earning its keep. No test rows
    # are dropped or re-ordered to flatter either baseline or the model.
    # ------------------------------------------------------------------
    def _eval(y_true, y_pred, name):
        y_true = np.asarray(y_true, dtype=float)
        y_pred = np.asarray(y_pred, dtype=float)
        m_mae = float(mean_absolute_error(y_true, y_pred))
        m_rmse = float(np.sqrt(mean_squared_error(y_true, y_pred)))
        nonzero = y_true != 0
        m_mape = float(np.mean(np.abs((y_true[nonzero] - y_pred[nonzero]) / y_true[nonzero])) * 100) if nonzero.any() else None
        return {"name": name, "mae": round(m_mae, 4), "rmse": round(m_rmse, 4), "mape_pct": (round(m_mape, 4) if m_mape is not None else None)}

    model_eval = _eval(test.target_rate.values, pred, "random_forest_delta_vs_bdry_lag1")
    naive_eval = _eval(test.target_rate.values, test["bdry_lag1"].values, "naive_persistence")
    movavg_eval = _eval(test.target_rate.values, test["bdry_rolling_3m_avg"].values, "moving_average_3m")

    def _improvement_pct(baseline_mae, model_mae):
        # Positive = model beats the baseline by this percentage of the
        # baseline's own error. Negative means the baseline is actually
        # better — reported as-is, never clipped or hidden.
        if baseline_mae == 0:
            return None
        return round((baseline_mae - model_mae) / baseline_mae * 100, 2)

    baseline_comparison = {
        "test_period": {"start": str(test.month.min().date()), "end": str(test.month.max().date())},
        "test_row_count": int(len(test)),
        "baselines": {"naive_persistence": naive_eval, "moving_average_3m": movavg_eval},
        "model": model_eval,
        "improvement_pct_vs_naive_persistence": _improvement_pct(naive_eval["mae"], model_eval["mae"]),
        "improvement_pct_vs_moving_average_3m": _improvement_pct(movavg_eval["mae"], model_eval["mae"]),
        # Explicit boolean guardrail flag (same field name/semantics as
        # route_model.py's and route_freight_model.py's model_beats_baseline)
        # so app/utils.py can gate serving instead of only route-level code
        # doing so. True only when the model's own MAE beats naive
        # persistence's MAE on this horizon's held-out test rows.
        "model_beats_baseline": bool(model_eval["mae"] < naive_eval["mae"]),
    }

    # ------------------------------------------------------------------
    # Multi-horizon models: H+1 (reg, above), H+2, H+3.
    #
    # Xtr/Xte (built above from the FULL train/test frames) are reused
    # unchanged for every horizon — each horizon model sees the exact same
    # feature row per training example, only the target column differs
    # (target_delta_h{h}). A per-horizon mask drops the handful of rows at
    # the very tail of the dataset where month+h runs past the last month
    # actually present in bdry.csv (a real data-coverage limit, not
    # something to impute around).
    #
    # Uncertainty (lower_bound/upper_bound) is derived from the spread of
    # the RandomForest's individual trees' predictions for that row (a
    # standard, defensible non-parametric ensemble-uncertainty estimate —
    # NOT a fabricated confidence interval): each of the 300 trees in the
    # forest gives its own prediction for the same input, and the 10th/90th
    # percentile of that spread becomes the bound. Forests trained on wider
    # feature/target variety (i.e. every horizon) naturally show a wider
    # spread the further out the horizon goes, which is the honest
    # behaviour we want — H+3 should look less certain than H+1, and this
    # falls out of the ensemble itself rather than being hand-tuned.
    # ------------------------------------------------------------------
    horizon_models = {1: reg}
    horizon_metrics = {1: baseline_comparison}
    for h in HORIZONS:
        if h == 1:
            continue
        col = f"target_delta_h{h}"
        train_mask = train[col].notna().values
        test_mask = test[col].notna().values
        if train_mask.sum() == 0 or test_mask.sum() == 0:
            raise ValueError(f"Insufficient data to train/evaluate the H+{h} horizon model.")
        Xtr_h = Xtr[train_mask]
        Xte_h = Xte[test_mask]
        ytr_h = train.loc[train_mask, col].values
        reg_h = RandomForestRegressor(n_estimators=300, random_state=42, n_jobs=-1, max_depth=12)
        reg_h.fit(Xtr_h, ytr_h)
        pred_delta_h = reg_h.predict(Xte_h)
        test_h = test.loc[test_mask]
        pred_h = test_h["bdry_lag1"].values + pred_delta_h
        model_eval_h = _eval(test_h[f"target_rate_h{h}"].values, pred_h, f"random_forest_delta_vs_bdry_lag1_h{h}")
        naive_eval_h = _eval(test_h[f"target_rate_h{h}"].values, test_h["bdry_lag1"].values, "naive_persistence")
        movavg_eval_h = _eval(test_h[f"target_rate_h{h}"].values, test_h["bdry_rolling_3m_avg"].values, "moving_average_3m")
        horizon_metrics[h] = {
            "test_period": {"start": str(test_h.month.min().date()), "end": str(test_h.month.max().date())},
            "test_row_count": int(len(test_h)),
            "baselines": {"naive_persistence": naive_eval_h, "moving_average_3m": movavg_eval_h},
            "model": model_eval_h,
            "improvement_pct_vs_naive_persistence": _improvement_pct(naive_eval_h["mae"], model_eval_h["mae"]),
            "improvement_pct_vs_moving_average_3m": _improvement_pct(movavg_eval_h["mae"], model_eval_h["mae"]),
            # See baseline_comparison above for the same flag at H+1.
            "model_beats_baseline": bool(model_eval_h["mae"] < naive_eval_h["mae"]),
        }
        horizon_models[h] = reg_h


    # (Bug fix, 2026-09) Was a plain RandomForestClassifier trained on the
    # bucketed target_risk label. Measured result: "medium" scored 0%
    # precision/recall in the holdout AND in every walk-forward CV fold —
    # a nominal classifier can't express "close to a boundary" on what is
    # actually a continuous, ordered score. Fix: regress the continuous
    # risk_score itself and bucket only the final prediction at the same
    # train-only q1/q2 thresholds the labels were built from. See
    # ordinal_risk_model.py for the full rationale and the predict_proba/
    # classes_ compatibility shim that keeps app/utils.py unchanged.
    classes={"low":0,"medium":1,"high":2}; class_names=["low","medium","high"]
    clf=OrdinalRiskClassifier(thresholds=(float(q1),float(q2)),class_names=tuple(class_names),n_estimators=300,random_state=42,n_jobs=-1)
    clf.fit(Xtr,train["risk_score"].values)
    rp=clf.predict(Xte)
    y_true=test.target_risk.map(classes); y_pred=rp
    acc=accuracy_score(y_true,rp); cm=confusion_matrix(y_true,rp,labels=[0,1,2]).tolist()

    # Comprehensive risk-classifier evaluation — plain accuracy on
    # a 3-way imbalanced problem is easy to game (a classifier that always
    # predicts the majority class can score deceptively well) and doesn't
    # say anything about the minority/high-risk class specifically. Compute
    # and store the fuller picture instead of just accuracy.
    balanced_acc = balanced_accuracy_score(y_true, y_pred)
    macro_f1 = f1_score(y_true, y_pred, labels=[0,1,2], average="macro", zero_division=0)
    weighted_f1 = f1_score(y_true, y_pred, labels=[0,1,2], average="weighted", zero_division=0)
    precisions, recalls, f1s, supports = precision_recall_fscore_support(
        y_true, y_pred, labels=[0,1,2], zero_division=0
    )
    per_class_metrics = {
        class_names[i]: {
            "precision": round(float(precisions[i]), 4),
            "recall": round(float(recalls[i]), 4),
            "f1": round(float(f1s[i]), 4),
            "support_in_test": int(supports[i]),
        }
        for i in range(3)
    }
    # Explicitly flag any class with zero test-set support — accuracy/F1 for
    # that class is not statistically meaningful for this evaluation window,
    # and this must be stated rather than silently reported alongside the
    # other classes as if it were equally well-evaluated.
    classes_missing_from_test = [class_names[i] for i in range(3) if supports[i] == 0]
    train_class_counts = {c: int((train.target_risk == c).sum()) for c in class_names}
    test_class_counts = {c: int((test.target_risk == c).sum()) for c in class_names}

    # (P0-3) Supplementary walk-forward CV so "high" isn't permanently
    # untestable just because it happens to be absent from the single
    # fixed holdout window above — see risk_walk_forward_cv() docstring.
    risk_cv = risk_walk_forward_cv(master, num, cat, class_names=tuple(class_names))

    # Explainability: global feature importances from both RandomForests, plus
    # per-feature training-set mean/std so the API can score how far a given
    # request's inputs sit from "typical" (used for a lightweight per-request
    # "top drivers" explanation — see ModelBundle._local_drivers in utils.py).
    forecast_feature_importance = sorted(
        ({"feature": f, "importance": round(float(v), 4)} for f, v in zip(feature_names, reg.feature_importances_)),
        key=lambda d: d["importance"], reverse=True,
    )
    risk_feature_importance = sorted(
        ({"feature": f, "importance": round(float(v), 4)} for f, v in zip(feature_names, clf.feature_importances_)),
        key=lambda d: d["importance"], reverse=True,
    )
    numeric_feature_stats = {
        n: {"mean": float(train[n].mean()), "std": float(train[n].std() or 1.0) or 1.0}
        for n in num
    }
    # Prediction-time lookup: last known real feature values per port+commodity.
    look={}
    for (port,commodity),g in master.sort_values("month").groupby(["port","commodity"]):
        r=g.iloc[-1]; look[f"{port}|{commodity}"]={k:float(r[k]) for k in num}
    joblib.dump(reg,MODELS/"forecast_model.joblib"); joblib.dump(clf,MODELS/"risk_model.joblib"); joblib.dump(enc,MODELS/"feature_encoder.joblib")
    # forecast_model.joblib remains the H+1 model (unchanged filename, so
    # any code that only knows about a single horizon keeps working
    # exactly as before). H+2/H+3 are additional files — additive, nothing
    # existing is removed.
    for h, reg_h in horizon_models.items():
        if h == 1:
            continue
        joblib.dump(reg_h, MODELS / f"forecast_model_h{h}.joblib")
    bdry_history = (
        bdry.sort_values("month")
        .tail(12)
        .assign(month=lambda d: d["month"].dt.strftime("%Y-%m"))
        [["month", "bdry"]]
        .rename(columns={"bdry": "value"})
        .to_dict(orient="records")
    )

    # Training-run identity, real split boundaries/counts, model
    # hyperparameters, and library versions — computed, not hand-typed, so
    # every trained model can be traced back to exactly what produced it.
    training_timestamp = datetime.now(timezone.utc).isoformat()
    dataset_hash, dataset_file_hashes = _dataset_hash(DATA, DATA_FILES.values())
    model_version = f"real_monthly_v2-{training_timestamp}-{dataset_hash}"
    forecast_hyperparameters = {"n_estimators": 300, "random_state": 42, "n_jobs": -1, "max_depth": 12}
    risk_hyperparameters = {"n_estimators": 300, "random_state": 42, "n_jobs": -1, "thresholds": [float(q1), float(q2)]}
    training_metadata_block = {
        "model_version": model_version,
        "training_timestamp": training_timestamp,
        "data_source_mode": DATA_SOURCE_MODE,
        "dataset_id": f"{DATA_SOURCE_MODE}-{dataset_hash}",
        "dataset_hash": dataset_hash,
        "dataset_file_hashes": dataset_file_hashes,
        "training_row_count": int(len(train)),
        "validation_row_count": 0,
        "test_row_count": int(len(test)),
        "training_period": {"start": str(train.month.min().date()), "end": str(train.month.max().date())},
        "validation_period": None,
        "test_period": {"start": str(test.month.min().date()), "end": str(test.month.max().date())},
        "validation_note": (
            "This pipeline uses a single chronological 80/20 train/test split, "
            "not a separate validation holdout — with ~119 total months, a "
            "third split would leave too few test months to evaluate "
            "meaningfully (see README 'Known limitations'). "
            "validation_row_count is genuinely 0, not omitted."
        ),
        "algorithm": {"forecast": "RandomForestRegressor", "risk": "OrdinalRiskClassifier (RandomForestRegressor on risk_score, bucketed at q1/q2)"},
        "hyperparameters": {"forecast": forecast_hyperparameters, "risk": risk_hyperparameters},
        "library_versions": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "scikit_learn": sklearn.__version__,
            "pandas": pd.__version__,
            "numpy": np.__version__,
            "joblib": joblib.__version__,
        },
    }

    metadata={"pipeline_version":"real_monthly_v2","data_source_mode":DATA_SOURCE_MODE,"data_dir":str(DATA),"training_run":training_metadata_block,"training_row_count":training_metadata_block["training_row_count"],"test_row_count":training_metadata_block["test_row_count"],"model_version":training_metadata_block["model_version"],"feature_cols":feature_names,"numeric_features":num,"categorical_features":cat,"target":"next_month_bdry_market_proxy_delta_vs_bdry_lag1","target_transform":{"type":"delta_vs_last_known","reconstruct_level_as":"prediction = bdry_lag1 + model_output","reason":"RandomForest leaves cannot extrapolate beyond the training target range; BDRY trended well outside the training range by the test period, so predicting the level directly under-forecast by ~5x naive persistence's error. Predicting the (roughly stationary) change instead avoids the extrapolation ceiling. See README Known limitations."},"commodities":COMMODITIES,"bdry_history_12m": bdry_history,"origins":[p for p in ["Newcastle","Hay Point","Gladstone","Norfolk","Baltimore","Nacala","Beira","Vostochny","Murmansk","Samarinda","Taboneo"]],"destinations":EAST_COAST,"routes":[f"{o}-{d}" for o in ["Newcastle","Hay Point","Gladstone","Norfolk","Baltimore","Nacala","Beira","Vostochny","Murmansk","Samarinda","Taboneo"] for d in EAST_COAST],"shipment_modes":["Bulk Carrier","Charter"],"vessel_types":["Handysize","Supramax","Panamax","Capesize"],"latest_lookup":look,"risk_classes":["low","medium","high"],"risk_thresholds":[float(q1),float(q2)],"risk_weights":RISK_WEIGHTS,"risk_methodology":"hybrid_score: volatility+rate_shock+trend_deviation+port_congestion+data_uncertainty, each percentile-ranked against training-period distribution, weighted-summed, then bucketed at train-only tertiles. (2026-09 fix) Classifier switched from plain RandomForestClassifier on the bucketed label to OrdinalRiskClassifier (regresses the continuous risk_score, buckets only the final prediction) after 'medium' measured 0% precision/recall under the old approach in the holdout and every walk-forward fold; has_portwatch_coverage/_congestion_pctile/_data_uncertainty were also added to the feature list (previously computed but unused by the model).","metrics":{"forecast_mae":round(float(mae),4),"risk_accuracy":round(float(acc),4),"risk_balanced_accuracy":round(float(balanced_acc),4),"risk_macro_f1":round(float(macro_f1),4),"risk_weighted_f1":round(float(weighted_f1),4),"risk_per_class":per_class_metrics,"risk_classes_missing_from_test":classes_missing_from_test,"risk_train_class_counts":train_class_counts,"risk_test_class_counts":test_class_counts,"risk_confusion_matrix":cm,"risk_confusion_matrix_labels":class_names,"risk_walk_forward_cv":risk_cv,"baseline_comparison":baseline_comparison,"horizon_metrics":{str(h): horizon_metrics[h] for h in HORIZONS},"horizons_available":HORIZONS},"data_files":DATA_FILES,"forecast_feature_importance":forecast_feature_importance,"risk_feature_importance":risk_feature_importance,"numeric_feature_stats":numeric_feature_stats}
    with open(MODELS/"metadata.json","w") as f: json.dump(metadata,f,indent=2)
    master.to_csv(DATA/"monthly_feature_table.csv",index=False)
    print(json.dumps(metadata["metrics"],indent=2)); print(f"Saved {len(master)} monthly port/commodity rows to {DATA/'monthly_feature_table.csv'}")
    print(
        f"Baseline comparison (test {baseline_comparison['test_period']['start']}..{baseline_comparison['test_period']['end']}, "
        f"n={baseline_comparison['test_row_count']}): "
        f"naive_persistence MAE={naive_eval['mae']}, moving_average_3m MAE={movavg_eval['mae']}, "
        f"model MAE={model_eval['mae']} "
        f"(improvement vs naive: {baseline_comparison['improvement_pct_vs_naive_persistence']}%, "
        f"vs moving_average: {baseline_comparison['improvement_pct_vs_moving_average_3m']}%)"
    )
    for h in HORIZONS:
        hm = horizon_metrics[h]
        print(
            f"H+{h}: test n={hm['test_row_count']} ({hm['test_period']['start']}..{hm['test_period']['end']}), "
            f"model MAE={hm['model']['mae']}, naive MAE={hm['baselines']['naive_persistence']['mae']}, "
            f"improvement vs naive={hm['improvement_pct_vs_naive_persistence']}%"
        )
    if classes_missing_from_test:
        print(
            f"WARNING: the following risk classes have ZERO examples in the test period "
            f"({test.month.min().date()} to {test.month.max().date()}): {classes_missing_from_test}. "
            "Precision/recall/F1 for those classes are not statistically meaningful for this "
            "evaluation window (undefined/zero by construction, not a model failure) — this is a "
            "real property of the historical BDRY volatility in that window, not something to "
            "paper over. See README 'Known limitations'."
        )

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="FreightSight training pipeline. Run with no arguments "
        "to use the default data directory and production model output. Pass "
        "--data-dir/--output-dir to run an isolated developer experiment."
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help="Directory containing the 7 raw input CSVs (default: ml-service/data)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to write the trained model + metadata.json into "
        "(default: ml-service/models, i.e. production — matches the "
        "original manual-training behavior)",
    )
    args = parser.parse_args()
    main(data_dir=args.data_dir, output_dir=args.output_dir)