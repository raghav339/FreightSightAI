// backend/src/middleware/validateForecast.js
const { getDestinationPorts } = require("../config/destinationPorts");
const COMMODITIES = new Set(["Coal", "Iron Ore", "Bulk Minerals & Ores"]);

function validateForecast(req, res, next) {
  const { commodity, origin_port, destination_port, shipment_date, cargo_weight_tons } = req.body;
  const errors = [];
  const destinationPorts = getDestinationPorts();
  const ORIGIN_PORTS = new Set([
  "Newcastle",
  "Hay Point",
  "Gladstone",
  "Norfolk",
  "Baltimore",
  "Nacala",
  "Beira",
  "Vostochny",
  "Murmansk",
  "Samarinda",
  "Taboneo",
  ]);
  const SHIPMENT_MODES = new Set(["Bulk Carrier", "Charter"]);

  if (!COMMODITIES.has(commodity)) errors.push("commodity must be Coal, Iron Ore, or Bulk Minerals & Ores");
  // Single message for a missing/invalid origin_port, matching the
  // pattern used for destination_port below.
  if (!origin_port || typeof origin_port !== "string" || !origin_port.trim() || !ORIGIN_PORTS.has(origin_port)) {
    errors.push(
      `origin_port must be one of: ${[...ORIGIN_PORTS].join(", ")}`
    );
  }
  if (!destination_port || !destinationPorts.has(destination_port)) {
    errors.push(`destination_port must be one of: ${[...destinationPorts].join(", ")}`);
  }
  if (origin_port && destination_port && origin_port === destination_port) errors.push("origin_port and destination_port must differ");
  if (
  !shipment_date ||
  !/^\d{4}-\d{2}-\d{2}$/.test(shipment_date) ||
  Number.isNaN(Date.parse(`${shipment_date}T00:00:00Z`))
  ) {
    errors.push("shipment_date must be a valid date (YYYY-MM-DD)");
  }
  if (cargo_weight_tons === undefined || cargo_weight_tons === null || isNaN(Number(cargo_weight_tons))) errors.push("cargo_weight_tons must be numeric");
  else if (Number(cargo_weight_tons) <= 0) errors.push("cargo_weight_tons must be greater than 0");

  if (!SHIPMENT_MODES.has(req.body.shipment_mode || "Bulk Carrier")) {
  errors.push("shipment_mode must be Bulk Carrier or Charter");
  }

  if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });

  function optionalNumber(value, field, errors, min = 0) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  const n = Number(value);

  if (!Number.isFinite(n) || n < min) {
    errors.push(`${field} must be a number >= ${min}`);
  }
}

  optionalNumber(
    req.body.cargo_volume_cbm,
    "cargo_volume_cbm",
    errors
  );

  optionalNumber(
    req.body.distance_km,
    "distance_km",
    errors
  );

  optionalNumber(
    req.body.delay_days,
    "delay_days",
    errors
  );

  optionalNumber(
    req.body.contract_duration_months,
    "contract_duration_months",
    errors
  );

  optionalNumber(
    req.body.total_program_tons,
    "total_program_tons",
    errors
  );

  // Cross-field check: total program tonnage (sum across all COA voyages)
  // can never be less than a single shipment's cargo weight.
  if (
    req.body.total_program_tons !== undefined &&
    req.body.total_program_tons !== null &&
    req.body.total_program_tons !== "" &&
    !isNaN(Number(cargo_weight_tons))
  ) {
    const totalProgramTons = Number(req.body.total_program_tons);
    const cargoWeight = Number(cargo_weight_tons);
    if (Number.isFinite(totalProgramTons) && totalProgramTons < cargoWeight) {
      errors.push(
        `total_program_tons (${totalProgramTons}) must be greater than or equal to cargo_weight_tons (${cargoWeight})`
      );
    }
  }

  if (errors.length) {
  return res.status(400).json({
    error: "Validation failed",
    details: errors
  });
}

  req.body.shipment_mode = req.body.shipment_mode || "Bulk Carrier";
  next();
}

module.exports = validateForecast;

