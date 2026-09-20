// frontend/src/data/portCoordinates.js
//
// Lat/lng lookup for every loading (origin) and discharge (destination)
// port this app knows about. Used by RouteMap.jsx to place markers and
// plot an indicative maritime corridor — not a navigation-grade source.
//
// Coordinates are the port/anchorage's publicly known position (public
// port-index / gazetteer data), rounded to 4 decimal places.

const PORT_COORDS = {
  // Australia — coal loading (Queensland / NSW)
  "newcastle": { lat: -32.9167, lng: 151.7833 },
  "gladstone": { lat: -23.85, lng: 151.25 },
  "hay point": { lat: -21.2833, lng: 149.3 },

  // United States — East Coast
  "norfolk": { lat: 36.85, lng: -76.3 },
  "baltimore": { lat: 39.2667, lng: -76.5833 },

  // Mozambique
  "nacala": { lat: -14.5333, lng: 40.6667 },
  "beira": { lat: -19.8333, lng: 34.8333 },

  // Russia
  "vostochny": { lat: 42.75, lng: 133.0833 },
  "murmansk": { lat: 68.9833, lng: 33.05 },

  // Indonesia
  "samarinda": { lat: -0.5167, lng: 117.1167 },
  "taboneo": { lat: -3.6994, lng: 114.4586 },

  // India — East Coast discharge ports
  "paradip": { lat: 20.2667, lng: 86.6833 },
  "visakhapatnam": { lat: 17.6983, lng: 83.2786 },
  "gangavaram": { lat: 17.6246, lng: 83.2404 },
  "gopalpur": { lat: 19.25, lng: 84.9167 },
  "dhamra": { lat: 20.7966, lng: 86.9064 },
  "sagar sandheads": { lat: 20.85, lng: 88.25 },
  "haldia": { lat: 22.0167, lng: 88.0833 },
  "chennai": { lat: 13.1, lng: 80.3 },
  "kamarajar": { lat: 13.2667, lng: 80.3167 },
  "tuticorin": { lat: 8.8, lng: 78.1667 },
};

// Alternate spellings/names seen elsewhere in the app or API responses.
const ALIASES = {
  "vostochnyy": "vostochny",
  "kamarajar port": "kamarajar",
  "ennore": "kamarajar",
  "haldia port": "haldia",
  "sandheads": "sagar sandheads",
  "chennai (madras)": "chennai",
  "madras": "chennai",
  "paradip port": "paradip",
};

function normalize(name) {
  return String(name || "").trim().toLowerCase();
}

/**
 * Look up a port's {lat, lng} by name. Case-insensitive, with a small
 * alias table for alternate spellings. Returns null if unknown.
 */
export function getPortCoords(name) {
  const key = normalize(name);
  if (!key) return null;
  if (PORT_COORDS[key]) return PORT_COORDS[key];
  if (ALIASES[key] && PORT_COORDS[ALIASES[key]]) return PORT_COORDS[ALIASES[key]];
  return null;
}

export default PORT_COORDS;
