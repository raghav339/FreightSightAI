// backend/test/fixtures/disruptionBriefFixtures.js
//
// Representative shapes of ml-service POST /disruption/simulate and
// /disruption/live output (see app/utils.py::_build_disruption_response and
// app/disruption_engine.py), trimmed to the fields disruptionBrief.js reads.
"use strict";

const PROPAGATION = [
  { key: "event", label: "Tropical cyclone / severe storm", detail: "Paradip \u00b7 severity 85/100" },
  { key: "productivity", label: "Port productivity", detail: "-52% (port data coverage 100%)" },
  { key: "delay", label: "Loading delay", detail: "+8.9 days" },
  { key: "waiting", label: "Vessel waiting", detail: "+4.1 days" },
  { key: "freight", label: "Freight pressure", detail: "+9.6%" },
  { key: "eta", label: "ETA impact (port-side)", detail: "+13.0 days" },
  { key: "stockpile", label: "Stockpile buffer", detail: "Breached: 13.0d impact vs 5.0d buffer", breached: true },
  { key: "procurement", label: "Procurement action", detail: "Evaluate alternative loading/discharge ports or bring forward the next shipment." },
];

const ASSUMPTIONS = [
  "Event-type weights are relative engineering judgements, not measured or fitted values.",
  "Port exposure uses only static port master fields, not a live operational capacity feed.",
  "ETA impact here is PORT-SIDE only; it does not include weather-driven slowdown at sea.",
];

// Destination-port disruption where diverting clearly saves time — the
// Decision Brief should call "divert".
const DIVERT_RESULT = {
  port: "Paradip",
  port_role: "destination",
  disruption: {
    source: "simulated",
    event_type: "cyclone",
    event_label: "Tropical cyclone / severe storm",
    severity: 0.85,
    duration_days: 1.0,
    productivity_loss_pct: 0.52,
    loading_delay_days: 8.9,
    vessel_waiting_days: 4.1,
    freight_pressure_pct: 0.096,
    total_eta_impact_days: 13.0,
    propagation: PROPAGATION,
    assumptions: ASSUMPTIONS,
  },
  lane: {
    origin_port: "Newcastle",
    destination_port: "Paradip",
    commodity: "Coal",
    baseline_rate_usd_per_ton: 9.5,
    adjusted_rate_usd_per_ton: 10.41,
    freight_pressure_pct: 0.096,
    delta_usd_per_ton: 0.91,
    total_impact_usd: 45500,
    note: "The disruption is applied as a flat freight-pressure uplift on top of the model's own forecast for this lane.",
  },
  alternatives: {
    recommendation: "If Paradip becomes unavailable, divert to Visakhapatnam. It is about 210 nm from Paradip.",
    options: [
      {
        port: "Visakhapatnam", rank: 1, feasible: true,
        delay: { total_days: 2.5 }, freight: { delta_usd_per_ton: -0.3 },
        distance: { from_failed_nm: 210 },
      },
      {
        port: "Gangavaram", rank: 2, feasible: true,
        delay: { total_days: 3.1 }, freight: { delta_usd_per_ton: 0.1 },
        distance: { from_failed_nm: 240 },
      },
    ],
  },
  decision: {
    wait: { port: "Paradip", expected_delay_days: 13.0, freight_delta_usd_per_ton: 0.91 },
    alternative: { port: "Visakhapatnam", expected_delay_days: 2.5, freight_delta_usd_per_ton: -0.3, distance_from_disrupted_port_nm: 210 },
  },
  notes: [],
};

// Same port/event, but the alternative barely beats waiting it out — the
// Decision Brief should call "wait".
const WAIT_RESULT = {
  ...DIVERT_RESULT,
  disruption: { ...DIVERT_RESULT.disruption, severity: 0.2, total_eta_impact_days: 2.0, propagation: PROPAGATION.slice(0, 6) },
  decision: {
    wait: { port: "Paradip", expected_delay_days: 2.0, freight_delta_usd_per_ton: 0.1 },
    alternative: { port: "Visakhapatnam", expected_delay_days: 1.6, freight_delta_usd_per_ton: 0.0, distance_from_disrupted_port_nm: 210 },
  },
};

// No vessel-feasible alternative at all — must still recommend "wait".
const WAIT_NO_ALTERNATIVE_RESULT = {
  ...DIVERT_RESULT,
  alternatives: { recommendation: "No alternative found.", options: [] },
  decision: {
    wait: { port: "Paradip", expected_delay_days: 13.0, freight_delta_usd_per_ton: 0.91 },
    alternative: null,
  },
};

// A loading (origin) port disruption never gets a wait-vs-divert call.
const ORIGIN_RESULT = {
  port: "Newcastle",
  port_role: "origin",
  disruption: {
    source: "simulated",
    event_type: "port_closure",
    event_label: "Port closure (strike, incident, regulatory shutdown)",
    severity: 0.7,
    duration_days: 1.0,
    productivity_loss_pct: 0.6,
    loading_delay_days: 6.0,
    vessel_waiting_days: 3.0,
    freight_pressure_pct: 0.05,
    total_eta_impact_days: 9.0,
    propagation: PROPAGATION.slice(0, 6),
    assumptions: ASSUMPTIONS,
  },
  lane: null,
  alternatives: null,
  decision: null,
  notes: ["Newcastle is a loading port; to compare alternative loading ports for this lane, use compare-origins directly."],
};

// Live mode: same shape, plus live_conditions and source "live".
const LIVE_RESULT = {
  ...DIVERT_RESULT,
  disruption: { ...DIVERT_RESULT.disruption, source: "live" },
  live_conditions: {
    severity: 0.85,
    coverage: 1.0,
    conditions: { wind_speed_kmh: 120, wave_height_m: 6.2, precipitation_mm_h: 30, visibility_km: 2 },
  },
};

module.exports = { DIVERT_RESULT, WAIT_RESULT, WAIT_NO_ALTERNATIVE_RESULT, ORIGIN_RESULT, LIVE_RESULT };
