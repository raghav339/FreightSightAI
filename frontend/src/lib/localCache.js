// Thin, defensive localStorage wrapper. Private-browsing modes, storage
// quota, and disabled storage can all make localStorage throw — every
// call here is wrapped so a caching failure never breaks the feature it's
// supporting.
export function readJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
