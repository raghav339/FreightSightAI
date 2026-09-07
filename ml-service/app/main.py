# ml-service/app/main.py
import os
import sys
import threading


def _require_core_dependencies() -> None:
    """Fail loudly and clearly if core deps aren't installed.

    `pydantic`, `fastapi`, and `uvicorn` are Python packages listed in
    `ml-service/requirements.txt` — they are never installed via
    `backend/node_modules`. If this environment (local dev, Render, or
    anywhere else ml-service runs) skipped `pip install -r
    requirements.txt`, every route fails with a confusing 500/import
    error. This check turns that into one unmistakable message instead
    of a buried stack trace surfacing mid-demo.
    """
    missing = []
    for pkg in ("pydantic", "fastapi", "uvicorn"):
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        sys.stderr.write(
            "\n"
            + "=" * 70
            + "\n"
            "FreightSight ml-service FAILED TO START\n"
            f"Missing required Python package(s): {', '.join(missing)}\n"
            "\n"
            "Fix: run this from the ml-service/ directory before starting\n"
            "the app:\n"
            "\n"
            "    pip install -r requirements.txt\n"
            "\n"
            "This is a Python dependency issue only — it is unrelated to\n"
            "backend/node_modules and npm install.\n" + "=" * 70 + "\n\n"
        )
        sys.exit(1)


_require_core_dependencies()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.schemas import (
    ForecastRequest,
    ForecastResponse,
    HealthResponse,
    CompareOriginsRequest,
    IdleAlternativesRequest,
    RouteForecastRequest,
    COAOptimizeRequest,
)
from app.utils import ModelBundle
from app import port_utils
from app.route_model import RouteModel
from app.coa_optimizer import optimize as optimize_coa
from app.ais_stream import collector as ais_collector, PORT_COORDS

app = FastAPI(title="FreightSight AI - ML Service", version="1.2.0")

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("BACKEND_ORIGIN", "http://127.0.0.1:5000").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,  # set BACKEND_ORIGIN env var in production, comma-separated if needed
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def start_aisstream_collector():
    if os.environ.get("AISSTREAM_API_KEY"):
        ais_collector.start()


@app.on_event("startup")
def start_model_warmup():
    """Kick off model loading in the background the instant the process
    boots, instead of waiting for the first real request to trigger it.

    On Render's free tier, a cold instance already has to pay for
    container boot + importing pandas/scikit-learn/FastAPI before this
    process even starts running. Loading the joblib models (a 500-tree
    RandomForest plus the risk model and encoder) lazily on the first hit
    stacks that load time — commonly another 30-90s — on top of whatever
    request triggered it. Starting the load here means it happens in
    parallel with Render's own port-open/health-check polling, so by the
    time a real user request arrives the models are already warm (or much
    closer to it) instead of starting from zero.

    This is a genuine speed-up, not a full fix — a fully idle Render free
    instance still has to cold-boot the container before this code runs
    at all. Combine with the backend's keep-alive ping (server.js) to
    avoid most cold starts in the first place.
    """
    threading.Thread(target=_warm_up_models, daemon=True).start()


def _warm_up_models():
    try:
        get_bundle()
    except Exception as exc:  # pragma: no cover - best-effort warmup
        print(f"[warmup] forecast/risk model warmup failed (will retry lazily on first request): {exc}")
    try:
        get_route_bundle()
    except Exception as exc:  # pragma: no cover - best-effort warmup
        print(f"[warmup] route model warmup failed (will retry lazily on first request): {exc}")


@app.on_event("shutdown")
def stop_aisstream_collector():
    ais_collector.stop()

_bundle: ModelBundle | None = None
_route_bundle: RouteModel | None = None
_bundle_lock = threading.Lock()
_route_bundle_lock = threading.Lock()


def get_route_bundle() -> RouteModel:
    global _route_bundle
    if _route_bundle is None:
        # A request thread can race the startup warmup thread here; the
        # lock just makes sure only one of them actually loads the model
        # instead of both paying the joblib.load() cost concurrently.
        with _route_bundle_lock:
            if _route_bundle is None:
                try:
                    _route_bundle = RouteModel()
                except Exception as exc:
                    raise HTTPException(status_code=503, detail=f"Route model unavailable: {exc}") from exc
    return _route_bundle


def get_bundle() -> ModelBundle:
    global _bundle, _route_bundle
    if _bundle is None:
        with _bundle_lock:
            if _bundle is None:
                models_dir = os.path.join(os.path.dirname(__file__), "..", "models")
                required = [
                    "forecast_model.joblib",
                    "risk_model.joblib",
                    "feature_encoder.joblib",
                    "metadata.json",
                ]

                missing = [
                    name
                    for name in required
                    if not os.path.exists(
                        os.path.join(models_dir, name)
                    )
                ]

                if missing:
                    raise HTTPException(
                        status_code=503,
                        detail="Model artifacts incomplete.",
                    )

                try:
                    _bundle = ModelBundle()
                except Exception as exc:
                    raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _bundle


@app.get("/ais/status")
def ais_status():
    """Live AISStream collector status; the API key is never returned."""
    return ais_collector.status()


@app.get("/ais/route-features")
def ais_route_features(origin_port: str, destination_port: str, lookback_hours: int = 24):
    try:
        return ais_collector.route_features(origin_port, destination_port, lookback_hours)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/ais/idle-vessels")
def ais_idle_vessels(
    lookback_hours: int = 48,
    min_idle_hours: float = 4.0,
    port: str | None = None,
    limit: int = 50,
    cargo_only: bool = True,
):
    """Detect sustained AIS-idle cargo/bulk candidates from live history.

    This is an observational AIS endpoint: it does not claim that a vessel
    is commercially open for charter. Availability must be verified through
    fixture/broker data or an operator.
    """
    if port and port not in PORT_COORDS:
        raise HTTPException(status_code=400, detail=f"Unknown AIS port: {port}")
    try:
        return ais_collector.idle_vessels(
            lookback_hours=lookback_hours,
            min_idle_hours=min_idle_hours,
            port=port,
            limit=limit,
            cargo_only=cargo_only,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/health", response_model=HealthResponse)
def health():
    # Health checks should never compete with a real user request for the
    # model-loading lock. Startup warmup already loads the bundle in the
    # background; once loaded, expose the real readiness state. Before that,
    # return a quick 200 so Render can keep the process alive without waiting
    # on joblib/pandas/sklearn initialization.
    bundle = _bundle
    if bundle is None:
        return HealthResponse(status="starting", models_loaded=False, routes_known=0)
    return HealthResponse(
        status="ok",
        models_loaded=True,
        routes_known=len(bundle.meta.get("routes", [])),
    )


@app.get("/meta")
def meta():
    """Lets the Node backend populate dropdowns (routes/ports/modes/vessels) without hardcoding them."""
    bundle = get_bundle()
    return {
        "commodities": bundle.meta.get("commodities", ["Coal", "Iron Ore", "Bulk Minerals & Ores"]),
        "origins": bundle.meta["origins"],
        "destinations": bundle.meta["destinations"],
        "routes": bundle.meta["routes"],
        "shipment_modes": bundle.meta["shipment_modes"],
        "vessel_types": bundle.meta["vessel_types"],
        "metrics": bundle.meta["metrics"],
        "route_freight": (getattr(get_route_bundle(), "route_freight", None).meta if getattr(get_route_bundle(), "route_freight", None) is not None else {"status": "inactive"}),
    }


@app.get("/ports")
def ports():
    """Port-infrastructure master data (draft/LOA/beam/handling-rate/congestion)
    for both loading ports (Australia/US/Mozambique/Russia/Indonesia) and India
    East Coast discharge ports — used by the frontend's port-constraints panel."""
    return port_utils.PORT_INFRA


@app.post("/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest):
    bundle = get_bundle()
    try:
        result = bundle.predict(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ForecastResponse(**result)


@app.post("/risk")
def risk(req: ForecastRequest):
    """Lighter endpoint returning just the risk classification piece."""
    bundle = get_bundle()
    try:
        result = bundle.predict(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "route": result["route"],
        "risk_label": result["risk_label"],
        "risk_confidence": result["risk_confidence"],
        "congestion_warning": result["congestion_warning"],
    }


@app.post("/recommend")
def recommend(req: ForecastRequest):
    """Lighter endpoint returning just the recommendation piece. Used by the
    frontend's what-if / sensitivity panel to re-run the decision engine
    (vessel choice, turnaround, idle advice, contracting strategy) as the
    user drags a slider, without the overhead of a full /forecast + DB save."""
    bundle = get_bundle()
    try:
        result = bundle.predict(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "route": result["route"],
        "recommended_vessel_type": result["recommended_vessel_type"],
        "feasible_vessel_types": result["feasible_vessel_types"],
        "vessel_constraint_note": result["vessel_constraint_note"],
        "vessel_status": result["vessel_status"],
        "vessel_rejection_reason": result["vessel_rejection_reason"],
        "rejected_vessel_types": result["rejected_vessel_types"],
        "recommended_charter_window": result["recommended_charter_window"],
        "port_turnaround_days": result["port_turnaround_days"],
        "idle_management_advice": result["idle_management_advice"],
        "congestion_warning": result["congestion_warning"],
        "contracting_strategy": result["contracting_strategy"],
        "summary": result["summary"],
    }


@app.post("/compare-origins")
def compare_origins(req: CompareOriginsRequest):
    """(2) Compare all known loading ports (Australia/US/Mozambique/Russia/
    Indonesia) for the same cargo, destination, and date — ranked by vessel
    feasibility at both ends, transit time, and load-port congestion."""
    bundle = get_bundle()
    return bundle.compare_origins(req)


@app.post("/idle-alternatives")
def idle_alternatives(req: IdleAlternativesRequest):
    """(6) Idle-vessel repositioning — rank next-best loading ports for a
    vessel currently idle at a given port, combining predicted freight
    earnings with ballast/idle time."""
    bundle = get_bundle()
    return bundle.idle_alternatives(req)

@app.post("/route-forecast")
def route_forecast(req: RouteForecastRequest):
    """AIS-enhanced route-level market forecast.

    This endpoint is intentionally separate from /forecast because the existing
    /forecast contract historically exposes BDRY as a freight-rate proxy. The
    route endpoint reports the proxy and, when calibrated with a current spot
    USD/t benchmark, an indicative route rate.
    """
    bundle = get_route_bundle()
    try:
        return bundle.predict(req.origin_port, req.destination_port, req.shipment_date,
                              req.current_spot_rate_usd_per_ton, req.commodity)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/coa-optimize")
def coa_optimize(req: COAOptimizeRequest):
    """Optimize a short/mid-term multi-voyage COA against spot.

    Monetary savings are returned only when a current spot benchmark is
    supplied; otherwise the endpoint ranks vessel/voyage strategies by an
    operational index rather than fabricating dollars.
    """
    bundle = get_route_bundle()
    try:
        return optimize_coa(req, bundle, port_utils)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/route-freight/status")
def route_freight_status():
    """Expose whether verified route-rate observations/models are available.

    This is intentionally read-only: model training remains an offline
    operation after human verification of source observations.
    """
    bundle = get_route_bundle()
    rf = getattr(bundle, "route_freight", None)
    meta = rf.meta if rf is not None else {"status": "inactive"}
    return {
        "status": meta.get("status", "inactive"),
        "verified_rows": meta.get("verified_rows", 0),
        "routes_with_models": meta.get("routes_with_models", []),
        "skipped_routes": meta.get("skipped_routes", {}),
        "target": meta.get("target", "observed_freight_usd_per_t"),
    }


@app.get("/dashboard-summary")
def dashboard_summary():
    bundle = get_bundle()

    return {
        "bdry_history_12m": bundle.meta.get("bdry_history_12m", []),
        "metrics": bundle.meta.get("metrics", {}),
    }
