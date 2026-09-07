// backend/src/config/destinationPorts.js
// Single source of truth for the East Coast India destination ports list.
// Kept as a static fallback but refreshed from the ML service's /meta
// endpoint so validateForecast.js never drifts from ml-service/train.py's
// EAST_COAST list.
const axios = require("axios");

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://127.0.0.1:8001";

let cachedPorts = new Set([
  "Paradip", "Visakhapatnam", "Gangavaram", "Gopalpur",
  "Dhamra", "Sagar Sandheads", "Haldia", "Chennai", "Kamarajar", "Tuticorin",
]);

async function refreshDestinationPorts() {
  try {
    const { data } = await axios.get(`${ML_SERVICE_URL}/meta`, { timeout: 5000 });
    if (Array.isArray(data.destinations) && data.destinations.length) {
      cachedPorts = new Set(data.destinations);
    }
  } catch (err) {
    console.error(
      "Could not refresh destination ports from ML service, using fallback list:",
      err.message
    );
  }
}

function getDestinationPorts() {
  return cachedPorts;
}

module.exports = { getDestinationPorts, refreshDestinationPorts };
