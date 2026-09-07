// frontend/src/api/mlWakeup.js
// A tiny pub-sub bus so client.js (which has no JSX) can tell UI
// components when a request looks like it's waiting on ml-service to
// wake up from a Render free-tier cold start. Kept separate from React
// context so it's usable from a plain axios interceptor.

const listeners = new Set();

export function subscribeMlWakeup(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyMlWakeup(state) {
  listeners.forEach((listener) => listener(state));
}
