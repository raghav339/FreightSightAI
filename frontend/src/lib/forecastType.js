// frontend/src/lib/forecastType.js
//
// Single source of truth for how the app talks about `forecast_type` in the
// UI. Before this file existed, several components each hardcoded their own
// "BDRY ..." strings and only some of them branched on forecast_type — so a
// synthetic-route or route-specific forecast still showed BDRY-branded
// labels ("BDRY freight-rate proxy", "BDRY ETF proxy — not a quoted
// USD/ton charter rate") even though no BDRY signal was involved. Every
// place that needs to describe the forecast basis should import from here
// instead of writing its own copy, so the four (and any future) values of
// forecast_type are handled consistently everywhere.
//
// Mirrors FORECAST_TYPE_BASIS_PHRASE in ml-service/app/decision_text.py —
// keep the two in sync when a new forecast_type is introduced.

export const FORECAST_TYPE_INFO = {
  market_proxy: {
    label: "BDRY market proxy",
    statLabel: "BDRY freight-rate proxy",
    basis: "BDRY dry-bulk market proxy",
    source: "Historical BDRY + operational features",
    valueUnitNote: "BDRY ETF proxy — not a quoted USD/ton charter rate",
    disclaimer:
      "Freight forecast uses a market-index (BDRY) proxy because route-level freight observations are unavailable for this lane. It is not an observed route-specific freight rate.",
  },
  synthetic_route: {
    label: "Synthetic route freight",
    statLabel: "Synthetic route freight",
    basis: "Synthetic route freight rate (MVP)",
    source: "synthetic_route_freight_rates.csv (MVP development dataset)",
    valueUnitNote: "Synthetic MVP data — not a quoted USD/ton charter rate",
    disclaimer:
      "MVP data notice: route freight rates are synthetic development data supplied for demonstration. They are not broker quotes, observed market rates, or real-time fixtures.",
  },
  route_specific: {
    label: "Route-specific freight",
    statLabel: "Route-specific freight rate",
    basis: "Verified route freight",
    source: "Verified route freight observations",
    valueUnitNote: "Route-specific model — USD/ton freight rate",
    disclaimer: null,
  },
  observed_route: {
    label: "Observed route freight",
    statLabel: "Observed route freight rate",
    basis: "Observed route freight",
    source: "Observed route freight quotes",
    valueUnitNote: "Observed market quote — USD/ton freight rate",
    disclaimer: null,
  },
  ais_enhanced_route_proxy: {
    label: "AIS-enhanced route proxy",
    statLabel: "AIS-enhanced route proxy",
    basis: "AIS-enhanced market proxy",
    source: "AIS vessel-tracking features + BDRY market series",
    valueUnitNote: "AIS-enhanced proxy — not a quoted USD/ton charter rate",
    disclaimer:
      "Freight forecast blends AIS vessel-tracking activity with the BDRY market index because direct route-level freight observations are unavailable for this lane. It is not an observed route-specific freight rate.",
  },
};

const DEFAULT_FORECAST_TYPE = "market_proxy";

// Always returns a usable info object — falls back to the market_proxy
// entry for an unrecognized or missing forecast_type, the same fallback
// behavior as the Python-side forecast_basis_phrase().
export function getForecastTypeInfo(forecastType) {
  return FORECAST_TYPE_INFO[forecastType] || FORECAST_TYPE_INFO[DEFAULT_FORECAST_TYPE];
}

// Route-based forecast types are backed by an actual route freight series
// (real or synthetic route observations, with genuine month-by-month
// history and an H+1/H+2/H+3 curve from the route model) rather than the
// BDRY dry-bulk index. `ais_enhanced_route_proxy` is still fundamentally a
// BDRY-blended proxy — no route history/curve backs it — so it stays out
// of this set and continues to use the BDRY chart.
const ROUTE_BASED_FORECAST_TYPES = new Set(["synthetic_route", "route_specific", "observed_route"]);

export function isRouteBasedForecast(forecastType) {
  return ROUTE_BASED_FORECAST_TYPES.has(forecastType);
}