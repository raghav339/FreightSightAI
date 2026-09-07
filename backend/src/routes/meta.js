// backend/src/routes/meta.js
// NEW — completes "Serve route/vessel master data" from the project plan.
// GET /api/routes and GET /api/vessels populate the frontend's dropdowns.
const express = require("express");
const axios = require("axios");
const db = require("../db");
const { ML_SERVICE_URL, withRetry, sendMlError } = require("../utils/mlClient");

const router = express.Router();

// GET /api/routes — origins/destinations/routes/modes, sourced from the
// trained model's metadata.json so the frontend never hardcodes them.
router.get("/routes", async (req, res) => {
  try {
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/meta`, { timeout }),
      { initialTimeout: 8000 }
    );
    res.json({
      commodities: data.commodities || ["Coal", "Iron Ore", "Bulk Minerals & Ores"],
      origins: data.origins,
      destinations: data.destinations,
      routes: data.routes,
      shipment_modes: data.shipment_modes,
    });
  } catch (err) {
    console.error("Failed to fetch route metadata from ML service:", err.message);
    sendMlError(res, err, "Could not load route metadata. Is the ML service running?");
  }
});

// GET /api/vessels — vessel master data from the DB, merged with the vessel
// types the trained model actually knows about.
router.get("/vessels", async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM vessel_master ORDER BY min_capacity_tons ASC");
    let modelVesselTypes = [];
    try {
      const { data } = await axios.get(`${ML_SERVICE_URL}/meta`, { timeout: 60000 });
      modelVesselTypes = data.vessel_types || [];
    } catch (_) {
      // ML service is optional here — fall back to DB-only list
    }
    res.json({
      vessels: rows,
      vessel_types: modelVesselTypes.length ? modelVesselTypes : rows.map((v) => v.vessel_type),
    });
  } catch (err) {
    console.error("vessels query failed:", err.message);
    res.status(500).json({ error: "Could not fetch vessel master data" });
  }
});

router.get("/ports", async (req, res) => {
  try {
    const { data } = await withRetry(
      (timeout) => axios.get(`${ML_SERVICE_URL}/ports`, { timeout }),
      { initialTimeout: 15000 }
    );

    const destinations = Object.entries(data)
      .filter(([, info]) => info?.country === "India")
      .map(([name, info]) => ({
        port_name: name,
        cargo_depth: info.cargo_depth_m ?? null,
        channel_depth: info.channel_depth_m ?? null,
        is_east_coast_india: true,
      }));

    res.json(destinations);
  } catch (err) {
    console.error("ports query failed:", err.message);
    sendMlError(res, err, "Could not load port master data");
  }
});

module.exports = router;