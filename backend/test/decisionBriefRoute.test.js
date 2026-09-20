// backend/test/decisionBriefRoute.test.js
// supertest-style integration tests for GET /api/forecast/:resultId/decision-brief
// against the real Express app and the isolated test SQLite DB. The
// ml-service is mocked via jest.mock("axios") (answers keyed by URL, because
// the route calls the ml-service in parallel).
// Set before the app loads: this file makes more requests per minute than the production ceiling.
process.env.DECISION_BRIEF_RATE_LIMIT_MAX = "1000";
jest.mock("axios");
const axios = require("axios");
const request = require("supertest");
const app = require("../src/app");
const {
  createTestUser,
  issueTestToken,
  insertForecastRequestAndResult,
  deleteUser,
  deleteForecast,
} = require("./helpers");
const { COMPARE, COA, WHATIF, RADAR } = require("./fixtures/decisionBriefFixtures");

function bufferBinaryResponse(res, cb) {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

const callsTo = (suffix) => axios.post.mock.calls.filter(([url]) => url.endsWith(suffix));

// Answers each ml-service endpoint; pass per-endpoint overrides (a value, or an Error to reject with).
function mockMl({ recommend = WHATIF, coa = COA, compare = COMPARE, radar = RADAR } = {}) {
  const answers = { "/recommend": recommend, "/coa-optimize": coa, "/compare-origins": compare };
  axios.post.mockImplementation(async (url) => {
    const key = Object.keys(answers).find((k) => url.endsWith(k));
    const a = answers[key];
    if (a instanceof Error) throw a;
    return { data: a };
  });
  axios.get.mockImplementation(async (url) => {
    if (!url.endsWith("/ais/port-radar")) throw new Error(`unexpected GET ${url}`);
    if (radar instanceof Error) throw radar;
    return { data: radar };
  });
}
const mlError = (status, detail) => Object.assign(new Error(detail), { response: { status, data: { detail } } });

describe("GET /api/forecast/:resultId/decision-brief", () => {
  let owner, ownerToken, other, otherToken, mine, anon;

  beforeAll(async () => {
    owner = await createTestUser();
    ownerToken = issueTestToken(owner);
    other = await createTestUser();
    otherToken = issueTestToken(other);
    mine = await insertForecastRequestAndResult({ userId: owner.id, overrides: { commodity: "Iron Ore", destination_port: "Visakhapatnam" } });
    anon = await insertForecastRequestAndResult({ userId: null, overrides: { commodity: "Iron Ore", destination_port: "Visakhapatnam" } });
  });

  afterAll(async () => {
    await deleteForecast(mine);
    await deleteForecast(anon);
    await deleteUser(owner.id);
    await deleteUser(other.id);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockMl();
  });

  const get = (id, token, query = {}) =>
    request(app)
      .get(`/api/forecast/${id}/decision-brief`)
      .query(query)
      .set(token ? { Authorization: `Bearer ${token}` } : {})
      .buffer(true)
      .parse(bufferBinaryResponse);

  it("returns a PDF attachment for the owner", async () => {
    const res = await get(mine.resultId, ownerToken);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="freightsight-decision-brief-\d+\.pdf"/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("recomputes the comparisons server-side from the saved forecast (nothing is trusted from the client)", async () => {
    await get(mine.resultId, ownerToken);
    const [, compareBody] = callsTo("/compare-origins")[0];
    expect(compareBody).toMatchObject({ commodity: "Iron Ore", destination_port: "Visakhapatnam", cargo_weight_tons: 75000 });
    const [, coaBody] = callsTo("/coa-optimize")[0];
    expect(coaBody).toMatchObject({ commodity: "Iron Ore", origin_port: "Newcastle", cargo_weight_tons: 75000 });
  });

  it("skips the what-if call when the scenario matches the saved forecast, and makes it when it does not", async () => {
    await get(mine.resultId, ownerToken);
    expect(callsTo("/recommend")).toHaveLength(0);

    jest.clearAllMocks();
    mockMl();
    const res = await get(mine.resultId, ownerToken, { cargo_weight_tons: 90000, contract_duration_months: 12 });
    expect(res.status).toBe(200);
    expect(callsTo("/recommend")).toHaveLength(1);
    expect(callsTo("/recommend")[0][1]).toMatchObject({ cargo_weight_tons: 90000, contract_duration_months: 12 });
    expect(callsTo("/compare-origins")[0][1].cargo_weight_tons).toBe(90000);
  });

  it("lets anyone download a brief for an anonymous forecast", async () => {
    const res = await get(anon.resultId, null);
    expect(res.status).toBe(200);
  });

  it("returns 404 and never calls the ml-service for another user's private forecast", async () => {
    const res = await request(app)
      .get(`/api/forecast/${mine.resultId}/decision-brief`)
      .set({ Authorization: `Bearer ${otherToken}` });
    expect(res.status).toBe(404);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown result and 400 for a non-numeric id", async () => {
    expect((await request(app).get("/api/forecast/99999999/decision-brief")).status).toBe(404);
    expect((await request(app).get("/api/forecast/abc/decision-brief")).status).toBe(400);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it.each([
    [{ cargo_weight_tons: "0" }],
    [{ cargo_weight_tons: "-5" }],
    [{ cargo_weight_tons: "abc" }],
    [{ contract_duration_months: "37" }],
    [{ contract_duration_months: "-1" }],
  ])("rejects an invalid scenario %j with 400 before calling the ml-service", async (query) => {
    const res = await request(app).get(`/api/forecast/${mine.resultId}/decision-brief`).query(query).set({ Authorization: `Bearer ${ownerToken}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("asks the ml-service for live port conditions, and a radar failure does not break the brief", async () => {
    await get(mine.resultId, ownerToken);
    expect(axios.get.mock.calls.some(([url]) => url.endsWith("/ais/port-radar"))).toBe(true);

    jest.clearAllMocks();
    mockMl({ radar: mlError(503, "AIS database unavailable") });
    const res = await get(mine.resultId, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("still returns a brief when only one of the two comparisons fails", async () => {
    mockMl({ compare: mlError(422, "boom") });
    const res = await get(mine.resultId, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("passes an input problem through as 400 when neither comparison can run", async () => {
    mockMl({ coa: mlError(400, "No route forecast for lane"), compare: mlError(400, "No route forecast for lane") });
    const res = await request(app).get(`/api/forecast/${mine.resultId}/decision-brief`).set({ Authorization: `Bearer ${ownerToken}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No route forecast/);
  });

  it("fails cleanly (JSON error, not a broken PDF) when the scenario what-if fails", async () => {
    mockMl({ recommend: mlError(400, "cargo too large") });
    const res = await request(app)
      .get(`/api/forecast/${mine.resultId}/decision-brief`)
      .query({ cargo_weight_tons: 90000 })
      .set({ Authorization: `Bearer ${ownerToken}` });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});
