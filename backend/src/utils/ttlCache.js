// backend/src/utils/ttlCache.js
//
// Tiny in-memory TTL cache with in-flight de-duplication, used by the
// decision endpoints (/compare-origins, /idle-alternatives).
//
// Why: those endpoints are pure functions of their request body plus slowly
// changing model output, yet the UI (Decision Simulator, "Recompute", page
// revisits, two tabs) re-asks the same question repeatedly, and each ask fans
// out across every loading port inside ml-service. Serving an identical
// request from memory for a couple of minutes makes the repeat instant and
// keeps it off the shared 30-req/min decision rate budget's hot path.
// Concurrent identical requests share ONE upstream call instead of stacking.
//
// Only successful results are cached; errors are never stored, so a cold-start
// failure can't get "stuck". Disabled under NODE_ENV=test so tests that mock
// the ML service stay deterministic.

function createTtlCache({ ttlMs = 120000, maxEntries = 200 } = {}) {
  const store = new Map(); // key -> { at, value }
  const inflight = new Map(); // key -> Promise

  const enabled = () => process.env.NODE_ENV !== "test" && process.env.DISABLE_RESPONSE_CACHE !== "1";

  async function getOrCompute(key, compute) {
    if (!enabled()) return compute();

    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;

    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      try {
        const value = await compute();
        if (store.size >= maxEntries) {
          // Drop the oldest entry (Map preserves insertion order).
          store.delete(store.keys().next().value);
        }
        store.set(key, { at: Date.now(), value });
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  return { getOrCompute, clear: () => store.clear() };
}

module.exports = { createTtlCache };
