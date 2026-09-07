// backend/test/setupEnv.js
// Jest `setupFiles` entry — runs inside each test file's own environment,
// before that file requires any app code, so these env vars are in place
// before src/db, src/middleware/auth, etc. read process.env at require time.
process.env.NODE_ENV = "test";
process.env.DB_CLIENT = "sqlite";
// Fixed (not randomly generated) so every test file's independently-
// required copy of middleware/auth agrees on the same signing secret, and
// so tests can sign their own tokens directly when that's simpler than
// going through /api/auth/login.
process.env.JWT_SECRET = "test-only-secret-do-not-use-in-production-0123456789";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
// No live ml-service in tests: routes that call it are exercised either
// via jest.mock("axios") (whatif) or are simply not the routes under test
// (history/alerts/pdf never call it).
process.env.ML_SERVICE_URL = "http://127.0.0.1:8001";
