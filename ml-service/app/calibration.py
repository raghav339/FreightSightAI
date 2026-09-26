# ml-service/app/calibration.py
#
# Turns the held-out test-set metrics already computed at training time
# (route_freight_model.py's per-route/per-horizon walk-forward evaluation,
# saved to models/route_freight_model_metadata.json) into a lane-level
# calibration/backtest summary: "here's how our past forecasts compared to
# actual market rates."
#
# Nothing here is a live re-evaluation — it is a reshape of numbers that
# already exist from training (mae_usd_per_t, naive_mae_usd_per_t,
# test_rows, test_period, etc., one entry per route_id x horizon-month).
# route_freight_model.py computes these against held-out rows the model
# never trained on (see its train/test split), so "mae_usd_per_t" is a
# genuine out-of-sample forecast error, not an in-sample fit statistic.
#
# No I/O, no FastAPI: app/main.py's /calibration/summary route does the
# fetching (bundle.route_freight.meta) and passes it straight in, so this
# stays testable with a plain dict.
"""Lane-level calibration/backtest summary from route_freight_model metadata."""
from __future__ import annotations

from typing import Any

# Horizon key used for the headline numbers: "1" is the nearest-term
# (H+1 month) forecast, the one closest to what a user actually sees on
# the Predict page for a near-dated shipment.
HEADLINE_HORIZON = "1"


def _lane_name(route_key: str) -> tuple[str, str] | None:
    """"Baltimore|Chennai|R147" -> ("Baltimore", "Chennai")."""
    parts = route_key.split("|")
    if len(parts) < 2:
        return None
    return parts[0], parts[1]


def build_calibration_summary(meta: dict[str, Any], *, horizon: str = HEADLINE_HORIZON, limit: int = 20) -> dict[str, Any]:
    """Aggregate route_freight_model_metadata.json's `metrics` to one row
    per (origin, destination) lane at the given horizon, averaging across
    that lane's route_ids (a lane typically has a few — different vessel
    classes/seasons trained separately).

    Returns `status: "unavailable"` rather than raising if the model
    hasn't been trained (or the metadata predates this horizon key), so
    the route/page can show an explanation instead of a broken chart.
    """
    metrics = meta.get("metrics") or {}
    if not metrics or meta.get("status") != "active":
        return {
            "status": "unavailable",
            "reason": "No trained route-freight model metadata is available yet.",
            "lanes": [],
            "overall": None,
        }

    by_lane: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for route_key, horizons in metrics.items():
        lane = _lane_name(route_key)
        row = horizons.get(horizon) if isinstance(horizons, dict) else None
        if lane is None or not row:
            continue
        by_lane.setdefault(lane, []).append(row)

    lanes = []
    for (origin, destination), rows in by_lane.items():
        n = len(rows)
        test_rows_total = sum(r.get("test_rows") or 0 for r in rows)
        mae = sum(r.get("mae_usd_per_t") or 0 for r in rows) / n
        naive_mae = sum(r.get("naive_mae_usd_per_t") or 0 for r in rows) / n
        rmse = sum(r.get("rmse_usd_per_t") or 0 for r in rows) / n
        improvement_pct = sum(r.get("improvement_pct") or 0 for r in rows) / n
        beats_baseline = all(bool(r.get("model_beats_baseline")) for r in rows)
        periods = [r["test_period"] for r in rows if r.get("test_period")]
        test_period = None
        if periods:
            test_period = {
                "start": min(p["start"] for p in periods),
                "end": max(p["end"] for p in periods),
            }
        lanes.append({
            "origin_port": origin,
            "destination_port": destination,
            "route_models": n,
            "test_rows": test_rows_total,
            "mae_usd_per_t": round(mae, 4),
            "naive_mae_usd_per_t": round(naive_mae, 4),
            "rmse_usd_per_t": round(rmse, 4),
            "improvement_pct": round(improvement_pct, 2),
            "beats_naive_baseline": beats_baseline,
            "test_period": test_period,
        })

    # Most-tested lanes first — the ones with the most held-out
    # observations make the most convincing (and least noisy) chart.
    lanes.sort(key=lambda l: l["test_rows"], reverse=True)

    overall = None
    if lanes:
        n = len(lanes)
        overall = {
            "lanes_evaluated": n,
            "avg_mae_usd_per_t": round(sum(l["mae_usd_per_t"] for l in lanes) / n, 4),
            "avg_naive_mae_usd_per_t": round(sum(l["naive_mae_usd_per_t"] for l in lanes) / n, 4),
            "avg_improvement_pct": round(sum(l["improvement_pct"] for l in lanes) / n, 2),
            "lanes_beating_naive_baseline": sum(1 for l in lanes if l["beats_naive_baseline"]),
            "total_test_observations": sum(l["test_rows"] for l in lanes),
        }

    return {
        "status": "ok",
        "horizon_months": int(horizon) if horizon.isdigit() else horizon,
        "data_mode": meta.get("data_mode"),
        "target": meta.get("target"),
        "baseline_summary": meta.get("baseline_summary"),
        "overall": overall,
        "lanes": lanes[:limit],
        "lanes_available": len(lanes),
        "note": (
            "mae_usd_per_t and naive_mae_usd_per_t are computed on held-out rows the model "
            "never trained on (a walk-forward split by date), not on training data. "
            "naive_mae_usd_per_t is the error of a naive persistence baseline (predict last "
            "observed rate) over the same held-out rows, for comparison."
        ),
    }
