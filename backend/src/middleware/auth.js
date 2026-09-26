// backend/src/middleware/auth.js
// requireAuth: verifies the JWT sent as `Authorization: Bearer <token>` and
// attaches the decoded payload to req.user.
//
// JWT_SECRET is resolved via the shared resolveSecret() policy in
// utils/secrets.js (random dev/test secret with a loud warning; hard
// failure in production if unset — see that file for the full policy).
// Every route file depends on this module (auth.js, forecast.js,
// history.js, pdf.js), so it must always export a working JWT_SECRET.
const jwt = require("jsonwebtoken");
const { resolveSecret } = require("../utils/secrets");

const JWT_SECRET = resolveSecret("JWT_SECRET", "JWT signing secret");

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Bearer" && token) return token;
  return null;
}

// requireAuth: used on routes that only make sense for a signed-in account
// (forecast history, PDF export, /auth/me). Missing/invalid/expired token
// -> 401, request never reaches the route handler.
function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}

// optionalAuth: used on routes usable by both signed-in and anonymous
// callers (/forecast, /route-forecast, /coa-optimize). A present-and-valid
// token attaches req.user; a missing or invalid token is never an error
// here — the request just proceeds as anonymous.
function optionalAuth(req, res, next) {
  const token = getBearerToken(req);
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      // Invalid/expired token on an optional-auth route: proceed as
      // anonymous rather than failing the request.
    }
  }
  return next();
}

module.exports = { requireAuth, optionalAuth, JWT_SECRET };
