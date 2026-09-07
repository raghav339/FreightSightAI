// backend/test/history.test.js
// supertest-style integration tests for GET /api/history against the real
// Express app (src/app.js) and the isolated freightsight.test.sqlite DB
// (see test/globalSetup.js and test/setupEnv.js).
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const {
  createTestUser,
  issueTestToken,
  insertForecastRequestAndResult,
  deleteUser,
  deleteForecast,
} = require("./helpers");

describe("GET /api/history", () => {
  let userA, tokenA, userB, tokenB;
  let fixtureA, fixtureB;

  beforeAll(async () => {
    userA = await createTestUser();
    tokenA = issueTestToken(userA);
    userB = await createTestUser();
    tokenB = issueTestToken(userB);

    fixtureA = await insertForecastRequestAndResult({
      userId: userA.id,
      overrides: { route: "Newcastle-Paradip", risk_label: "high" },
    });
    fixtureB = await insertForecastRequestAndResult({
      userId: userB.id,
      overrides: { route: "Gladstone-Visakhapatnam", risk_label: "low" },
    });
  });

  afterAll(async () => {
    await deleteForecast(fixtureA);
    await deleteForecast(fixtureB);
    await deleteUser(userA.id);
    await deleteUser(userB.id);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/history");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid/garbage token", async () => {
    const res = await request(app)
      .get("/api/history")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns only the authenticated user's own forecast history", async () => {
    const res = await request(app)
      .get("/api/history")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const routes = res.body.map((r) => r.route);
    expect(routes).toContain("Newcastle-Paradip");
    expect(routes).not.toContain("Gladstone-Visakhapatnam");
  });

  it("parses JSON-encoded columns back into real objects/arrays", async () => {
    const res = await request(app)
      .get("/api/history")
      .set("Authorization", `Bearer ${tokenA}`);

    const row = res.body.find((r) => r.route === "Newcastle-Paradip");
    expect(row).toBeDefined();
    expect(Array.isArray(row.feasible_vessel_types)).toBe(true);
    expect(typeof row.origin_port_info).toBe("object");
  });

  it("honors the ?limit= query param, clamped to [1, 200]", async () => {
    const res = await request(app)
      .get("/api/history?limit=1")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(1);
  });

  it("returns a 500 with a clean error body if the query fails", async () => {
    const originalQuery = db.query;
    db.query = jest.fn().mockRejectedValueOnce(new Error("simulated DB failure"));
    try {
      const res = await request(app)
        .get("/api/history")
        .set("Authorization", `Bearer ${tokenA}`);
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    } finally {
      db.query = originalQuery;
    }
  });
});
