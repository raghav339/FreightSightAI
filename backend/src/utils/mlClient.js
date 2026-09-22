// backend/src/utils/mlClient.js
//
// Shared retry/backoff wrapper for every backend->ml-service axios call.
//
// Why this exists: on Render's free tier, ml-service spins down after ~15
// min idle. Waking it back up means booting a container, importing
// pandas/scikit-learn/FastAPI, and joblib.load()-ing a 500-tree
// RandomForest plus the risk model and encoder — commonly 60-120s. Every
// route here used a single axios call with a short, fixed timeout and no
// retry: the first request after idle would time out, throw once, and the
// route handler would return a 502 with nothing ever trying again.
//
// withRetry() wraps that single call so a timeout/connection failure
// during a cold start is retried with a much longer timeout instead of
// surfacing immediately. It deliberately does NOT retry on 4xx responses
// (bad input) or errors without a network/timeout signature, so it never
// masks a genuine backend/ml-service bug as a retryable cold start.
//
// Render also enforces a hard ~100s proxy timeout on every HTTP request
// regardless of client settings, so retries are capped to stay under that
// — waiting longer than Render itself will wait is pointless and just
// turns a clean error into a dropped connection.

const axios = require("axios");
const { currentLang } = require("../middleware/lang");

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://127.0.0.1:8001";

// Forward the caller's language to the ML service on every request the backend makes to
// it, so decision text comes back in that language (see middleware/lang.js).
function attachLang(config) {
  const lang = currentLang();
  if (lang && typeof config.url === "string" && config.url.startsWith(ML_SERVICE_URL)) {
    if (config.headers && typeof config.headers.set === "function") config.headers.set("X-Lang", lang);
    else config.headers = { ...(config.headers || {}), "X-Lang": lang };
  }
  return config;
}
axios.interceptors?.request?.use?.(attachLang);

// How long a retried attempt is allowed to sit waiting for a cold boot +
// model load. Render enforces a hard ~100s proxy timeout on EVERY HTTP
// request it fronts — including the browser's request to our own
// backend — no client or server timeout setting can raise that. So the
// combined time this module spends (initial attempt + backoff + this
// retry timeout) has to stay comfortably under 100s, or Render's edge
// kills the browser's connection before our own 503 response body ever
// gets sent, turning a clean "still waking up" reply into a raw network
// error. Callers should therefore pass a SHORT initialTimeout (a quick
// "is it already warm?" probe) and lean on this one longer retry to
// actually ride out a cold start.
const COLD_START_TIMEOUT_MS = Number(process.env.ML_COLD_START_TIMEOUT_MS) || 80000;

// Delay before each retry, in ms, indexed by attempt number.
const BACKOFF_SCHEDULE_MS = [1200, 3000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only retry failures that look like "the service wasn't there / wasn't
// ready yet" — never retry validation errors (4xx) or anything without a
// network/timeout signature, since retrying those would just waste time
// and delay a genuine error reaching the user.
function isRetryable(err) {
  if (!err) return false;
  if (
    err.code === "ECONNABORTED" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ETIMEDOUT" ||
    err.code === "ENOTFOUND" ||
    err.code === "EAI_AGAIN"
  ) {
    return true;
  }
  if (err.response && err.response.status >= 500) return true;
  return false;
}

// True once withRetry has genuinely exhausted its attempts on what looks
// like a cold-start/availability failure — used by route handlers to
// decide whether to answer 503 ("still waking up, try again shortly")
// instead of a flat 502.
function isColdStartFailure(err) {
  return isRetryable(err);
}

/**
 * Runs `attemptFn(timeoutMs, attemptNumber)` with retry + backoff.
 *
 * `attemptFn` should perform the actual axios.get/post call using the
 * timeout it's given and return the result (or throw). The first attempt
 * uses `initialTimeout` (the endpoint's normal, warm-service timeout);
 * every retry after that uses COLD_START_TIMEOUT_MS, since a retry only
 * happens after something that looks like a cold start.
 *
 * @param {(timeoutMs: number, attempt: number) => Promise<any>} attemptFn
 * @param {{ initialTimeout: number, retries?: number, coldTimeout?: number }} options
 */
async function withRetry(attemptFn, { initialTimeout, retries = 1, coldTimeout = COLD_START_TIMEOUT_MS }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeout = attempt === 0 ? initialTimeout : coldTimeout;
    try {
      return await attemptFn(timeout, attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      const backoff = BACKOFF_SCHEDULE_MS[attempt] ?? 3000;
      console.warn(
        `[ml-service] request failed (${err.code || err.response?.status || err.message}) — ` +
          `retrying (attempt ${attempt + 2}/${retries + 1}) in ${backoff}ms with a ${coldTimeout}ms timeout, ` +
          `likely a Render cold start`
      );
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * Standard error responder for ml-service proxy routes. Sends 503 (with
 * Retry-After) when the failure looks like an exhausted cold-start retry,
 * the endpoint's own 400 detail when ml-service rejected the input, or a
 * flat 502 for anything else.
 */
function sendMlError(res, err, fallbackMessage) {
  if (err.response?.status === 400) {
    return res.status(400).json({ error: err.response.data?.detail || fallbackMessage });
  }
  if (isColdStartFailure(err)) {
    return res
      .status(503)
      .set("Retry-After", "10")
      .json({
        error: "ml-service is starting up (this can take up to a couple of minutes on a cold instance) — please retry shortly",
        code: "ml_starting",
        retryable: true,
      });
  }
  return res.status(502).json({ error: fallbackMessage });
}

module.exports = { ML_SERVICE_URL, withRetry, isRetryable, isColdStartFailure, sendMlError, attachLang };
