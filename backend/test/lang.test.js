// backend/test/lang.test.js
// The user's language must reach the ML service: header -> middleware -> axios interceptor.
const request = require("supertest");
const { normalizeLang, langMiddleware, currentLang } = require("../src/middleware/lang");
const { attachLang, ML_SERVICE_URL } = require("../src/utils/mlClient");

describe("normalizeLang", () => {
  it("accepts supported languages, region tags and Accept-Language lists", () => {
    expect(normalizeLang("bn")).toBe("bn");
    expect(normalizeLang("te-IN,en;q=0.8")).toBe("te");
    expect(normalizeLang("OD")).toBe("or");
    expect(normalizeLang("ta_IN")).toBe("ta");
  });
  it("falls back to English for unknown or missing values", () => {
    expect(normalizeLang("fr")).toBe("en");
    expect(normalizeLang(undefined)).toBe("en");
    expect(normalizeLang("")).toBe("en");
  });
});

describe("langMiddleware + attachLang", () => {
  const reqWith = (headers) => ({ get: (h) => headers[h.toLowerCase()] });

  it("stores the language for the duration of the request", (done) => {
    const req = reqWith({ "x-lang": "or" });
    langMiddleware(req, {}, () => {
      expect(req.lang).toBe("or");
      expect(currentLang()).toBe("or");
      done();
    });
  });

  it("adds X-Lang to ML-service calls only", (done) => {
    langMiddleware(reqWith({ "x-lang": "bn" }), {}, () => {
      const ml = attachLang({ url: `${ML_SERVICE_URL}/forecast`, headers: {} });
      expect(ml.headers["X-Lang"]).toBe("bn");
      const other = attachLang({ url: "https://example.com/x", headers: {} });
      expect(other.headers["X-Lang"]).toBeUndefined();
      done();
    });
  });

  it("does nothing outside a request", () => {
    const cfg = attachLang({ url: `${ML_SERVICE_URL}/forecast`, headers: {} });
    expect(cfg.headers["X-Lang"]).toBeUndefined();
  });
});

describe("app wiring", () => {
  it("accepts the X-Lang header on the API", async () => {
    const app = require("../src/app");
    const res = await request(app).get("/api/health").set("X-Lang", "ta");
    expect(res.status).toBe(200);
  });
});
