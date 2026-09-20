import axios from "axios";
import { notifyMlWakeup } from "./mlWakeup.js";
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api",
  timeout: 95000,
});

const ML_BACKED_PATH_HINTS = [
  "/forecast", "/route-forecast", "/coa-optimize", "/compare-origins",
  "/idle-alternatives", "/whatif", "/routes", "/vessels", "/ports",
  "/dashboard-summary", "/ais/",
];
// These two fan out across every loading port on ml-service (11 today),
// each doing a model call + a live AIS lookup — genuinely slower than a
// single-origin call even when ml-service is fully warm. Calling that
// "waking up the forecasting service" is misleading (it isn't asleep,
// it's just doing 11x the work), so they get their own banner phase/copy
// instead of being lumped in with an actual cold-start probe.
const FAN_OUT_PATH_HINTS = ["/compare-origins", "/idle-alternatives", "/decision-brief"];
const SLOW_HINT_DELAY_MS = 4000;
const COLD_START_DELAY_MS = 15000;

function looksMlBacked(url = "") {
  return ML_BACKED_PATH_HINTS.some((path) => url.includes(path));
}

function looksFanOut(url = "") {
  return FAN_OUT_PATH_HINTS.some((path) => url.includes(path));
}

function clearSlowTimers(config) {
  if (config?.__mlSlowTimer) {
    clearTimeout(config.__mlSlowTimer);
    config.__mlSlowTimer = undefined;
  }
  if (config?.__mlColdStartTimer) {
    clearTimeout(config.__mlColdStartTimer);
    config.__mlColdStartTimer = undefined;
  }
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("freightsight_token");
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Background enrichment calls (e.g. the port-radar strip on the forecast page)
  // opt out with `skipWakeBanner` so a slow one doesn't hijack the page with a
  // "waking up" banner the user did not cause.
  if (looksMlBacked(config.url) && !config.skipWakeBanner) {
    const isFanOut = looksFanOut(config.url);
    // Tier 1: quick, honest "still working" hint — never claims a cold start.
    config.__mlSlowTimer = setTimeout(() => {
      notifyMlWakeup({ active: true, phase: isFanOut ? "comparing" : "working" });
    }, SLOW_HINT_DELAY_MS);
    // Tier 2: only for single-origin calls, only after a genuinely long
    // wait, escalate to the cold-start-specific copy. Fan-out calls stay on
    // "comparing" the whole time since their slowness is explained already.
    if (!isFanOut) {
      config.__mlColdStartTimer = setTimeout(() => {
        notifyMlWakeup({ active: true, phase: "probing" });
      }, COLD_START_DELAY_MS);
    }
  }

  return config;
});

// The backend answers with 503 + { retryable: true } specifically when its
// own cold-start retry was exhausted (see sendMlError in
// backend/src/utils/mlClient.js) — never for validation errors or other
// failures. That's a deliberate, narrow signal: it's safe to try exactly
// once more here, because by now the service has likely finished booting
// even if the first round-trip didn't survive to see it.
api.interceptors.response.use(
  (response) => {
    clearSlowTimers(response.config);
    notifyMlWakeup({ active: false });
    return response;
  },
  async (error) => {
    const config = error.config;
    clearSlowTimers(config);

    const retryable = error.response?.status === 503 && error.response?.data?.retryable === true;

    if (retryable && config && !config.__mlRetried) {
      config.__mlRetried = true;
      const retryAfterSec = Number(error.response.headers?.["retry-after"]);
      const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 3000;

      notifyMlWakeup({ active: true, phase: "retrying" });
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      try {
        const retried = await api.request(config);
        notifyMlWakeup({ active: false });
        return retried;
      } catch (retryErr) {
        notifyMlWakeup({ active: false, phase: "failed" });
        return Promise.reject(retryErr);
      }
    }

    notifyMlWakeup({ active: false });
    return Promise.reject(error);
  }
);

export default api;