# ml-service/app/schemas.py
from datetime import date as date_type
from typing import Optional

from pydantic import BaseModel, Field, model_validator


class ForecastRequest(BaseModel):
    commodity: str
    origin_port: str
    destination_port: str
    shipment_date: date_type
    cargo_weight_tons: float = Field(gt=0)
    cargo_volume_cbm: Optional[float] = None
    shipment_mode: str = "Bulk Carrier"
    vessel_type: Optional[str] = None
    distance_km: Optional[float] = None
    delay_days: Optional[float] = 0
    # Objective: support planning multi-voyage / COA contracts, not just one-off spot fixtures
    contract_duration_months: Optional[float] = None
    total_program_tons: Optional[float] = None

    @model_validator(mode="after")
    def _check_program_tonnage(self):
        # total_program_tons is the sum across all voyages in a COA, so it
        # can never be less than a single shipment's cargo weight.
        if (
            self.total_program_tons is not None
            and self.total_program_tons < self.cargo_weight_tons
        ):
            raise ValueError(
                f"total_program_tons ({self.total_program_tons}) must be >= "
                f"cargo_weight_tons ({self.cargo_weight_tons})"
            )
        return self


class CompareOriginsRequest(BaseModel):
    """(2) Origin comparison — same cargo/destination/date, ranked across
    every known loading port (Australia/US/Mozambique/Russia/Indonesia)."""
    commodity: str
    destination_port: str
    shipment_date: date_type
    cargo_weight_tons: float = Field(gt=0)
    vessel_type: Optional[str] = None
    contract_duration_months: Optional[float] = None
    total_program_tons: Optional[float] = None

    @model_validator(mode="after")
    def _check_program_tonnage(self):
        # Same rule as ForecastRequest/COAOptimizeRequest: total_program_tons
        # is the sum across all voyages, so it can never be less than a
        # single voyage's cargo weight.
        if (
            self.total_program_tons is not None
            and self.total_program_tons < self.cargo_weight_tons
        ):
            raise ValueError(
                f"total_program_tons ({self.total_program_tons}) must be >= "
                f"cargo_weight_tons ({self.cargo_weight_tons})"
            )
        return self


class IdleAlternativesRequest(BaseModel):
    """(6) Idle-vessel repositioning — given a vessel idle at a port, rank
    the next-best loading ports to reposition to."""
    current_port: str
    vessel_type: Optional[str] = None
    commodity: Optional[str] = None
    cargo_weight_tons: Optional[float] = Field(default=None, gt=0)


class PortInfo(BaseModel):
    name: str
    known: bool
    max_loa_m: Optional[float] = None
    max_beam_m: Optional[float] = None
    max_draft_m: Optional[float] = None
    cargo_handling_rate_tpd: Optional[float] = None
    typical_congestion: Optional[str] = None
    notes: Optional[str] = None


class ForecastResponse(BaseModel):
    route: str
    predicted_freight_rate_usd_per_ton: float
    risk_label: str
    risk_confidence: float
    recommended_vessel_type: str
    recommended_charter_window: str
    summary: str
    trend_points: list[dict]

    # (b) Vessel Type Optimization — port-infrastructure-aware
    feasible_vessel_types: list[str]
    vessel_constraint_note: str
    origin_port_info: PortInfo
    destination_port_info: PortInfo

    # (c) Idle Scenario Management
    port_turnaround_days: float
    idle_management_advice: str

    # (d) Risk Mitigation / early warning
    congestion_warning: str

    # Objective: spot -> short/mid-term multi-voyage contracting
    contracting_strategy: str

    # (3) Explainability — why the model produced this forecast
    feature_importance: list[dict] = []
    top_drivers: list[dict] = []

    # Which level of the deterministic market-data fallback hierarchy this
    # prediction actually used (see ModelBundle._resolve_lookup in utils.py):
    # "destination_commodity" (exact match), "commodity" (averaged across
    # destinations for this commodity), or "global_proxy" (averaged across
    # the whole lookup table). Never an arbitrary/unrelated entry.
    data_source_level: str = "destination_commodity"

    # Phase 6 — both-port vessel feasibility. vessel_status is one of:
    # "RECOMMENDED_VESSEL" (no vessel_type requested, this is the best
    # feasible option), "REQUESTED_VESSEL_FEASIBLE" (the requested vessel_type
    # passed both-port checks), "REQUESTED_VESSEL_NOT_FEASIBLE_USING_RECOMMENDED"
    # (the requested vessel_type failed cargo/origin/destination checks, so a
    # different feasible vessel is shown instead — see vessel_rejection_reason
    # for why), or "NO_FEASIBLE_VESSEL" (no vessel class in the dataset is
    # feasible for this cargo at both ports — recommended_vessel_type is then
    # informational only, not an actual recommendation). The forecast/risk
    # figures above are always valid regardless of vessel_status — a vessel
    # problem never invalidates the rate forecast.
    vessel_status: str = "RECOMMENDED_VESSEL"
    vessel_rejection_reason: Optional[str] = None
    rejected_vessel_types: list[dict] = []

    # (Phase 4) Genuine multi-horizon forecast — H+1/H+2/H+3, each from its
    # own directly-trained model (see train.py), not the H+1 model re-run
    # with a relabeled date. lower_bound/upper_bound come from the spread
    # of individual tree predictions within that horizon's RandomForest
    # (an ensemble-uncertainty estimate, not a fabricated interval).
    forecast_curve: list[dict] = []

    # (Phase 2/3) What is actually being predicted, stated plainly so the
    # UI/PDF/judge never has to infer it:
    #   "route_specific" — the model saw real per-route freight
    #       observations for this exact lane, OR
    #   "market_proxy" — BDRY (a global dry-bulk market index) stands in
    #       for a route-specific rate because no per-route freight
    #       observations exist in the training data. This project's
    #       current dataset (see ml-service/data/README) is proxy-based;
    #       forecast_type will read "market_proxy" until real per-route
    #       freight-rate observations are added to training.
    forecast_type: str = "market_proxy"

    # High/medium/low, derived from data_source_level + horizon (further
    # horizons and less-specific fallback levels get lower confidence).
    # Never fabricated — derived deterministically from the same
    # data_source_level already computed for this request plus the
    # horizon-specific evaluation metrics stored in metadata.json.
    data_confidence: str = "medium"

    # (Phase 10) Whether the currently-loaded model was trained on
    # data/production/ (verified real datasets) or data/synthetic/
    # (development/test data). Read straight from metadata.json's
    # data_source_mode, written by train.py at training time — never
    # inferred or guessed at inference time. "unknown" only if an older
    # metadata.json predates this field.
    training_data_mode: str = "unknown"

    # Decision-quality transparency for mentor/demo and operational use.
    forecast_basis: str = "BDRY market proxy"
    forecast_source: str = "BDRY historical market series"
    latest_feature_date: Optional[str] = None
    risk_reliability: str = "medium"
    recommended_vessel_reason: str = ""
    port_data_warning: Optional[str] = None

    # Now genuinely driven by the request's distance_km / delay_days /
    # cargo_volume_cbm / shipment_mode (see ModelBundle.predict in utils.py)
    # rather than being accepted-but-unused fields. transit_distance_source
    # is one of "user_provided" (distance_km was supplied), "route_table"
    # (fell back to the indicative static distance table), or "unavailable".
    estimated_transit_days: Optional[float] = None
    transit_distance_source: str = "unavailable"
    transit_note: Optional[str] = None
    stowage_factor_cbm_per_ton: Optional[float] = None
    stowage_note: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    models_loaded: bool
    routes_known: int

class RouteForecastRequest(BaseModel):
    commodity: str = "Coal"
    origin_port: str
    destination_port: str
    shipment_date: date_type
    current_spot_rate_usd_per_ton: Optional[float] = Field(default=None, gt=0)
    vessel_type: Optional[str] = None


class COAOptimizeRequest(RouteForecastRequest):
    # Optional: when supplied, this is treated as the FIXED intended lift
    # size per voyage and drives the voyage count directly (see
    # coa_optimizer.optimize()). When omitted, the optimizer picks its own
    # voyage count/parcel size per vessel class from total_program_tons.
    cargo_weight_tons: Optional[float] = Field(default=None, gt=0)
    total_program_tons: Optional[float] = Field(default=None, gt=0)
    contract_duration_months: float = Field(default=3, gt=0, le=36)

    @model_validator(mode="after")
    def _check_program_tonnage(self):
        if self.cargo_weight_tons is None and self.total_program_tons is None:
            raise ValueError(
                "Provide total_program_tons (cargo_weight_tons per voyage is optional)."
            )
        # total_program_tons is the sum across all voyages in the COA, so it
        # can never be less than a single voyage's cargo weight — otherwise
        # the optimizer would be working from contradictory inputs (e.g.
        # 90,000t per voyage against a 10,000t total program).
        if (
            self.total_program_tons is not None
            and self.cargo_weight_tons is not None
            and self.total_program_tons < self.cargo_weight_tons
        ):
            raise ValueError(
                f"total_program_tons ({self.total_program_tons}) must be >= "
                f"cargo_weight_tons ({self.cargo_weight_tons})"
            )
        return self