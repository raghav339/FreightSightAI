// backend/test/aisPortRadar.test.js
// GET /api/ais/port-radar[/:port]: thin proxy to ml-service. The radar rules
// themselves are tested in ml-service/tests/test_port_radar.py; this checks
// the proxy forwards parameters, encodes port names, and maps errors.
jest.mock("axios");
const axios = require("axios");
const request = require("supertest");
const app = require("../src/app");

const RADAR = {
  port: "Hay Point",
  status: "ELEVATED",
  now: { seen: 22, waiting: 9 },
  baseline: { seen: 13, waiting: 3, windows_used: 7 },
};

describe("GET /api/ais/port-radar", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the all-ports radar and forwards window/baseline params", async () => {
    axios.get.mockResolvedValueOnce({ data: { ports: [RADAR] } });
    const res = await request(app).get("/api/ais/port-radar").query({ window_hours: 3, baseline_days: 5 });
    expect(res.status).toBe(200);
    expect(res.body.ports[0].status).toBe("ELEVATED");
    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toMatch(/\/ais\/port-radar$/);
    expect(opts.params).toEqual({ window_hours: "3", baseline_days: "5" });
    expect(res.headers["cache-control"]).toMatch(/max-age=60/);
  });

  it("URL-encodes port names with spaces for the single-port radar", async () => {
    axios.get.mockResolvedValueOnce({ data: RADAR });
    const res = await request(app).get("/api/ais/port-radar/Hay%20Point");
    expect(res.status).toBe(200);
    expect(axios.get.mock.calls[0][0]).toMatch(/\/ais\/port-radar\/Hay%20Point$/);
  });

  it("passes an unknown-port 400 through with the ml-service message", async () => {
    axios.get.mockRejectedValueOnce(
      Object.assign(new Error("bad"), { response: { status: 400, data: { detail: "Unknown AIS port: Atlantis" } } })
    );
    const res = await request(app).get("/api/ais/port-radar/Atlantis");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown AIS port/);
  });

  it("rejects an absurdly long port name without calling the ml-service", async () => {
    const res = await request(app).get(`/api/ais/port-radar/${"x".repeat(80)}`);
    expect(res.status).toBe(400);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
