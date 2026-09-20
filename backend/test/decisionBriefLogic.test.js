// backend/test/decisionBriefLogic.test.js
// Unit tests for the Decision Brief's recommendation logic. Pure functions on
// plain objects: no Express, no ml-service, no PDF. Inputs are real
// ml-service output (test/fixtures/decisionBriefFixtures.js): Iron Ore,
// Newcastle -> Visakhapatnam, 60,000 t lifts, 240,000 t program, 6 months.
const { buildDecisionBrief, isBothPortFeasible, normCommodity } = require("../src/utils/decisionBrief");
const { normalizeForecastRow } = require("../src/utils/forecastLookup");
const { FORECAST_ROW, COMPARE, COA, WHATIF, RADAR } = require("./fixtures/decisionBriefFixtures");

const clone = (o) => JSON.parse(JSON.stringify(o));
const BASE_SCENARIO = { base_cargo_tons: 60000, base_duration_months: 6, cargo_tons: 60000, duration_months: 6, changed: false };

function brief(over = {}) {
  return buildDecisionBrief({
    forecast: normalizeForecastRow(over.row || FORECAST_ROW),
    scenario: over.scenario || BASE_SCENARIO,
    whatif: over.whatif ?? null,
    coa: over.coa || { status: "ok", data: COA },
    compare: over.compare || { status: "ok", data: COMPARE },
    radar: over.radar,
    generatedAt: new Date("2026-09-20T05:00:00Z"),
  });
}
const option = (b, key) => b.options.find((o) => o.key === key);
const withRow = (compare, origin, patch) => {
  const c = clone(compare);
  Object.assign(c.results.find((r) => r.origin_port === origin), patch);
  return c;
};

describe("buildDecisionBrief", () => {
  it("recommends the cheapest vessel-feasible origin and computes the saving against the current lane", () => {
    const b = brief();
    expect(b.recommendation.kind).toBe("switch_origin");
    expect(b.recommendation.headline).toBe("Switch loading port to Hay Point");
    // $10.32/t at Newcastle vs $6.00/t at Hay Point, on the 240,000 t program
    expect(option(b, "stay").cost_usd).toBeCloseTo(2476800, 0);
    expect(option(b, "switch").cost_usd).toBeCloseTo(1440000, 0);
    expect(b.recommendation.savings_usd).toBeCloseTo(1036800, 0);
    expect(b.recommendation.savings_pct).toBeCloseTo(41.86, 1);
    expect(option(b, "switch").recommended).toBe(true);
    expect(b.options.filter((o) => o.recommended)).toHaveLength(1);
  });

  it("prices every option on the same tonnage: the program when one is set, the cargo otherwise", () => {
    expect(brief().basis).toMatchObject({ tons: 240000, is_program: true });
    const noProgram = { ...FORECAST_ROW, total_program_tons: null };
    const coa = clone(COA);
    coa.total_program_tons = 60000;
    const b = brief({ row: noProgram, coa: { status: "ok", data: coa } });
    expect(b.basis).toMatchObject({ tons: 60000, is_program: false });
    expect(option(b, "stay").cost_usd).toBeCloseTo(10.32 * 60000, 0);
  });

  it("never recommends an origin the destination cannot serve, even if its own `feasible` flag is true", () => {
    // Real behaviour found on Chennai: origin-only `feasible` is true while
    // the both-port check says NO_FEASIBLE_VESSEL.
    const compare = withRow(COMPARE, "Hay Point", { feasible: true, vessel_status: "NO_FEASIBLE_VESSEL" });
    const b = brief({ compare: { status: "ok", data: compare } });
    expect(b.recommendation.headline).toBe("Switch loading port to Norfolk");
    expect(b.recommendation.headline).not.toMatch(/Hay Point/);
  });

  it("does not treat a row with no vessel_status (older ml-service) as confirmed", () => {
    expect(isBothPortFeasible({ feasible: true })).toBe(false);
    expect(isBothPortFeasible({ feasible: true, vessel_status: "RECOMMENDED_VESSEL" })).toBe(true);
    expect(isBothPortFeasible({ feasible: false, vessel_status: "RECOMMENDED_VESSEL" })).toBe(false);
  });

  it("keeps the current lane when the best alternative saves less than the materiality margin", () => {
    // Every alternative within ~1% of Newcastle's $10.32/t.
    const compare = clone(COMPARE);
    compare.results.forEach((r) => {
      if (r.origin_port !== "Newcastle") r.predicted_freight_rate_usd_per_ton = 10.25;
    });
    const coa = clone(COA);
    coa.best_strategy.expected_freight_cost_usd = 2470000;
    const b = brief({ compare: { status: "ok", data: compare }, coa: { status: "ok", data: coa } });
    expect(b.recommendation.kind).toBe("stay");
    expect(b.recommendation.savings_usd).toBeNull();
    expect(b.recommendation.subline).toMatch(/less than 2%/);
  });

  it("excludes a COA that was priced for a different commodity", () => {
    const coa = clone(COA);
    coa.market_forecast.commodity = "Coal";
    const b = brief({ coa: { status: "ok", data: coa } });
    const opt = option(b, "coa");
    expect(opt.eligible).toBe(false);
    expect(opt.reason).toMatch(/priced Coal rates, not Iron Ore/);
    expect(b.warnings.join(" ")).toMatch(/weighs only the options shown/);
  });

  it("accepts the same commodity spelled two ways (Bulk Minerals & Ores / And Ores)", () => {
    expect(normCommodity("Bulk Minerals & Ores")).toBe(normCommodity("Bulk Minerals And Ores"));
  });

  it("does not compute deltas against a current lane that cannot be chartered", () => {
    const row = { ...FORECAST_ROW, vessel_status: "NO_FEASIBLE_VESSEL", vessel_rejection_reason: "Draft limit." };
    const b = brief({ row });
    expect(option(b, "stay").eligible).toBe(false);
    expect(b.recommendation.savings_usd).toBeNull();
    for (const o of b.options) expect(o.delta_usd).toBeNull();
    expect(b.recommendation.kind).toBe("switch_origin");
    expect(b.recommendation.subline).toMatch(/cannot be chartered/);
  });

  it("says nothing is executable when no option fits", () => {
    const row = { ...FORECAST_ROW, vessel_status: "NO_FEASIBLE_VESSEL" };
    const compare = clone(COMPARE);
    compare.results.forEach((r) => (r.vessel_status = "NO_FEASIBLE_VESSEL"));
    const coa = clone(COA);
    coa.status = "no_schedule_feasible";
    coa.best_strategy.schedule_note = "Window too short.";
    const b = brief({ row, compare: { status: "ok", data: compare }, coa: { status: "ok", data: coa } });
    expect(b.recommendation.kind).toBe("none");
    expect(b.options.some((o) => o.recommended)).toBe(false);
    expect(b.recommendation.headline).toMatch(/No option is executable/);
  });

  it("still produces a brief when the origin comparison fails, and says the comparison was partial", () => {
    const b = brief({ compare: { status: "unavailable", reason: "Origin comparison unavailable: timeout" } });
    expect(b.recommendation.kind).toBe("coa");
    expect(b.warnings.join(" ")).toMatch(/Origin comparison unavailable/);
    expect(b.warnings.join(" ")).toMatch(/only the options shown/);
  });

  it("uses the what-if result for the current lane's vessel fit when the scenario changed", () => {
    const whatif = { ...clone(WHATIF), vessel_status: "NO_FEASIBLE_VESSEL", vessel_rejection_reason: "Too big." };
    const b = brief({
      scenario: { ...BASE_SCENARIO, cargo_tons: 75000, duration_months: 12, changed: true },
      whatif,
    });
    expect(option(b, "stay").eligible).toBe(false);
    expect(b.scenario.changed).toBe(true);
    expect(b.scenario.whatif.vessel_status).toBe("NO_FEASIBLE_VESSEL");
  });

  it("warns that unusually large savings need broker confirmation", () => {
    expect(brief().warnings.join(" ")).toMatch(/unusually large/);
  });

  it("carries the synthetic-data disclaimer for synthetic route forecasts", () => {
    expect(brief().disclaimer).toMatch(/synthetic/i);
    expect(brief({ row: { ...FORECAST_ROW, forecast_type: "route_specific" } }).disclaimer).toBeNull();
  });

  it("is deterministic for the same inputs", () => {
    expect(brief()).toEqual(brief());
  });
});

describe("port conditions (live AIS radar) in the brief", () => {
  const radarWith = (port, patch) => {
    const r = clone(RADAR);
    Object.assign(r.ports.find((p) => p.port === port), patch);
    return { status: "ok", data: r };
  };

  it("warns on page 1 when the discharge port is congested, without changing the cost ranking", () => {
    const b = brief({ radar: { status: "ok", data: RADAR } });
    expect(b.warnings.join(" ")).toMatch(/Visakhapatnam \(discharge port\) shows CRITICAL/);
    expect(b.warnings.join(" ")).toMatch(/costs above exclude port delays/);
    expect(b.warnings.join(" ")).toMatch(/not measured/);
    expect(b.recommendation.headline).toBe("Switch loading port to Hay Point"); // same as without radar
  });

  it("lists current loading port, recommended loading port and discharge port with their status", () => {
    const rows = brief({ radar: { status: "ok", data: RADAR } }).port_conditions.rows;
    expect(rows.map((r) => [r.role, r.port, r.status])).toEqual([
      ["Current loading port", "Newcastle", "NORMAL"],
      ["Recommended loading port", "Hay Point", "NORMAL"],
      ["Discharge port", "Visakhapatnam", "CRITICAL"],
    ]);
  });

  it("warns when the RECOMMENDED loading port is the congested one", () => {
    const b = brief({ radar: radarWith("Hay Point", { status: "ELEVATED" }) });
    expect(b.warnings.join(" ")).toMatch(/Hay Point \(recommended loading port\) shows ELEVATED/);
  });

  it("does not warn about the port we are leaving, or about a port that is only WATCH", () => {
    const leaving = brief({ radar: radarWith("Newcastle", { status: "CRITICAL" }) });
    expect(leaving.warnings.join(" ")).not.toMatch(/Newcastle \(current loading port\)/);
    const watch = brief({ radar: radarWith("Visakhapatnam", { status: "WATCH" }) });
    expect(watch.warnings.join(" ")).not.toMatch(/congestion on live AIS/);
  });

  it("still builds when the radar is unavailable, and says it is unavailable", () => {
    const b = brief({ radar: { status: "unavailable", reason: "timeout" } });
    expect(b.port_conditions).toEqual({ available: false, rows: [] });
    expect(b.recommendation.kind).toBe("switch_origin");
  });

  it("reports INSUFFICIENT_DATA ports honestly instead of dropping them", () => {
    const b = brief({ radar: radarWith("Visakhapatnam", { status: "INSUFFICIENT_DATA", insufficient_reason: "Too few vessels." }) });
    const row = b.port_conditions.rows.find((r) => r.port === "Visakhapatnam");
    expect(row.status).toBe("INSUFFICIENT_DATA");
    expect(row.reason).toBe("Too few vessels.");
  });
});
