// Maritime corridor waypoints used for the Voyage Route map.
// These are visual shipping corridors (not navigational guidance), chosen to
// follow open-ocean approaches and major maritime passages instead of drawing
// a straight line through land.

const INDIA_DESTS = new Set([
  "Paradip", "Visakhapatnam", "Gangavaram", "Gopalpur", "Dhamra",
  "Sagar Sandheads", "Haldia", "Chennai", "Kamarajar", "Tuticorin",
]);

const AUSTRALIA_ORIGINS = new Set(["Newcastle", "Hay Point", "Gladstone"]);
const INDONESIA_ORIGINS = new Set(["Samarinda", "Taboneo"]);
const MOZAMBIQUE_ORIGINS = new Set(["Nacala", "Beira"]);
const US_ORIGINS = new Set(["Norfolk", "Baltimore"]);

function finalIndiaApproach(destination) {
  if (destination === "Tuticorin") {
    return [
      [81.9, 5.5], // south of Sri Lanka
      [79.7, 5.8],
      [78.4, 7.4],
      [78.0, 8.4],
    ];
  }

  if (destination === "Chennai" || destination === "Kamarajar") {
    return [
      [81.9, 5.5],
      [83.0, 8.5],
      [82.4, 11.5],
    ];
  }

  return [
    [81.9, 5.5],
    [83.0, 8.5],
    [83.7, 12.0],
    [84.5, 15.0],
  ];
}

export function getSeaRouteWaypoints(origin, destination) {
  if (!origin || !destination || !INDIA_DESTS.has(destination)) return null;

  let waypoints;

  if (AUSTRALIA_ORIGINS.has(origin)) {
    // East-coast Australia -> Torres Strait -> Indonesia/Malacca ->
    // Bay of Bengal -> south of Sri Lanka -> India's east coast.
    waypoints = [
      "origin",
      [153.0, -26.0],
      [153.8, -18.0],
      [150.5, -12.0],
      [145.0, -10.5],
      [140.0, -9.0],
      [128.0, -7.0],
      [116.0, -3.0],
      [108.0, 0.0],
      [104.0, 2.5], // Malacca Strait / western entrance
      [96.0, 4.5],
      [90.0, 5.0],
      [84.5, 5.3],
      ...finalIndiaApproach(destination),
      "destination",
    ];
  } else if (INDONESIA_ORIGINS.has(origin)) {
    // Indonesian loading areas -> Java/Karimata passage -> Malacca ->
    // Bay of Bengal -> India.
    waypoints = [
      "origin",
      [116.5, -3.0],
      [113.0, -4.5],
      [109.0, -2.0],
      [106.0, 0.0],
      [103.8, 2.5],
      [96.0, 4.5],
      [90.0, 5.0],
      [84.5, 5.3],
      ...finalIndiaApproach(destination),
      "destination",
    ];
  } else if (MOZAMBIQUE_ORIGINS.has(origin)) {
    // Mozambique -> open Indian Ocean, kept east of Madagascar -> India.
    waypoints = [
      "origin",
      [43.0, -16.5],
      [50.5, -17.0],
      [60.0, -12.0],
      [69.0, -6.0],
      [76.0, -1.0],
      [81.9, 5.5],
      ...finalIndiaApproach(destination).slice(1),
      "destination",
    ];
  } else if (US_ORIGINS.has(origin)) {
    // US East Coast -> North/South Atlantic -> Cape route -> Indian Ocean.
    waypoints = [
      "origin",
      [-65.0, 31.0],
      [-48.0, 17.0],
      [-30.0, 2.0],
      [-18.0, -17.0],
      [-8.0, -29.0],
      [17.5, -37.0], // south of Cape of Good Hope
      [28.0, -34.5],
      [42.0, -29.0],
      [57.0, -20.0],
      [69.0, -10.0],
      [77.0, 0.0],
      [81.9, 5.5],
      ...finalIndiaApproach(destination).slice(1),
      "destination",
    ];
  } else if (origin === "Vostochny") {
    // Russian Far East -> South China Sea -> Malacca -> Indian Ocean.
    waypoints = [
      "origin",
      [130.0, 36.0],
      [125.0, 28.0],
      [120.0, 20.0],
      [116.0, 12.0],
      [111.0, 6.0],
      [104.0, 2.5],
      [96.0, 4.5],
      [90.0, 5.0],
      [84.5, 5.3],
      ...finalIndiaApproach(destination),
      "destination",
    ];
  } else if (origin === "Murmansk") {
    // Northern Europe -> Mediterranean -> Suez/Red Sea -> Arabian Sea.
    waypoints = [
      "origin",
      [24.0, 65.0],
      [10.0, 58.0],
      [-2.0, 47.0],
      [5.0, 39.0],
      [18.0, 36.0],
      [29.5, 34.0],
      [32.5, 31.2], // Port Said approach
      [32.5, 29.5], // Suez
      [35.5, 22.0],
      [42.0, 12.5], // Bab-el-Mandeb approach
      [50.0, 11.0],
      [60.0, 10.0],
      [70.0, 5.0],
      [81.9, 5.5],
      ...finalIndiaApproach(destination).slice(1),
      "destination",
    ];
  } else {
    // Safe fallback for any future origin: use a broad Indian Ocean corridor
    // rather than reverting to a straight chord across the map.
    waypoints = [
      "origin",
      [90.0, 5.0],
      [84.5, 5.3],
      ...finalIndiaApproach(destination),
      "destination",
    ];
  }

  return waypoints;
}

function resolveWaypoint(point, originCoords, destinationCoords) {
  if (point === "origin") return [originCoords.lat, originCoords.lng];
  if (point === "destination") return [destinationCoords.lat, destinationCoords.lng];
  return [point[1], point[0]]; // stored as [lng, lat]
}

export function buildSeaRoute(origin, destination, originCoords, destinationCoords) {
  const waypoints = getSeaRouteWaypoints(origin, destination);
  if (!waypoints || !originCoords || !destinationCoords) return null;

  const points = waypoints.map((point) =>
    resolveWaypoint(point, originCoords, destinationCoords)
  );

  return points;
}
