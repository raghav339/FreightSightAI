// backend/test/disruptionBriefRoute.test.js
// supertest-style integration tests for POST /api/disruption/decision-brief
// against the real Express app. The ml-service is mocked via
// jest.mock("axios").
jest.mock("axios");
const axios = require("axios");
const request = require("supertest");
const app = require("../src/app");
const { DIVERT_RESULT, WAIT_RESULT, ORIGIN_RESULT, LIVE_RESULT } = require("./fixtures/disruptionBriefFixtures");

function bufferBinaryResponse(res, cb) {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

function mockMl(result = DIVERT_RESULT) {
  axios.post.mockImplementation(async (url) => {
    if (url.endsWith("/disruption/simulate") || url.endsWith("/disruption/live")) {
      if (result instanceof Error) throw result;
      return { data: result };
    }
    throw new Error(`unexpected POST ${url}`);
  });
}
const mlError = (status, detail) => Object.assign(new Error(detail), { response: { status, data: { detail } } });

describe("POST /api/disruption/decision-brief", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMl();
  });

  const post = (body) =>
    request(app)
      .post("/api/disruption/decision-brief")
      .send(body)
      .buffer(true)
      .parse(bufferBinaryResponse);

  const SIMULATE_BODY = { mode: "simulate", event_type: "cyclone", port: "Paradip", severity: 85 };

  it("returns a PDF attachment for a Simulate-mode scenario", async () => {
    const res = await post(SIMULATE_BODY);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="freightsight-disruption-brief-paradip-cyclone\.pdf"/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("calls ml-service /disruption/simulate with the scenario, always asking for alternatives", async () => {
    await post(SIMULATE_BODY);
    expect(axios.post.mock.calls).toHaveLength(1);
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toMatch(/\/disruption\/simulate$/);
    expect(body).toMatchObject({ event_type: "cyclone", port: "Paradip", severity: 85, include_alternatives: true });
  });

  it("calls ml-service /disruption/live in Live mode, without requiring event_type or severity", async () => {
    mockMl(LIVE_RESULT);
    const res = await post({ mode: "live", port: "Paradip" });
    expect(res.status).toBe(200);
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toMatch(/\/disruption\/live$/);
    expect(body).not.toHaveProperty("event_type");
    expect(body).not.toHaveProperty("severity");
    expect(body.include_alternatives).toBe(true);
  });

  it("passes through the lane and cargo fields untouched", async () => {
    await post({ ...SIMULATE_BODY, origin_port: "Newcastle", destination_port: "Paradip", commodity: "Coal", cargo_weight_tons: "50000", stockpile_buffer_days: "5" });
    const [, body] = axios.post.mock.calls[0];
    expect(body).toMatchObject({
      origin_port: "Newcastle", destination_port: "Paradip", commodity: "Coal",
      cargo_weight_tons: 50000, stockpile_buffer_days: 5,
    });
  });

  it("produces a divert brief and a wait brief from their respective fixtures", async () => {
    mockMl(WAIT_RESULT);
    const res = await post(SIMULATE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  it("renders cleanly for a loading-port (origin) scenario with no wait-vs-divert call", async () => {
    mockMl(ORIGIN_RESULT);
    const res = await post({ mode: "simulate", event_type: "port_closure", port: "Newcastle", severity: 70 });
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  it.each([
    [{ mode: "simulate", event_type: "cyclone", severity: 85 }, /port is required/],
    [{ mode: "simulate", port: "Paradip", severity: 85 }, /event_type is required/],
    [{ mode: "simulate", event_type: "cyclone", port: "Paradip" }, /severity is required/],
    [{ mode: "simulate", event_type: "cyclone", port: "Paradip", severity: 150 }, /severity must be a number between 0 and 100/],
    [{ mode: "live" }, /port is required/],
  ])("rejects an invalid request %j with 400 before calling the ml-service", async (body, msg) => {
    const res = await request(app).post("/api/disruption/decision-brief").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(msg);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("passes an ml-service input problem through as 400", async () => {
    mockMl(mlError(400, "Unknown port 'Atlantis'"));
    const res = await request(app).post("/api/disruption/decision-brief").send({ ...SIMULATE_BODY, port: "Atlantis" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown port/);
  });

  it("returns 502 (not a broken PDF) when the ml-service call fails for another reason", async () => {
    mockMl(mlError(404, "route not found"));
    const res = await request(app).post("/api/disruption/decision-brief").send(SIMULATE_BODY);
    expect(res.status).toBe(502);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});
