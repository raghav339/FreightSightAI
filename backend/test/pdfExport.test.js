// backend/test/pdfExport.test.js
// supertest-style integration tests for GET /api/forecast/:resultId/pdf
// against the real Express app (src/app.js) and the isolated
// freightsight.test.sqlite DB.
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

// PDF is a binary response — buffer the raw bytes ourselves rather than
// relying on superagent's content-type-based auto-parsing, which doesn't
// know about application/pdf by default.
function bufferBinaryResponse(res, cb) {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

describe("GET /api/forecast/:resultId/pdf", () => {
  let owner, ownerToken, other, otherToken;
  let fixture, anonFixture;

  beforeAll(async () => {
    owner = await createTestUser();
    ownerToken = issueTestToken(owner);
    other = await createTestUser();
    otherToken = issueTestToken(other);

    fixture = await insertForecastRequestAndResult({
      userId: owner.id,
      overrides: {
        route: "Newcastle-Paradip",
        forecast_type: "synthetic_route",
        data_confidence: "medium",
      },
    });

    // A forecast made while signed out (user_id NULL) has no owner to
    // restrict to, so it should be downloadable by anyone with the link —
    // signed in or not.
    anonFixture = await insertForecastRequestAndResult({
      userId: null,
      overrides: { route: "Gangavaram-Visakhapatnam" },
    });
  });

  afterAll(async () => {
    await deleteForecast(fixture);
    await deleteForecast(anonFixture);
    await deleteUser(owner.id);
    await deleteUser(other.id);
  });

  it("returns 404 (not 401) for an anonymous request to someone else's forecast", async () => {
    // No Authorization header at all — optionalAuth lets the request
    // through, but the row belongs to `owner`, so it isn't visible.
    const res = await request(app).get(`/api/forecast/${fixture.resultId}/pdf`);
    expect(res.status).toBe(404);
  });

  it("rejects a non-numeric resultId with 400", async () => {
    const res = await request(app)
      .get("/api/forecast/not-a-number/pdf")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a resultId that belongs to a different user", async () => {
    const res = await request(app)
      .get(`/api/forecast/${fixture.resultId}/pdf`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a resultId that doesn't exist at all", async () => {
    const res = await request(app)
      .get("/api/forecast/999999999/pdf")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it("streams a real PDF for the owning user", async () => {
    const res = await request(app)
      .get(`/api/forecast/${fixture.resultId}/pdf`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .buffer(true)
      .parse(bufferBinaryResponse);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(
      new RegExp(`freightsight-forecast-${fixture.resultId}\\.pdf`)
    );

    const body = res.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    // A real PDF stream starts with the %PDF- magic bytes and is
    // non-trivially sized (not an empty/broken stream).
    expect(body.slice(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(500);
  });

  it("lets a signed-out caller download a forecast that was made signed-out", async () => {
    const res = await request(app)
      .get(`/api/forecast/${anonFixture.resultId}/pdf`)
      .buffer(true)
      .parse(bufferBinaryResponse);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("lets a signed-in caller download a forecast that was made signed-out too", async () => {
    const res = await request(app)
      .get(`/api/forecast/${anonFixture.resultId}/pdf`)
      .set("Authorization", `Bearer ${otherToken}`)
      .buffer(true)
      .parse(bufferBinaryResponse);

    expect(res.status).toBe(200);
  });


  it("returns a clean 500 JSON error if the lookup query fails", async () => {
    const originalQuery = db.query;
    db.query = jest.fn().mockRejectedValueOnce(new Error("simulated DB failure"));
    try {
      const res = await request(app)
        .get(`/api/forecast/${fixture.resultId}/pdf`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    } finally {
      db.query = originalQuery;
    }
  });
});
