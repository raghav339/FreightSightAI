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

    # Which forecast pipeline actually produced this prediction. There is
    # no fallback hierarchy any more (see ModelBundle._route_forecast in
    # utils.py) — this always mirrors forecast_type: "synthetic_route" for
    # the synthetic MVP dataset, or "route_specific" once verified
    # production observations exist for the lane. An uncovered lane is
    # refused outright (ValueError -> 400), never silently answered with
    # an unrelated/averaged entry.
    data_source_level: str = "synthetic_route"

    vessel_status: str = "RECOMMENDED_VESSEL"
    vessel_rejection_reason: Optional[str] = None
    rejected_vessel_types: list[dict] = []

    
    forecast_curve: list[dict] = []

   
    forecast_type: str = "synthetic_route"

    # High/medium/low. Always "low" for the synthetic MVP dataset this
    # project ships (see ModelBundle._route_forecast) — never fabricated
    # upward. Will reflect real verified-data confidence once production
    # route-freight observations exist for a lane.
    data_confidence: str = "low"

    training_data_mode: str = "unknown"

    # Decision-quality transparency for mentor/demo and operational use.
    forecast_basis: str = "Synthetic route freight rate (MVP)"
    forecast_source: str = "route_freight_observations.csv (synthetic MVP development dataset)"
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
    cargo_weight_tons: Optional[float] = Field(default=None, gt=0)
    total_program_tons: Optional[float] = Field(default=None, gt=0)
    contract_duration_months: float = Field(default=3, gt=0, le=36)

    @model_validator(mode="after")
    def _check_program_tonnage(self):
        if self.cargo_weight_tons is None and self.total_program_tons is None:
            raise ValueError(
                "Provide total_program_tons (cargo_weight_tons per voyage is optional)."
            )
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