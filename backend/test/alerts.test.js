// backend/test/alerts.test.js
// supertest-style integration tests for GET /api/alerts against the real
// Express app (src/app.js) and the isolated freightsight.test.sqlite DB.
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const {
  insertAlert,
  deleteAlert,
  createTestUser,
  issueTestToken,
  deleteUser,
  TEST_TAG,
} = require("./helpers");

describe("GET /api/alerts", () => {
  let owner;
  let otherUser;
  let ownerToken;
  let otherToken;
  let alertFixture;
  let otherAlertFixture;

  beforeAll(async () => {
    owner = await createTestUser();
    otherUser = await createTestUser();
    ownerToken = issueTestToken(owner);
    otherToken = issueTestToken(otherUser);

    alertFixture = await insertAlert({
      route: "Newcastle-Paradip",
      alert_type: "high_risk",
      message: `${TEST_TAG} high-risk alert`,
      userId: owner.id,
    });
    otherAlertFixture = await insertAlert({
      route: "Santos-Qingdao",
      alert_type: "volatility",
      message: `${TEST_TAG} other user's alert`,
      userId: otherUser.id,
    });
  });

  afterAll(async () => {
    await deleteAlert(alertFixture.id);
    await deleteAlert(otherAlertFixture.id);
    await deleteUser(owner.id);
    await deleteUser(otherUser.id);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/alerts");
    expect(res.status).toBe(401);
  });

  it("returns only the authenticated user's alerts, most recent first", async () => {
    const res = await request(app)
      .get("/api/alerts")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const messages = res.body.map((a) => a.message);
    expect(messages).toContain(`${TEST_TAG} high-risk alert`);
    expect(messages).not.toContain(`${TEST_TAG} other user's alert`);
    expect(res.body.every((a) => a.user_id === owner.id)).toBe(true);

    // most-recent-first: our fixture (inserted last, in beforeAll) should
    // not be sorted behind any alert with an earlier created_at.
    const createdAts = res.body.map((a) => a.created_at);
    const sorted = [...createdAts].sort().reverse();
    expect(createdAts).toEqual(sorted);
  });

  it("does not leak another user's alerts", async () => {
    const res = await request(app)
      .get("/api/alerts")
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(200);
    const messages = res.body.map((a) => a.message);
    expect(messages).toContain(`${TEST_TAG} other user's alert`);
    expect(messages).not.toContain(`${TEST_TAG} high-risk alert`);
  });

  it("caps results at 50 rows", async () => {
    const res = await request(app)
      .get("/api/alerts")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(50);
  });

  it("returns a 500 with a clean error body if the query fails", async () => {
    const originalQuery = db.query;
    db.query = jest.fn().mockRejectedValueOnce(new Error("simulated DB failure"));
    try {
      const res = await request(app)
        .get("/api/alerts")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    } finally {
      db.query = originalQuery;
    }
  });
});