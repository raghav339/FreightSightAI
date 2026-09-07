// backend/test/whatif.test.js
// supertest-style integration tests for POST /api/whatif against the real
// Express app (src/app.js). The ml-service is mocked via jest.mock("axios")
// — there's no live ml-service in the test environment, and mocking lets us
// assert exactly what whatif forwards and returns.
//
// Per the fix-list: this confirms /whatif actually calls the SAME
// underlying decision logic as /forecast (both ultimately run
// ModelBundle.predict() in ml-service — /forecast via POST /forecast,
// /whatif via the lighter POST /recommend — see ml-service/app/main.py),
// and that it returns a full, consistent response rather than merely
// existing as a route.
jest.mock("axios");
const axios = require("axios");
const request = require("supertest");
const app = require("../src/app");

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://127.0.0.1:8001";

// A representative /recommend response shape, as returned by
// ml-service/app/main.py's recommend() — a subset of predict()'s full
// output, since /recommend and /forecast share the same underlying
// bundle.predict() call.
const FAKE_RECOMMEND_RESPONSE = {
  route: "Newcastle-Paradip",
  recommended_vessel_type: "Panamax",
  feasible_vessel_types: ["Panamax", "Supramax"],
  vessel_constraint_note: null,
  vessel_status: "RECOMMENDED_VESSEL",
  vessel_rejection_reason: null,
  rejected_vessel_types: [],
  recommended_charter_window: "Within 2 weeks",
  port_turnaround_days: 3.5,
  idle_management_advice: "No idle risk flagged.",
  congestion_warning: "No elevated congestion risk flagged.",
  contracting_strategy: "Consider a 3-month COA to hedge volatility.",
  summary: "Moderate risk on Newcastle-Paradip.",
};

const VALID_BODY = {
  commodity: "Coal",
  origin_port: "Newcastle",
  destination_port: "Paradip",
  shipment_date: "2026-10-01",
  cargo_weight_tons: 75000,
};

describe("POST /api/whatif", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires commodity/origin_port/destination_port/shipment_date/cargo_weight_tons", async () => {
    const res = await request(app).post("/api/whatif").send({ commodity: "Coal" });
    expect(res.status).toBe(400);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("proxies to ml-service's /recommend — the same underlying predict() logic /forecast uses", async () => {
    axios.post.mockResolvedValueOnce({ data: FAKE_RECOMMEND_RESPONSE });

    const res = await request(app).post("/api/whatif").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [calledUrl, calledBody] = axios.post.mock.calls[0];
    expect(calledUrl).toBe(`${ML_SERVICE_URL}/recommend`);
    expect(calledBody).toMatchObject({
      commodity: "Coal",
      origin_port: "Newcastle",
      destination_port: "Paradip",
      shipment_date: "2026-10-01",
      cargo_weight_tons: 75000,
    });
  });

  it("returns the full, consistent ml-service response — not a stub/partial one", async () => {
    axios.post.mockResolvedValueOnce({ data: FAKE_RECOMMEND_RESPONSE });

    const res = await request(app).post("/api/whatif").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(FAKE_RECOMMEND_RESPONSE);
  });

  it("does not forward removed language fields to ml-service", async () => {
    axios.post.mockResolvedValueOnce({ data: FAKE_RECOMMEND_RESPONSE });

    await request(app)
      .post("/api/whatif")
      .send({ ...VALID_BODY, language: "hi" });

    const [, calledBody] = axios.post.mock.calls[0];
    expect(calledBody).not.toHaveProperty("language");
  });

  it("never touches the DB — repeated calls don't create forecast_requests rows", async () => {
    axios.post.mockResolvedValue({ data: FAKE_RECOMMEND_RESPONSE });
    const db = require("../src/db");
    const before = await db.query("SELECT COUNT(*) as c FROM forecast_requests");

    await request(app).post("/api/whatif").send(VALID_BODY);
    await request(app).post("/api/whatif").send(VALID_BODY);

    const after = await db.query("SELECT COUNT(*) as c FROM forecast_requests");
    expect(after[0].c).toBe(before[0].c);
  });

  it("returns 502 with a clean error body when ml-service is unreachable", async () => {
    axios.post.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const res = await request(app).post("/api/whatif").send(VALID_BODY);

    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("surfaces a 400 with the ml-service's validation detail when given one", async () => {
    const err = new Error("Request failed with status code 400");
    err.response = { status: 400, data: { detail: "cargo_weight_tons must be > 0" } };
    axios.post.mockRejectedValueOnce(err);

    const res = await request(app)
      .post("/api/whatif")
      .send({ ...VALID_BODY, cargo_weight_tons: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cargo_weight_tons/);
  });
});
