// backend/src/app.js
// Builds and exports the Express app WITHOUT calling app.listen(). Split out
// of server.js so route tests (backend/test/) can require this directly with
// supertest instead of binding a real port per test run.
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const forecastRouter = require("./routes/forecast");
const historyRouter = require("./routes/history");
const metaRouter = require("./routes/meta");
const authRouter = require("./routes/auth");
const analysisRouter = require("./routes/analysis");
const pdfRouter = require("./routes/pdf");
const decisionBriefRouter = require("./routes/decisionBrief");
const aisRouter = require("./routes/ais");

const app = express();

// (Phase 14H) Security headers — hand-rolled rather than pulling in a new
// dependency (helmet etc.) per the "no unnecessary dependencies" rule;
// this is a small, fixed set of standard response headers, not something
// that benefits from a library's configurability.
//   - X-Content-Type-Options: stop browsers guessing/re-interpreting a
//     JSON response as something executable (MIME-sniffing XSS vector).
//   - X-Frame-Options: this is a JSON API, never meant to be framed;
//     blocks clickjacking-style embedding attempts.
//   - Referrer-Policy: don't leak full request URLs (which can contain
//     tokens/query params) to third-party Referer headers.
//   - Content-Security-Policy: default-src 'none' — this origin serves
//     only JSON API responses, never HTML/JS meant to run in a browser
//     context, so there is nothing legitimate for a CSP to allow.
//   - Strict-Transport-Security: only meaningful once served over HTTPS
//     (a reverse proxy/load balancer in production); harmless as a no-op
//     over plain HTTP in local dev.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  next();
});

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

app.get(["/health", "/api/health"], (req, res) => {
  res.json({ status: "ok", service: "freightsight-backend" });
});

app.use("/api", authRouter);
app.use("/api", forecastRouter);
app.use("/api", historyRouter);
app.use("/api", metaRouter);
app.use("/api", analysisRouter);
app.use("/api", pdfRouter);
app.use("/api", decisionBriefRouter);
app.use("/api", aisRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
