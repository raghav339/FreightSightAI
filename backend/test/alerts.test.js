// backend/test/alerts.test.js
// supertest-style integration tests for GET /api/alerts against the real
// Express app (src/app.js) and the isolated freightsight.test.sqlite DB.
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { insertAlert, deleteAlert, TEST_TAG } = require("./helpers");

describe("GET /api/alerts", () => {
  let alertFixture;

  beforeAll(async () => {
    alertFixture = await insertAlert({
      route: "Newcastle-Paradip",
      alert_type: "high_risk",
      message: `${TEST_TAG} high-risk alert`,
    });
  });

  afterAll(async () => {
    await deleteAlert(alertFixture.id);
  });

  it("does not require authentication", async () => {
    const res = await request(app).get("/api/alerts");
    expect(res.status).toBe(200);
  });

  it("returns an array of alerts including the fixture, most recent first", async () => {
    const res = await request(app).get("/api/alerts");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const messages = res.body.map((a) => a.message);
    expect(messages).toContain(`${TEST_TAG} high-risk alert`);

    // most-recent-first: our fixture (inserted last, in beforeAll) should
    // not be sorted behind any alert with an earlier created_at.
    const createdAts = res.body.map((a) => a.created_at);
    const sorted = [...createdAts].sort().reverse();
    expect(createdAts).toEqual(sorted);
  });

  it("caps results at 50 rows", async () => {
    const res = await request(app).get("/api/alerts");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(50);
  });

  it("returns a 500 with a clean error body if the query fails", async () => {
    const originalQuery = db.query;
    db.query = jest.fn().mockRejectedValueOnce(new Error("simulated DB failure"));
    try {
      const res = await request(app).get("/api/alerts");
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    } finally {
      db.query = originalQuery;
    }
  });
});
