// Approximate lat/lng for every port FreightSight AI's model knows about
// (see ml-service/train.py EAST_COAST + origins list, and
// ml-service/data/world_port_index_clean.csv for the India discharge ports).
// Used only to place markers/route lines on the map — not fed into the model.
export const PORT_COORDINATES = {
  // Loading (origin) ports
  Newcastle: { lat: -32.9283, lng: 151.7817, country: "Australia" },
  "Hay Point": { lat: -21.2833, lng: 149.2833, country: "Australia" },
  Gladstone: { lat: -23.8489, lng: 151.25, country: "Australia" },
  Norfolk: { lat: 36.8508, lng: -76.2859, country: "United States" },
  Baltimore: { lat: 39.2904, lng: -76.6122, country: "United States" },
  Nacala: { lat: -14.5628, lng: 40.6728, country: "Mozambique" },
  Beira: { lat: -19.8317, lng: 34.8389, country: "Mozambique" },
  Vostochny: { lat: 42.7333, lng: 133.0833, country: "Russia" },
  Murmansk: { lat: 68.9585, lng: 33.0827, country: "Russia" },
  Samarinda: { lat: -0.5021, lng: 117.1536, country: "Indonesia" },
  Taboneo: { lat: -3.6167, lng: 114.5333, country: "Indonesia" },

  // Discharge (destination) ports — India east coast
  Paradip: { lat: 20.2667, lng: 86.7, country: "India" },
  Visakhapatnam: { lat: 17.6868, lng: 83.2185, country: "India" },
  Gangavaram: { lat: 17.63, lng: 83.23, country: "India" },
  Gopalpur: { lat: 19.26, lng: 84.9, country: "India" },
  Dhamra: { lat: 20.78, lng: 86.92, country: "India" },
  "Sagar Sandheads": { lat: 21.2, lng: 88.0, country: "India" },
  Haldia: { lat: 22.03, lng: 88.06, country: "India" },
  Chennai: { lat: 13.0827, lng: 80.2707, country: "India" },
  Kamarajar: { lat: 13.25, lng: 80.34, country: "India" },
  Tuticorin: { lat: 8.7642, lng: 78.1348, country: "India" },
};

export function getPortCoords(name) {
  if (!name) return null;
  return PORT_COORDINATES[name] || null;
}