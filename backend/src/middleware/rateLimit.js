// backend/src/middleware/rateLimit.js
//
// (Phase 14B) Fixed-window rate limiting, applied to auth and upload
// endpoints. Implemented in-process rather than pulling in a new
// dependency (express-rate-limit etc.) — the algorithm needed here is a
// straightforward fixed window counter, and keeping it in-repo means the
// whole thing is auditable in one file.
//
// SCOPE / KNOWN LIMITATION (documented honestly, not hidden): this store
// is a plain in-memory Map, so it is per-process. Running more than one
// backend instance behind a load balancer means each instance enforces
// its own independent limit — an attacker spread across instances gets a
// higher effective ceiling than the configured one. For a single-process
// deployment (this project's current architecture) that limitation does
// not apply. If/when this backend is horizontally scaled, replace the
// Map below with a shared store (e.g. Redis) keyed the same way.

const buckets = new Map(); // key -> { count, windowStart }

// Periodic sweep so the Map doesn't grow unbounded over a long-running
// process. unref() so this timer never keeps the process (or `node --test`)
// alive by itself.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 60 * 60 * 1000) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === "function") sweepTimer.unref();

/**
 * Build a fixed-window rate limiter middleware.
 *
 * @param {object} opts
 * @param {number} opts.windowMs   window length in ms
 * @param {number} opts.max        max requests allowed per key per window
 * @param {string} opts.name       short label, used in the bucket key and
 *                                 the error message (keeps different
 *                                 limiters on the same route from sharing
 *                                 a counter)
 * @param {(req) => string} [opts.keyFn] how to identify the caller.
 *                                 Defaults to remote IP. Pass a function
 *                                 that reads req.user.id for routes that
 *                                 run after requireAuth, so the limit is
 *                                 per-account rather than per-IP (matters
 *                                 behind shared/proxy IPs).
 * @param {string} [opts.message]  response body message on 429
 */
function rateLimit({ windowMs, max, name, keyFn, message }) {
  if (!windowMs || !max || !name) {
    throw new Error("rateLimit requires windowMs, max, and name");
  }
  return function rateLimitMiddleware(req, res, next) {
    const identity = keyFn ? keyFn(req) : req.ip;
    const key = `${name}:${identity || "unknown"}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(retryAfterSec, 1)));
      return res.status(429).json({
        error: message || "Too many requests. Please slow down and try again shortly.",
      });
    }
    next();
  };
}

// Pre-auth endpoints (register/login): keyed by IP, since there is no
// authenticated user yet to key on.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  name: "auth",
  message: "Too many authentication attempts from this address. Please wait a few minutes and try again.",
});


// Public ML decision endpoints are computationally heavier than simple metadata
// reads. Keep an in-process ceiling here to reduce accidental/automated request
// floods; the limiter remains intentionally modest so normal what-if use is not
// disrupted.
const decisionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  name: "decision",
  message: "Too many decision requests. Please wait a moment and try again.",
});

// The Decision Brief fans out to three ml-service endpoints per request
// (what-if, COA optimizer, and a compare-origins call that itself prices every
// loading port), so it gets a tighter ceiling than the single-call endpoints.
const decisionBriefLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.DECISION_BRIEF_RATE_LIMIT_MAX) || 10, // env override lets the test suite exercise the route freely
  name: "decision-brief",
  message: "Too many decision brief requests. Please wait a moment and try again.",
});

module.exports = { rateLimit, authLimiter, decisionLimiter, decisionBriefLimiter };