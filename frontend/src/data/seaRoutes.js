// frontend/src/data/seaRoutes.js
//
// Builds an indicative maritime corridor between an origin and destination
// port instead of drawing a straight line through land. This is a
// lightweight approximation, not a routing engine: every destination this
// app supports is an East Coast India discharge port, so we classify the
// origin by rough region and thread in the real-world chokepoint (strait
// or canal) chain a bulk carrier would actually use to get there.
//
// Two land-crossing traps this has to route around explicitly, because a
// naive "last chokepoint -> destination" straight line hits both:
//  1. India itself. Anything arriving from the Arabian Sea / southern
//     Indian Ocean (west or south of India) cannot cut straight across the
//     peninsula to an east-coast port — it has to round Cape Comorin
//     (India's southern tip) first.
//  2. Sri Lanka. Tuticorin sits in the Gulf of Mannar, on the west side of
//     Sri Lanka. It's a direct shot from Cape Comorin, but a vessel
//     arriving from the Bay of Bengal (east side) would otherwise draw a
//     line straight across Sri Lanka's landmass to get there — big bulk
//     carriers don't transit the shallow Palk Strait, so that leg has to
//     go around Sri Lanka's southern tip (Dondra Head) instead.

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
  // India's southern tip — the clearance point for anything moving between
  // the Arabian Sea/western Indian Ocean and the Bay of Bengal.
  capeComorin: { lat: 7.0, lng: 77.0 },
  // Sri Lanka's southern tip — the clearance point for anything moving
  // between the Bay of Bengal and the Gulf of Mannar (Tuticorin side).
  dondraHead: { lat: 5.9, lng: 80.6 },
  // Coastal hops offshore Australia's east coast (Coral Sea side), so the
  // line up to Torres Strait follows the coast instead of cutting across
  // Queensland/NSW.
  coralSeaMid: { lat: -25.5, lng: 154.3 },
  coralSeaNorth: { lat: -17.5, lng: 147.8 },
};

function pt(w) {
  return [w.lat, w.lng];
}

// Ports that sit on the "wrong" side of Sri Lanka relative to a Bay-of-
// Bengal approach — i.e. reachable directly from Cape Comorin, but only by
// rounding Dondra Head when arriving from the east.
const SRI_LANKA_SHADOWED_PORTS = new Set(["tuticorin"]);

function normalizedDest(name) {
  return String(name || "").trim().toLowerCase();
}

// Final leg into an East-Coast-India port. `approach` is "west" for
// traffic arriving via Cape Comorin (Arabian Sea / southern Indian Ocean
// origins) or "east" for traffic arriving via the Bay of Bengal (Malacca /
// Andaman / Lombok origins).
function finalApproach(destName, destPoint, approach) {
  if (approach === "east" && SRI_LANKA_SHADOWED_PORTS.has(normalizedDest(destName))) {
    return [pt(WAYPOINTS.dondraHead), destPoint];
  }
  return [destPoint];
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
    case "australia": {
      const points = [o];
      // Ports south of ~24°S (e.g. Newcastle, NSW) need an extra hop to
      // stay offshore on the way up to the Coral Sea leg.
      if (originCoords.lat < -24) points.push(pt(WAYPOINTS.coralSeaMid));
      points.push(pt(WAYPOINTS.coralSeaNorth), pt(WAYPOINTS.torresStrait), pt(WAYPOINTS.arafuraSea), pt(WAYPOINTS.bandaSea), pt(WAYPOINTS.lombokStrait));
      return [...points, ...finalApproach(destName, d, "east")];
    }
    case "indonesia":
      return [o, pt(WAYPOINTS.javaSea), pt(WAYPOINTS.singaporeStrait), pt(WAYPOINTS.malaccaStrait), pt(WAYPOINTS.andamanSea), ...finalApproach(destName, d, "east")];
    case "russiaPacific":
      return [o, pt(WAYPOINTS.koreaStrait), pt(WAYPOINTS.eastChinaSea), pt(WAYPOINTS.southChinaSea), pt(WAYPOINTS.singaporeStrait), pt(WAYPOINTS.malaccaStrait), pt(WAYPOINTS.andamanSea), ...finalApproach(destName, d, "east")];
    case "russiaArctic":
      return [o, pt(WAYPOINTS.northAtlantic), pt(WAYPOINTS.gibraltar), pt(WAYPOINTS.mediterranean), pt(WAYPOINTS.suez), pt(WAYPOINTS.redSea), pt(WAYPOINTS.babElMandeb), pt(WAYPOINTS.arabianSea), pt(WAYPOINTS.capeComorin), ...finalApproach(destName, d, "west")];
    case "usEastCoast":
      return [o, pt(WAYPOINTS.gibraltar), pt(WAYPOINTS.mediterranean), pt(WAYPOINTS.suez), pt(WAYPOINTS.redSea), pt(WAYPOINTS.babElMandeb), pt(WAYPOINTS.arabianSea), pt(WAYPOINTS.capeComorin), ...finalApproach(destName, d, "west")];
    case "mozambique":
      return [o, pt(WAYPOINTS.madagascarChannel), pt(WAYPOINTS.southIndianOcean), pt(WAYPOINTS.capeComorin), ...finalApproach(destName, d, "west")];
    default: {
      // No known chokepoint chain applies. Still worth clearing the same
      // two land masses rather than falling back to a straight/bowed line:
      // treat an origin east of India as a Bay-of-Bengal approach, and
      // anything else as a Cape-Comorin approach.
      const approach = originCoords.lng > 82 ? "east" : "west";
      const midLat = (originCoords.lat + destCoords.lat) / 2;
      const midLng = (originCoords.lng + destCoords.lng) / 2;
      const dx = destCoords.lng - originCoords.lng;
      const dy = destCoords.lat - originCoords.lat;
      const bow = 0.12;
      const bowed = [midLat - dx * bow, midLng + dy * bow];
      return [o, bowed, ...finalApproach(destName, d, approach)];
    }
  }
}

export default buildSeaRoute;
