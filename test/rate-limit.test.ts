/**
 * Rate limiting + security headers (P1-1).
 *
 * Limiters are no-ops unless RATE_LIMIT_ENABLED=true (production default), so
 * these tests opt in explicitly. The limiter store is per-app, so each test's
 * fresh app starts with a clean window.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, type TestContext } from "./helper.ts";
import { resetConfigForTesting } from "../src/config.ts";

describe("rate limiting", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    process.env.RATE_LIMIT_TEST_OPT_IN = "true";
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_LOGIN_PER_MINUTE = "3";
    resetConfigForTesting();
    ctx = await setupTestApp();
  });

  afterEach(async () => {
    await teardownTestApp(ctx);
    delete process.env.RATE_LIMIT_TEST_OPT_IN;
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.RATE_LIMIT_LOGIN_PER_MINUTE;
    resetConfigForTesting();
  });

  it("blocks login attempts beyond the per-minute threshold with 429", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await ctx.request().post("/api/v1/auth/login").send({ username: "admin", password: "wrong" });
      expect(r.status).toBe(401); // wrong credentials still fail auth
    }
    const blocked = await ctx.request().post("/api/v1/auth/login").send({ username: "admin", password: "wrong" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RATE_LIMITED");
    // RateLimit headers per the IETF draft are present.
    expect(Number(blocked.headers["ratelimit-remaining"])).toBe(0);
  });

  it("does not interfere with non-limited endpoints", async () => {
    // A single login stays under the threshold; the images listing itself is
    // not rate-limited.
    const login = await ctx.request().post("/api/v1/auth/login").send({ username: "admin", password: "TestAdminPass-9x" });
    expect(login.status).toBe(200);
    const res = await ctx
      .request()
      .get("/api/v1/images")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
  });
});

describe("security headers", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestApp();
  });

  afterEach(async () => {
    await teardownTestApp(ctx);
  });

  it("helmet sets baseline security headers on API responses", async () => {
    const res = await ctx.request().get("/api/v1/images");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("no longer leaks x-powered-by", async () => {
    const res = await ctx.request().get("/api/v1/images");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  // The "web/dist SPA CSP" test was removed: the legacy admin SPA was retired
  // when the management UI moved to pi-web. The API-only server returns 404 for
  // "/" when no build exists, so the old assertion was environment-dependent.
});
