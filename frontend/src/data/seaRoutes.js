// frontend/src/data/seaRoutes.js
//
// Builds an indicative maritime corridor between an origin and destination
// port instead of drawing a straight line through land. This is a
// lightweight approximation, not a routing engine: every destination this
// app supports is an East Coast India discharge port, so we classify the
// origin by rough region and thread in the real-world chokepoint (strait
// or canal) chain a bulk carrier would actually use to get there.

const WAYPOINTS = {
  torresStrait: { lat: -10.6, lng: 142.2 },
  arafuraSea: { lat: -8.5, lng: 132.0 },
  bandaSea: { lat: -6.2, lng: 127.5 },
  lombokStrait: { lat: -8.7, lng: 115.7 },
  javaSea: { lat: -5.5, lng: 110.0 },
  singaporeStrait: { lat: 1.2, lng: 103.8 },
  malaccaStrait: { lat: 4.0, lng: 98.0 },
  andamanSea: { lat: 8.0, lng: 95.0 },
  koreaStrait: { lat: 34.0, lng: 129.0 },
  eastChinaSea: { lat: 28.0, lng: 124.0 },
  southChinaSea: { lat: 15.0, lng: 115.0 },
  madagascarChannel: { lat: -15.0, lng: 45.0 },
  southIndianOcean: { lat: -10.0, lng: 70.0 },
  gibraltar: { lat: 35.9, lng: -5.6 },
  mediterranean: { lat: 34.0, lng: 18.0 },
  suez: { lat: 31.2, lng: 32.3 },
  redSea: { lat: 20.0, lng: 38.0 },
  babElMandeb: { lat: 12.5, lng: 43.3 },
  arabianSea: { lat: 15.0, lng: 65.0 },
  northAtlantic: { lat: 48.0, lng: -12.0 },
};

function pt(w) {
  return [w.lat, w.lng];
}

// Rough region bucket for an origin, based on its coordinates, used to
// pick a chokepoint chain toward the Bay of Bengal.
function classifyOrigin(lat, lng) {
  if (lat < -15 && lat > -38 && lng > 140 && lng < 155) return "australia";
  if (lat < 5 && lat > -12 && lng > 108 && lng < 122) return "indonesia";
  if (lat > 25 && lng > 120) return "russiaPacific";
  if (lat > 55) return "russiaArctic";
  if (lat > 25 && lat < 48 && lng < -50) return "usEastCoast";
  if (lat < -5 && lat > -28 && lng > 30 && lng < 46) return "mozambique";
  return "other";
}

/**
 * Returns an array of [lat, lng] points describing an indicative sea
 * corridor from origin to destination, or null if either endpoint is
 * missing. The first and last points are always the exact origin/
 * destination coordinates.
 */
export function buildSeaRoute(originName, destName, originCoords, destCoords) {
  if (!originCoords || !destCoords) return null;

  const region = classifyOrigin(originCoords.lat, originCoords.lng);
  const o = pt(originCoords);
  const d = pt(destCoords);

  switch (region) {
    case "australia":
      return [o, pt(WAYPOINTS.torresStrait), pt(WAYPOINTS.arafuraSea), pt(WAYPOINTS.bandaSea), pt(WAYPOINTS.lombokStrait), d];
    case "indonesia":
      return [o, pt(WAYPOINTS.javaSea), pt(WAYPOINTS.singaporeStrait), pt(WAYPOINTS.malaccaStrait), pt(WAYPOINTS.andamanSea), d];
    case "russiaPacific":
      return [o, pt(WAYPOINTS.koreaStrait), pt(WAYPOINTS.eastChinaSea), pt(WAYPOINTS.southChinaSea), pt(WAYPOINTS.singaporeStrait), pt(WAYPOINTS.malaccaStrait), pt(WAYPOINTS.andamanSea), d];
    case "russiaArctic":
      return [o, pt(WAYPOINTS.northAtlantic), pt(WAYPOINTS.gibraltar), pt(WAYPOINTS.mediterranean), pt(WAYPOINTS.suez), pt(WAYPOINTS.redSea), pt(WAYPOINTS.babElMandeb), pt(WAYPOINTS.arabianSea), d];
    case "usEastCoast":
      return [o, pt(WAYPOINTS.gibraltar), pt(WAYPOINTS.mediterranean), pt(WAYPOINTS.suez), pt(WAYPOINTS.redSea), pt(WAYPOINTS.babElMandeb), pt(WAYPOINTS.arabianSea), d];
    case "mozambique":
      return [o, pt(WAYPOINTS.madagascarChannel), pt(WAYPOINTS.southIndianOcean), d];
    default: {
      // No known chokepoint chain applies (e.g. a short India-to-India
      // hop) — draw a gently bowed curve so it still reads as a sea
      // track rather than a ruler-straight line.
      const midLat = (originCoords.lat + destCoords.lat) / 2;
      const midLng = (originCoords.lng + destCoords.lng) / 2;
      const dx = destCoords.lng - originCoords.lng;
      const dy = destCoords.lat - originCoords.lat;
      const bow = 0.12;
      const bowed = [midLat - dx * bow, midLng + dy * bow];
      return [o, bowed, d];
    }
  }
}

export default buildSeaRoute;
