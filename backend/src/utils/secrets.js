// backend/src/utils/secrets.js
// Shared resolver for required runtime secrets (JWT_SECRET and anything else
// added later). Centralized so there is exactly one policy
// for "what happens when a required secret is missing" instead of copies
// drifting apart.
//
// Policy:
// - production (NODE_ENV=production): missing secret => throw and fail
//   startup. Never fall back to a fixed, publicly-known default in
//   production.
// - development/test: missing secret => generate a random value for this
//   process only (crypto.randomBytes, not a hardcoded string) and warn
//   loudly. Keeps `npm run dev` / `npm test` zero-setup without ever having
//   a real, guessable secret checked into source control.
const crypto = require("crypto");

function resolveSecret(envVar, label) {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.trim().length > 0) {
    if (fromEnv.trim().length < 16) {
      console.warn(`[secrets] WARNING: ${envVar} is set but very short (<16 chars). Use a long random string in production.`);
    }
    return fromEnv;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `[secrets] FATAL: ${envVar} is not set. Refusing to start in production with an insecure default. ` +
      `Set ${envVar} to a long random string (see backend/.env.example).`
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  console.warn(
    `[secrets] WARNING: ${envVar} is not set — generated a random ${label} for this process only. ` +
    `It will not match other processes/restarts. Set ${envVar} in backend/.env for stable dev behavior, ` +
    `and always in production (missing it there fails startup).`
  );
  return generated;
}

module.exports = { resolveSecret };
