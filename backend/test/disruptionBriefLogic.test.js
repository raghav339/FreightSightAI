// backend/test/disruptionBriefLogic.test.js
// Unit tests for the Disruption Decision Brief's wait-vs-divert logic. Pure
// functions on plain objects: no Express, no ml-service, no PDF.
const { buildDisruptionBrief, MIN_MATERIAL_DELAY_SAVING_DAYS } = require("../src/utils/disruptionBrief");
const {
  DIVERT_RESULT,
  WAIT_RESULT,
  WAIT_NO_ALTERNATIVE_RESULT,
  ORIGIN_RESULT,
  LIVE_RESULT,
} = require("./fixtures/disruptionBriefFixtures");

const GENERATED_AT = new Date("2026-09-20T05:00:00Z");
const brief = (result) => buildDisruptionBrief({ result, generatedAt: GENERATED_AT });

describe("buildDisruptionBrief", () => {
  it("calls divert when the alternative materially beats waiting it out", () => {
    const b = brief(DIVERT_RESULT);
    expect(b.call.kind).toBe("divert");
    expect(b.call.headline).toBe("Divert to Visakhapatnam");
    expect(b.call.delay_saved_days).toBeCloseTo(10.5, 5);
    expect(b.reasons[0]).toMatch(/Diverting to Visakhapatnam/);
    expect(b.reasons.some((r) => /breach the stockpile buffer/.test(r))).toBe(true);
  });

  it("calls wait when the alternative does not save enough time", () => {
    const b = brief(WAIT_RESULT);
    expect(b.call.kind).toBe("wait");
    expect(b.call.headline).toBe("Wait it out at Paradip");
    // 2.0 - 1.6 = 0.4 days, under MIN_MATERIAL_DELAY_SAVING_DAYS
    expect(b.call.delay_saved_days).toBeCloseTo(0.4, 5);
    expect(b.call.delay_saved_days).toBeLessThan(MIN_MATERIAL_DELAY_SAVING_DAYS);
    expect(b.reasons[0]).toMatch(/only saves/);
  });

  it("calls wait when there is no vessel-feasible alternative at all", () => {
    const b = brief(WAIT_NO_ALTERNATIVE_RESULT);
    expect(b.call.kind).toBe("wait");
    expect(b.call.delay_saved_days).toBeNull();
    expect(b.reasons[0]).toMatch(/No vessel-feasible alternative/);
  });

  it("never makes a wait-vs-divert call for a loading (origin) port", () => {
    const b = brief(ORIGIN_RESULT);
    expect(b.call.kind).toBe("not_applicable");
    expect(b.decision).toBeNull();
    expect(b.reasons.some((r) => /Port Substitution Engine/.test(r))).toBe(true);
  });

  it("carries the propagation chain through unchanged", () => {
    const b = brief(DIVERT_RESULT);
    expect(b.propagation).toEqual(DIVERT_RESULT.disruption.propagation);
    expect(b.propagation.find((s) => s.key === "stockpile").breached).toBe(true);
  });

  it("prices the lane when one is given", () => {
    const b = brief(DIVERT_RESULT);
    expect(b.lane).toMatchObject({ origin_port: "Newcastle", destination_port: "Paradip", commodity: "Coal" });
  });

  it("notes when no lane was given", () => {
    const b = brief(ORIGIN_RESULT);
    expect(b.lane).toBeNull();
    expect(b.reasons.some((r) => /freight-rate impact is not priced/.test(r))).toBe(true);
  });

  it("keeps only the top three feasible alternative options", () => {
    const b = brief(DIVERT_RESULT);
    expect(b.alternatives.options).toHaveLength(2);
    expect(b.alternatives.options.every((o) => o.feasible)).toBe(true);
  });

  it("echoes the source label (simulated vs live) without blurring the two", () => {
    expect(brief(DIVERT_RESULT).source).toBe("simulated");
    expect(brief(LIVE_RESULT).source).toBe("live");
    expect(brief(LIVE_RESULT).live_conditions).not.toBeNull();
  });

  it("reports severity on a 0-100 scale for display", () => {
    expect(brief(DIVERT_RESULT).event.severity_pct).toBe(85);
  });

  it("passes through engine assumptions verbatim", () => {
    const b = brief(DIVERT_RESULT);
    expect(b.assumptions).toEqual(DIVERT_RESULT.disruption.assumptions);
  });
});
