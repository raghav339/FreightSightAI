// backend/test/fixtures/decisionBriefFixtures.js
//
// Real ml-service output (not hand-written numbers) for:
//   Iron Ore, Newcastle -> Visakhapatnam, 1 Oct 2026,
//   60,000 t per lift, 240,000 t program, 6-month contract
// captured by running ModelBundle.predict()/compare_origins() and
// coa_optimizer.optimize() against the checked-in models. Trimmed to the
// fields the backend reads, plus a few realistic extras.
"use strict";

// A forecast_results + forecast_requests row as the DB returns it.
const FORECAST_ROW = {
  id: 501,
  request_id: 900,
  route: "Newcastle-Visakhapatnam",
  commodity: "Iron Ore",
  origin_port: "Newcastle",
  destination_port: "Visakhapatnam",
  shipment_date: "2026-10-01",
  cargo_weight_tons: 60000,
  shipment_mode: "Bulk Carrier",
  contract_duration_months: 6,
  total_program_tons: 240000,
  predicted_freight_rate_usd_per_ton: 10.32,
  risk_label: "high",
  risk_confidence: 0.596,
  recommended_vessel_type: "Panamax",
  recommended_charter_window: "Charter within the next 1–2 weeks (rate trending up)",
  summary: "For Iron Ore into Visakhapatnam, the route freight rate is forecast to rise to about $10.32/unit. Market risk is high. Charter within the next 1–2 weeks (rate trending up). Panamax is the smallest vessel class whose dataset-derived typical DWT can carry approximately 60,000 tonnes. Its typical draft of 13.5 m is within the destination port depth of 18.1 m. Freight rates are trending up, so consider chartering sooner rather than later.",
  vessel_status: "RECOMMENDED_VESSEL",
  vessel_rejection_reason: null,
  port_turnaround_days: 3.0,
  congestion_warning: "Load port Newcastle: medium congestion risk | Discharge port Visakhapatnam: high congestion risk",
  forecast_type: "synthetic_route",
  data_confidence: "low",
  data_source_level: "synthetic_route",
  forecast_curve: JSON.stringify([
  {
    "horizon": "H+1",
    "date": "2026-11-01",
    "predicted_rate": 10.32,
    "lower_bound": 9.56,
    "upper_bound": 10.93,
    "confidence": 0.867
  },
  {
    "horizon": "H+2",
    "date": "2026-12-01",
    "predicted_rate": 9.69,
    "lower_bound": 8.37,
    "upper_bound": 11.71,
    "confidence": 0.655
  },
  {
    "horizon": "H+3",
    "date": "2027-01-01",
    "predicted_rate": 7.01,
    "lower_bound": 6.23,
    "upper_bound": 7.87,
    "confidence": 0.766
  }
]),
};

// POST ml-service /compare-origins
const COMPARE = {
  "destination_port": "Visakhapatnam",
  "commodity": "Iron Ore",
  "note": "The freight-rate forecast reflects global dry-bulk market conditions and does not vary by loading port. Origins are ranked by vessel feasibility at both the load and discharge ports, estimated transit time, and load-port congestion — the factors that actually differ by origin for a fixed destination and commodity.",
  "results": [
    {
      "origin_port": "Nacala",
      "origin_country": "Mozambique",
      "predicted_freight_rate_usd_per_ton": 7.73,
      "risk_label": "high",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": true,
      "origin_port_congestion": "medium",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 3050,
      "estimated_transit_days": 10.2,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 13.2,
      "feasible": true,
      "vessel_status": "RECOMMENDED_VESSEL",
      "feasible_vessel_types": [
        "Panamax"
      ],
      "rank": 1
    },
    {
      "origin_port": "Newcastle",
      "origin_country": "Australia",
      "predicted_freight_rate_usd_per_ton": 10.32,
      "risk_label": "high",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": true,
      "origin_port_congestion": "medium",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 4400,
      "estimated_transit_days": 14.7,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 17.7,
      "feasible": true,
      "vessel_status": "RECOMMENDED_VESSEL",
      "feasible_vessel_types": [
        "Panamax"
      ],
      "rank": 2
    },
    {
      "origin_port": "Hay Point",
      "origin_country": "Australia",
      "predicted_freight_rate_usd_per_ton": 6.0,
      "risk_label": "high",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": true,
      "origin_port_congestion": "medium",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 4500,
      "estimated_transit_days": 15.0,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 18.0,
      "feasible": true,
      "vessel_status": "RECOMMENDED_VESSEL",
      "feasible_vessel_types": [
        "Panamax"
      ],
      "rank": 3
    },
    {
      "origin_port": "Gladstone",
      "origin_country": "Australia",
      "predicted_freight_rate_usd_per_ton": 9.97,
      "risk_label": "medium",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": true,
      "origin_port_congestion": "low",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 4550,
      "estimated_transit_days": 15.2,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 18.2,
      "feasible": true,
      "vessel_status": "RECOMMENDED_VESSEL",
      "feasible_vessel_types": [
        "Panamax"
      ],
      "rank": 4
    },
    {
      "origin_port": "Vostochny",
      "origin_country": "Russia",
      "predicted_freight_rate_usd_per_ton": 8.05,
      "risk_label": "high",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": true,
      "origin_port_congestion": "medium",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 5150,
      "estimated_transit_days": 17.2,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 20.2,
      "feasible": true,
      "vessel_status": "RECOMMENDED_VESSEL",
      "feasible_vessel_types": [
        "Panamax"
      ],
      "rank": 5
    },
    {
      "origin_port": "Norfolk",
      "origin_country": "United States",
      "predicted_freight_rate_usd_per_ton": 6.81,
      "risk_label": "medium",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": true,
      "origin_port_congestion": "low",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 10500,
      "estimated_transit_days": 35.0,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 38.0,
      "feasible": true,
      "vessel_status": "RECOMMENDED_VESSEL",
      "feasible_vessel_types": [
        "Panamax"
      ],
      "rank": 6
    },
    {
      "origin_port": "Baltimore",
      "origin_country": "United States",
      "predicted_freight_rate_usd_per_ton": 11.47,
      "risk_label": "medium",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": true,
      "origin_port_congestion": "low",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 10600,
      "estimated_transit_days": 35.3,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 38.3,
      "feasible": true,
      "vessel_status": "RECOMMENDED_VESSEL",
      "feasible_vessel_types": [
        "Panamax"
      ],
      "rank": 7
    },
    {
      "origin_port": "Murmansk",
      "origin_country": "Russia",
      "predicted_freight_rate_usd_per_ton": 13.98,
      "risk_label": "medium",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": true,
      "origin_port_congestion": "medium",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 10800,
      "estimated_transit_days": 36.0,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 39.0,
      "feasible": true,
      "vessel_status": "RECOMMENDED_VESSEL",
      "feasible_vessel_types": [
        "Panamax"
      ],
      "rank": 8
    },
    {
      "origin_port": "Taboneo",
      "origin_country": "Indonesia",
      "predicted_freight_rate_usd_per_ton": 11.64,
      "risk_label": "high",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": false,
      "origin_port_congestion": "high",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 2050,
      "estimated_transit_days": 6.8,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 9.8,
      "feasible": false,
      "vessel_status": "NO_FEASIBLE_VESSEL",
      "feasible_vessel_types": [],
      "rank": 9
    },
    {
      "origin_port": "Samarinda",
      "origin_country": "Indonesia",
      "predicted_freight_rate_usd_per_ton": 10.35,
      "risk_label": "high",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": false,
      "origin_port_congestion": "high",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 2200,
      "estimated_transit_days": 7.3,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 10.3,
      "feasible": false,
      "vessel_status": "NO_FEASIBLE_VESSEL",
      "feasible_vessel_types": [],
      "rank": 10
    },
    {
      "origin_port": "Beira",
      "origin_country": "Mozambique",
      "predicted_freight_rate_usd_per_ton": 7.82,
      "risk_label": "high",
      "recommended_vessel_type": "Panamax",
      "origin_port_vessel_ok": false,
      "origin_port_congestion": "high",
      "origin_port_congestion_source": "static port_infra.json rating (typical_congestion)",
      "distance_nm": 3200,
      "estimated_transit_days": 10.7,
      "port_turnaround_days": 3.0,
      "total_voyage_days": 13.7,
      "feasible": false,
      "vessel_status": "NO_FEASIBLE_VESSEL",
      "feasible_vessel_types": [],
      "rank": 11
    }
  ],
  "errors": []
};

// optimize() result from ml-service /coa-optimize (market_forecast trimmed)
const COA = {
  "status": "optimized",
  "route": "Newcastle-Visakhapatnam",
  "total_program_tons": 240000.0,
  "contract_duration_months": 6.0,
  "contract_duration_days": 182.6,
  "requested_cargo_weight_tons": 60000.0,
  "current_spot_rate_usd_per_ton": null,
  "spot_program_cost_usd": null,
  "best_strategy": {
    "vessel_type": "Panamax",
    "typical_dwt": 82000.0,
    "effective_cargo_tons_per_voyage": 73800.0,
    "voyages": 4,
    "average_parcel_tons": 60000.0,
    "estimated_cycle_days": 17.7,
    "contract_duration_days": 182.6,
    "required_schedule_days": 70.8,
    "schedule_slack_days": 111.8,
    "schedule_feasible": true,
    "schedule_note": "Fits inside the requested contract window.",
    "contract_rate_usd_per_ton": 9.46,
    "expected_freight_cost_usd": 2269680.0,
    "operational_index": 70.8,
    "risk_buffer_pct": 5.0
  },
  "alternatives": [
    {
      "vessel_type": "Panamax",
      "typical_dwt": 82000.0,
      "effective_cargo_tons_per_voyage": 73800.0,
      "voyages": 4,
      "average_parcel_tons": 60000.0,
      "estimated_cycle_days": 17.7,
      "contract_duration_days": 182.6,
      "required_schedule_days": 70.8,
      "schedule_slack_days": 111.8,
      "schedule_feasible": true,
      "schedule_note": "Fits inside the requested contract window.",
      "contract_rate_usd_per_ton": 9.46,
      "expected_freight_cost_usd": 2269680.0,
      "operational_index": 70.8,
      "risk_buffer_pct": 5.0
    }
  ],
  "estimated_savings_vs_spot_usd": null,
  "estimated_savings_vs_spot_pct": null,
  "recommendation_note": "No current spot benchmark supplied; ranking is operational and no monetary savings are claimed.",
  "market_forecast": {
    "route": "Newcastle-Visakhapatnam",
    "commodity": "Iron Ore",
    "forecast_type": "route_specific",
    "data_confidence": "low",
    "predicted_freight_rate_usd_per_ton": 10.32
  },
  "methodology": "Cargo/voyage was supplied, so it is used as a fixed lift size: only vessel classes able to carry it are considered, and voyage count is total_program_tons ÷ that lift size. Uses direct observed-route forecasts when available or an AIS-enhanced market proxy calibrated to a user-supplied spot benchmark otherwise, and adds a transparent risk buffer. It is not a broker/charter quote."
};

// POST ml-service /recommend for a what-if of 75,000 t per lift, 12 months
const WHATIF = {
  "route": "Newcastle-Visakhapatnam",
  "recommended_vessel_type": "Panamax",
  "feasible_vessel_types": [
    "Panamax"
  ],
  "vessel_constraint_note": "The recommended vessel is Panamax. Panamax is the smallest vessel class whose dataset-derived typical DWT can carry approximately 75,000 tonnes. Its typical draft of 13.5 m is within the destination port depth of 18.1 m. Freight rates are trending up, so consider chartering sooner rather than later.",
  "vessel_status": "RECOMMENDED_VESSEL",
  "vessel_rejection_reason": null,
  "rejected_vessel_types": [
    {
      "vessel_class": "Handysize",
      "typical_dwt": 35000.0,
      "typical_draft": 10.0,
      "typical_length": 180.0,
      "typical_beam": 30.0,
      "rejection_reason": "Cargo of 75,000 t exceeds Handysize's typical DWT capacity of 35,000 t."
    },
    {
      "vessel_class": "Supramax",
      "typical_dwt": 58000.0,
      "typical_draft": 12.5,
      "typical_length": 190.0,
      "typical_beam": 32.0,
      "rejection_reason": "Cargo of 75,000 t exceeds Supramax's typical DWT capacity of 58,000 t."
    },
    {
      "vessel_class": "Capesize",
      "typical_dwt": 181360.0,
      "typical_draft": 18.0,
      "typical_length": 292.0,
      "typical_beam": 45.0,
      "rejection_reason": "Newcastle draft limit: Capesize draft (18.0 m) exceeds the port usable depth (16.2 m)."
    }
  ],
  "recommended_charter_window": "Charter within the next 1–2 weeks (rate trending up)",
  "port_turnaround_days": 3.75,
  "idle_management_advice": "Turnaround and market direction look manageable; no special idle-time mitigation needed.",
  "congestion_warning": "Load port Newcastle: medium congestion risk | Discharge port Visakhapatnam: high congestion risk",
  "contracting_strategy": "Market volatility is high — a Contract of Affreightment (COA) over 12 months locking in today's terms across multiple voyages hedges against future rate spikes better than repeated spot fixtures. At 75,000t per lift, the 240,000t program implies roughly 4 voyages. Shipment mode is set to Bulk Carrier (spot voyage) — the figures above are framed as a single voyage-charter booking at the quoted per-ton rate.",
  "summary": "For Iron Ore into Visakhapatnam, the route freight rate is forecast to rise to about $10.32/unit. Market risk is high. Charter within the next 1–2 weeks (rate trending up). Panamax is the smallest vessel class whose dataset-derived typical DWT can carry approximately 75,000 tonnes. Its typical draft of 13.5 m is within the destination port depth of 18.1 m. Freight rates are trending up, so consider chartering sooner rather than later."
};

// GET ml-service /ais/port-radar, trimmed to three ports. Produced by the radar
// itself from SIMULATED AIS history (ml-service/app/ais_demo_seed.py): Visakhapatnam
// has a simulated congestion episode, Newcastle and Hay Point are normal.
const RADAR = {
  "generated_at": "2026-09-20T12:00:00+00:00",
  "window_hours": 6.0,
  "baseline_days": 7,
  "baseline_windows_usable": 7,
  "feed_active_now": true,
  "db_client": "sqlite",
  "data_source": "AISStream live AIS events persisted by FreightSight",
  "ports": [
    {
      "port": "Visakhapatnam",
      "status": "CRITICAL",
      "status_index": 3,
      "score": 11,
      "insufficient_reason": null,
      "window_hours": 6.0,
      "now": {
        "seen": 22,
        "waiting": 9,
        "moored": 4,
        "underway": 9,
        "unknown": 0,
        "avg_speed_kn": 3.49,
        "messages": 792
      },
      "baseline": {
        "seen": 13.0,
        "waiting": 3.0,
        "moored": 4.0,
        "underway": 6.0,
        "avg_speed_kn": 10.0,
        "windows_used": 7,
        "windows_requested": 7
      },
      "changes": {
        "seen_pct": 69.2,
        "waiting_pct": 200.0,
        "speed_pct": -65.1
      },
      "signal_points": {
        "waiting": 3,
        "density": 2,
        "speed": 3
      },
      "confidence": {
        "score": 100,
        "label": "High",
        "basis": "data coverage: baseline days with usable AIS, message volume now, and vessels typically observed. It measures how much evidence the numbers rest on, not the chance the assessment is right."
      },
      "impact": {
        "turnaround_pressure": "severe",
        "planning_assumption_days": 2.0,
        "assumption_note": "A fixed planning assumption for this status, not a measured or predicted delay. Use it as a starting value when running a what-if.",
        "recommendation": "Severe build-up versus normal. Consider alternate loading origins or a later charter window, and budget significant extra port time."
      }
    },
    {
      "port": "Hay Point",
      "status": "NORMAL",
      "status_index": 0,
      "score": 0,
      "insufficient_reason": null,
      "window_hours": 6.0,
      "now": {
        "seen": 12,
        "waiting": 2,
        "moored": 4,
        "underway": 6,
        "unknown": 0,
        "avg_speed_kn": 9.98,
        "messages": 432
      },
      "baseline": {
        "seen": 13.0,
        "waiting": 3.0,
        "moored": 4.0,
        "underway": 6.0,
        "avg_speed_kn": 10.0,
        "windows_used": 7,
        "windows_requested": 7
      },
      "changes": {
        "seen_pct": -7.7,
        "waiting_pct": -33.3,
        "speed_pct": -0.2
      },
      "signal_points": {
        "waiting": 0,
        "density": 0,
        "speed": 0
      },
      "confidence": {
        "score": 100,
        "label": "High",
        "basis": "data coverage: baseline days with usable AIS, message volume now, and vessels typically observed. It measures how much evidence the numbers rest on, not the chance the assessment is right."
      },
      "impact": {
        "turnaround_pressure": "low",
        "planning_assumption_days": 0.0,
        "assumption_note": "A fixed planning assumption for this status, not a measured or predicted delay. Use it as a starting value when running a what-if.",
        "recommendation": "No unusual congestion signals. Proceed with the standard charter window."
      }
    },
    {
      "port": "Newcastle",
      "status": "NORMAL",
      "status_index": 0,
      "score": 0,
      "insufficient_reason": null,
      "window_hours": 6.0,
      "now": {
        "seen": 12,
        "waiting": 2,
        "moored": 4,
        "underway": 6,
        "unknown": 0,
        "avg_speed_kn": 10.11,
        "messages": 432
      },
      "baseline": {
        "seen": 13.0,
        "waiting": 3.0,
        "moored": 4.0,
        "underway": 6.0,
        "avg_speed_kn": 10.1,
        "windows_used": 7,
        "windows_requested": 7
      },
      "changes": {
        "seen_pct": -7.7,
        "waiting_pct": -33.3,
        "speed_pct": 0.1
      },
      "signal_points": {
        "waiting": 0,
        "density": 0,
        "speed": 0
      },
      "confidence": {
        "score": 100,
        "label": "High",
        "basis": "data coverage: baseline days with usable AIS, message volume now, and vessels typically observed. It measures how much evidence the numbers rest on, not the chance the assessment is right."
      },
      "impact": {
        "turnaround_pressure": "low",
        "planning_assumption_days": 0.0,
        "assumption_note": "A fixed planning assumption for this status, not a measured or predicted delay. Use it as a starting value when running a what-if.",
        "recommendation": "No unusual congestion signals. Proceed with the standard charter window."
      }
    }
  ]
};

module.exports = { FORECAST_ROW, COMPARE, COA, WHATIF, RADAR };
