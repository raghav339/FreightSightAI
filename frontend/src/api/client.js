// frontend/src/api/client.js
import axios from "axios";
import { notifyMlWakeup } from "./mlWakeup.js";

// In dev, Vite proxies "/api" to the local backend (see vite.config.js).
// In production, set VITE_API_URL to your deployed backend's URL, e.g.
// https://your-backend.onrender.com/api
//
// Render enforces a hard ~100s proxy timeout on every HTTP request it
// fronts, including this one — no client setting can raise that ceiling,
// it can only hide it behind an earlier, more confusing client-side abort.
// The backend's own ml-service retry logic (see backend/src/utils/mlClient.js)
// is sized to respond within ~90-95s worst case specifically so it fits
// under that ceiling with room to spare. 95s here means "wait at least as
// long as the backend might legitimately take," so a slow cold start
// surfaces as the backend's own clean 503 response rather than an axios
// ECONNABORTED that looks identical to a network failure.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api",
  timeout: 95000,
});

// Attach the signed-in user's JWT (if any) to every request. AuthContext
// keeps this key in sync with its React state.
//
// Wakeup UX: routes that proxy through to ml-service can legitimately sit
// quiet for tens of seconds on a Render cold start. Rather than let that
// look indistinguishable from a hang, start timers on every request to one
// of these paths and tell any subscribed UI (see components/WakingBanner.jsx)
// so it can show a hint instead of leaving the user staring at a static form.
//
// Two-tier timing: a warm instance doing real model inference + network
// round trip routinely takes a few seconds on its own — that is NOT a cold
// start, and saying "waking up... up to a minute" at that point is just
// wrong and trains people to distrust the banner. So we show a neutral
// "still working" hint fairly quickly (SLOW_HINT_DELAY_MS), and only
// escalate to actual cold-start copy if the request is still outstanding
// much later (COLD_START_DELAY_MS) — which is the regime where a real
// Render free-tier boot is the likely explanation.
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
const FAN_OUT_PATH_HINTS = ["/compare-origins", "/idle-alternatives"];
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

  if (looksMlBacked(config.url)) {
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