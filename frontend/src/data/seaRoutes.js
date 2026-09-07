// Maritime corridor waypoints used for the Voyage Route map.
// These are visual shipping corridors (not navigational guidance), chosen to
// follow open-ocean approaches and major maritime passages instead of drawing
// a straight line through land.
//
// IMPORTANT: the map renders these as plain straight segments between
// consecutive points (no coastline-aware pathing). That means every pair of
// waypoints must itself have clear open water between them -- it's not enough
// for each individual point to be "in the ocean". When routes must cross an
// archipelago, prefer wide, well-known straits (Torres Strait, Lombok Strait,
// Bab-el-Mandeb, etc.) with generous margin, and add enough intermediate
// points that no single segment tries to cut a corner across a landmass.

const INDIA_DESTS = new Set([
  "Paradip", "Visakhapatnam", "Gangavaram", "Gopalpur", "Dhamra",
  "Sagar Sandheads", "Haldia", "Chennai", "Kamarajar", "Tuticorin",
]);

const AUSTRALIA_ORIGINS = new Set(["Newcastle", "Hay Point", "Gladstone"]);
const INDONESIA_ORIGINS = new Set(["Samarinda", "Taboneo"]);
const MOZAMBIQUE_ORIGINS = new Set(["Nacala", "Beira"]);
const US_ORIGINS = new Set(["Norfolk", "Baltimore"]);

// Shared open-ocean corridor once a route has cleared the Indonesian
// archipelago to the south and is heading northwest across the Indian Ocean
// toward the Bay of Bengal. Reused by the Australia and Indonesia branches.
const SOUTH_OF_JAVA_TO_BAY_OF_BENGAL = [
  [110.0, -13.0], // open Indian Ocean, well south of Java's south coast
  [97.0, -8.0],   // open ocean, well south/west of Sumatra
  [88.0, -2.0],   // open ocean, west of the Nicobar Islands
  [84.5, 5.3],    // Bay of Bengal, open water
];

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
    // East-coast Australia -> Coral Sea -> Torres Strait -> Arafura Sea ->
    // south of Timor/Sumba/Java/Sumatra (open Indian Ocean, avoids
    // threading the Java Sea / Malacca Strait entirely) -> Bay of Bengal ->
    // India's east coast.
    waypoints = [
      "origin",
      [153.0, -26.0],
      [153.8, -18.0],
      [150.5, -12.0],
      [145.0, -10.5],
      [142.3, -10.4], // Torres Strait (Prince of Wales Channel)
      [135.0, -10.5], // Arafura Sea, south of the Aru Islands
      [128.0, -11.5], // Timor Sea, south of Timor
      [120.0, -13.0], // south of Sumba, into open Indian Ocean
      ...SOUTH_OF_JAVA_TO_BAY_OF_BENGAL,
      ...finalIndiaApproach(destination),
      "destination",
    ];
  } else if (INDONESIA_ORIGINS.has(origin)) {
    // Indonesian loading areas sit inside the archipelago, so these route
    // out via Makassar Strait / the Java Sea and then south through the
    // Lombok Strait (wide, deep, and a standard shipping passage) into the
    // open Indian Ocean, joining the same southern corridor as the
    // Australia route.
    waypoints = [
      "origin",
      origin === "Samarinda"
        ? [118.0, -2.0] // Makassar Strait, heading south from east Kalimantan
        : [114.8, -4.5], // Java Sea, heading southeast from south Kalimantan
      [116.5, -6.0], // Flores/Bali Sea, north of Lombok
      [115.5, -8.6], // Lombok Strait
      [113.0, -11.0], // open Indian Ocean, south of Bali/Lombok
      ...SOUTH_OF_JAVA_TO_BAY_OF_BENGAL,
      ...finalIndiaApproach(destination),
      "destination",
    ];
  } else if (MOZAMBIQUE_ORIGINS.has(origin)) {
    // Mozambique -> north through the Mozambique Channel, clearing
    // Madagascar's northern tip (Cap d'Ambre) rather than cutting straight
    // across the island -> open Indian Ocean -> India.
    waypoints = [
      "origin",
      [42.0, -14.0], // mid Mozambique Channel
      [45.0, -11.5], // channel narrowing, east of the Comoros
      [50.5, -11.0], // clear of Madagascar's northern tip
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
      [28.0, -35.5], // clear of South Africa's south coast
      [42.0, -29.0],
      [57.0, -20.0],
      [69.0, -10.0],
      [77.0, 0.0],
      [81.9, 5.5],
      ...finalIndiaApproach(destination).slice(1),
      "destination",
    ];
  } else if (origin === "Vostochny") {
    // Russian Far East -> Sea of Japan -> East China Sea -> South China Sea
    // -> Malacca -> Indian Ocean.
    waypoints = [
      "origin",
      [131.0, 37.0], // Sea of Japan, clear of the Korean coast
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