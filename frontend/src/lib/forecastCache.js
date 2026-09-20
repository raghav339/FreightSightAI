// Resilience mode — local cache of forecasts + reference metadata.
//
// Every successful /forecast response is written here. When the network
// drops (or is too slow to bother waiting on), ForecastForm reads back
// from this cache instead of failing outright — an exact match if one
// exists for the same route/commodity/cargo/date, otherwise the closest
// cargo-weight match on the same lane, clearly labelled as approximate.
//
// The same idea applies to /routes and /vessels: without a cached copy
// of those, the form can't even render its dropdowns offline, so they're
// cached too, on first successful load.
import { readJSON, writeJSON } from "./localCache.js";

const FORECASTS_KEY = "fs.cache.forecasts.v1";
const META_KEY = "fs.cache.meta.v1";
const VESSELS_KEY = "fs.cache.vessels.v1";
const MAX_FORECAST_ENTRIES = 30;

function exactKey({ commodity, origin_port, destination_port, cargo_weight_tons, shipment_date }) {
  return [commodity, origin_port, destination_port, cargo_weight_tons, shipment_date]
    .map((v) => String(v ?? "").trim().toLowerCase())
    .join("|");
}

export function saveForecastResult(payload, result) {
  const list = readJSON(FORECASTS_KEY, []);
  const key = exactKey(payload);
  const entry = {
    key,
    commodity: payload.commodity,
    origin_port: payload.origin_port,
    destination_port: payload.destination_port,
    cargo_weight_tons: Number(payload.cargo_weight_tons),
    shipment_date: payload.shipment_date,
    result,
    savedAt: Date.now(),
  };
  const next = [entry, ...list.filter((e) => e.key !== key)].slice(0, MAX_FORECAST_ENTRIES);
  writeJSON(FORECASTS_KEY, next);
}

export function getExactForecast(payload) {
  const list = readJSON(FORECASTS_KEY, []);
  return list.find((e) => e.key === exactKey(payload)) || null;
}

// Same lane + commodity, closest cargo weight, most recent among ties.
// Returns null when nothing on that lane has ever been cached.
export function getClosestForecast(payload) {
  const list = readJSON(FORECASTS_KEY, []);
  const targetCargo = Number(payload.cargo_weight_tons) || 0;
  const laneMatches = list.filter(
    (e) =>
      e.origin_port === payload.origin_port &&
      e.destination_port === payload.destination_port &&
      e.commodity === payload.commodity
  );
  if (laneMatches.length === 0) return null;
  laneMatches.sort((a, b) => {
    const diff = Math.abs(a.cargo_weight_tons - targetCargo) - Math.abs(b.cargo_weight_tons - targetCargo);
    if (diff !== 0) return diff;
    return b.savedAt - a.savedAt;
  });
  return laneMatches[0];
}

export function saveMeta(meta) {
  writeJSON(META_KEY, { data: meta, savedAt: Date.now() });
}

export function getMeta() {
  return readJSON(META_KEY, null);
}

export function saveVesselTypes(vesselTypes) {
  writeJSON(VESSELS_KEY, { data: vesselTypes, savedAt: Date.now() });
}

export function getVesselTypes() {
  return readJSON(VESSELS_KEY, null);
}
