// Resilience mode — app-shell service worker.
//
// Scope is deliberately narrow: this caches the built static shell (the
// HTML entry point + hashed JS/CSS under /assets/) so the app can still
// load with zero connectivity, not just show a browser error page. It
// never touches /api/* — API data resilience (cached forecasts, cached
// route/vessel lists) is handled in-app by src/lib/forecastCache.js using
// localStorage, since those are POST requests the Cache API can't key on
// naturally and need lane/cargo-aware "closest match" logic the SW has no
// business doing.
//
// Registered only in production builds — see src/main.jsx — so it never
// interferes with the Vite dev server.
const CACHE_NAME = "freightsight-shell-v1";
const APP_SHELL = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept /forecast, /coa-optimize, etc.

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave fonts/tiles/cross-origin alone
  if (url.pathname.startsWith("/api/")) return; // API data caching lives in the app, not the SW

  if (request.mode === "navigate") {
    // Network-first for the page itself so a normal load always gets the
    // latest build; fall back to the cached shell only when the network
    // request fails outright (offline, DNS failure, etc).
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // Vite fingerprints these filenames by content hash, so a cache-first
    // strategy is safe: a given URL's content never changes once built.
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
            return response;
          })
      )
    );
  }
});
