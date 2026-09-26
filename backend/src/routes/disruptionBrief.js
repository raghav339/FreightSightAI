// backend/src/routes/disruptionBrief.js
//
// POST /api/disruption/decision-brief
//
// The "wow" moment wiring: one call — Simulate mode (an event type + port +
// severity, chosen by hand) or Live mode (current marine conditions at a
// port) — becomes a single downloadable PDF with the propagation chain, the
// wait-vs-divert call, and the recommended alternative port, closing the
// loop between the forecast, the Port Substitution Engine and the
// Disruption Engine (see app/utils.py::_build_disruption_response, which
// already wires those three together server-side; this route just asks for
// exactly that response and renders it).
//
// The request body is the same shape POST /api/disruption/simulate and
// POST /api/disruption/live already accept (see routes/analysis.js), plus
// an optional `mode` field selecting which of the two to run. Numbers in
// the PDF are always recomputed here from the ml-service, never trusted
// from the client.
"use strict";

const express = require("express");
const axios = require("axios");
const { decisionLimiter } = require("../middleware/rateLimit");
const { ML_SERVICE_URL, withRetry, sendMlError } = require("../utils/mlClient");
const { buildDisruptionBrief } = require("../utils/disruptionBrief");
const { renderDisruptionBriefPdf } = require("../utils/disruptionBriefPdf");

const router = express.Router();

// Single ml-service call (unlike the fan-out forecast Decision Brief), so
// the same budget as the underlying /disruption/simulate and /disruption/live
// proxy routes is enough.
const CALL_OPTS = { initialTimeout: 20000, retries: 1, coldTimeout: 70000 };

function badRequest(res, err) {
  const detail = err.response?.data?.detail;
  return res.status(400).json({
    error: Array.isArray(detail) ? detail.map((d) => d.msg || JSON.stringify(d)).join(", ") : detail || "Request failed",
  });
}

function slug(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "brief";
}

router.post("/disruption/decision-brief", decisionLimiter, async (req, res) => {
  const {
    mode, event_type, port, severity, duration_days, origin_port, destination_port,
    commodity, shipment_date, cargo_weight_tons, stockpile_buffer_days,
  } = req.body || {};

  const isLive = mode === "live";

  if (!port || String(port).trim().length === 0 || String(port).length > 60) {
    return res.status(400).json({ error: "port is required" });
  }
  if (!isLive) {
    if (!event_type) return res.status(400).json({ error: "event_type is required in Simulate mode" });
    if (severity === undefined || severity === null) {
      return res.status(400).json({ error: "severity is required in Simulate mode" });
    }
    const sev = Number(severity);
    if (!Number.isFinite(sev) || sev < 0 || sev > 100) {
      return res.status(400).json({ error: "severity must be a number between 0 and 100" });
    }
  }

  // Alternatives are the whole point of a wait-vs-divert brief — always
  // asked for, regardless of what the caller sends.
  const payload = {
    port: String(port).trim(),
    duration_days: duration_days ? Number(duration_days) : undefined,
    origin_port: origin_port || undefined,
    destination_port: destination_port || undefined,
    commodity: commodity || undefined,
    shipment_date: shipment_date || undefined,
    cargo_weight_tons: cargo_weight_tons ? Number(cargo_weight_tons) : undefined,
    stockpile_buffer_days: stockpile_buffer_days ? Number(stockpile_buffer_days) : undefined,
    include_alternatives: true,
  };
  if (!isLive) {
    payload.event_type = event_type;
    payload.severity = Number(severity);
  }

  const mlPath = isLive ? "/disruption/live" : "/disruption/simulate";

  let result;
  try {
    const { data } = await withRetry((timeout) => axios.post(`${ML_SERVICE_URL}${mlPath}`, payload, { timeout }), CALL_OPTS);
    result = data;
  } catch (err) {
    console.error("disruption decision brief: ml-service call failed:", err.message);
    if (err.response?.status === 400 || err.response?.status === 422) return badRequest(res, err);
    return sendMlError(res, err, "Could not build the disruption decision brief");
  }

  let pdf;
  try {
    const brief = buildDisruptionBrief({ result });
    pdf = await renderDisruptionBriefPdf(brief);
  } catch (err) {
    console.error("disruption decision brief build/render failed:", err);
    return res.status(500).json({ error: "Could not generate the disruption decision brief" });
  }

  const filename = `freightsight-disruption-brief-${slug(port)}-${slug(event_type || "live")}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdf.length);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.end(pdf);
});

module.exports = router;
