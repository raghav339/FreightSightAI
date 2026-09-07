// backend/src/server.js
// Wires all routers together (see app.js) and starts listening. Split out
// of app.js so tests can import the app directly without binding a port.
const axios = require("axios");
const app = require("./app");
const { refreshDestinationPorts } = require("./config/destinationPorts");
const { ML_SERVICE_URL } = require("./utils/mlClient");

const PORT = process.env.PORT || 5000;

// Best-effort keep-alive: ping ml-service's /health periodically so it
// doesn't sit idle long enough for Render's free tier to spin it down
// (~15 min). This only helps while THIS backend process itself is awake —
// Render can just as easily idle the backend service too — so for a
// deploy that must never cold-start, pair this with an external uptime
// pinger (e.g. UptimeRobot/cron-job.org) hitting both services' /health
// endpoints every ~10 minutes. Set ML_KEEPALIVE=false to disable.
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

function pingMlServiceHealth() {
  axios
    .get(`${ML_SERVICE_URL}/health`, { timeout: 20000 })
    .catch((err) => {
      console.warn(`[keep-alive] ml-service ping failed: ${err.code || err.message}`);
    });
}

app.listen(PORT, () => {
  console.log(`FreightSight backend running on port ${PORT}`);
  console.log(`DB client: ${process.env.DB_CLIENT || "sqlite"}`);

  refreshDestinationPorts();

  if (process.env.NODE_ENV !== "test" && process.env.ML_KEEPALIVE !== "false") {
    pingMlServiceHealth(); // wake it immediately on backend boot/redeploy
    setInterval(pingMlServiceHealth, KEEPALIVE_INTERVAL_MS).unref();
  }
});
