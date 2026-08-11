/**
 * LLM route guards. With LLM_ENABLED=false (the default), every /api/v1/*llm*
 * route must return 503 llm_not_enabled. Auth still applies: a missing token
 * yields 401 before the 503, and a non-admin hitting /admin/llm gets 403.
 *
 * The happy-path service behavior (grant/reveal/revoke with a live LiteLLM) is
 * covered by llm.service.test.ts, which constructs the service directly with a
 * mocked client.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
});

describe("LLM routes (integration disabled by default)", () => {
  it("GET /api/v1/llm/me requires auth (401 before 503)", async () => {
    ctx = await setupTestApp();
    const res = await ctx.request().get("/api/v1/llm/me");
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/llm/me returns 503 llm_not_enabled when authenticated", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "llmuser1");
    const res = await ctx.request().get("/api/v1/llm/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("llm_not_enabled");
  });

  it("GET /api/v1/admin/llm/bindings denies non-admin (403)", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "llmuser2");
    const res = await ctx.request().get("/api/v1/admin/llm/bindings").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("GET /api/v1/admin/llm/bindings returns 503 for admin when disabled", async () => {
    ctx = await setupTestApp();
    const token = await adminToken(ctx);
    const res = await ctx.request().get("/api/v1/admin/llm/bindings").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("llm_not_enabled");
  });

  it("POST /api/v1/llm/me/keys/:id/reveal is 503 when disabled", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "llmuser3");
    const res = await ctx
      .request()
      .post("/api/v1/llm/me/keys/1/reveal")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
  });

  it("GET /api/v1/llm/models is 503 when disabled", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "llmuser4");
    const res = await ctx.request().get("/api/v1/llm/models").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
  });

  it("/ready reports litellm=disabled when LLM is off", async () => {
    ctx = await setupTestApp();
    const res = await ctx.request().get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.litellm).toBe("disabled");
  });
});
