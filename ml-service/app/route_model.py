"""Route-level freight model.

HISTORY / DATA CONTRACT
------------------------
This module previously fell back to an AIS+BDRY "dry-bulk market proxy"
model (route_model_h1/2/3.joblib, trained against BDRY ETF price) whenever
a lane had no synthetic/verified route-rate observations. That fallback has
been removed. This module now serves ONLY the route-freight model trained
on synthetic (or, once available, verified) route freight-rate observations
in route_freight_model.py.

Practical effect: a route/commodity combination that has no eligible
route-freight model no longer silently degrades to a BDRY-derived market
proxy. predict() raises ValueError instead, and callers (app/main.py)
surface that as a 400 so the caller knows the lane simply isn't covered by
the route-freight dataset yet.
"""
from __future__ import annotations
from pathlib import Path

try:
    from route_freight_model import RouteFreightModel
except Exception:
    RouteFreightModel = None

ROOT = Path(__file__).resolve().parents[1] if Path(__file__).resolve().parent.name == "app" else Path(__file__).resolve().parent
MODELS = ROOT / "models"


class RouteModel:
    def __init__(self, models_dir: str | Path | None = None):
        self.models_dir = Path(models_dir) if models_dir else MODELS
        self.route_freight = RouteFreightModel(self.models_dir) if RouteFreightModel else None

    def predict(self, origin, destination, shipment_date, current_spot_rate_usd_per_ton=None, commodity=None):
        if self.route_freight is None:
            raise ValueError(
                "Route-freight model is not available (route_freight_model.py failed to load)."
            )
        try:
            direct = self.route_freight.predict(origin, destination, shipment_date, commodity=commodity)
        except TypeError:
            # Backward-compatible support for lightweight test doubles / older route model adapters.
            direct = self.route_freight.predict(origin, destination, shipment_date)

        if direct is not None and direct.get("model_beats_baseline") is not True:
            direct = None

        if direct is None:
            raise ValueError(
                f"No synthetic route-freight forecast is available for {origin} -> {destination}"
                + (f" ({commodity})" if commodity else "")
                + ". This lane is not covered by the route-freight dataset, or its held-out "
                "evaluation did not beat the naive-persistence baseline."
            )

        direct["current_spot_rate_usd_per_ton"] = current_spot_rate_usd_per_ton
        for item in direct.get("forecasts", []):
            if current_spot_rate_usd_per_ton is not None:
                item["current_spot_rate_usd_per_ton"] = float(current_spot_rate_usd_per_ton)
        return direct
