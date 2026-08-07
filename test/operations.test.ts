/**
 * P2 operations/compliance tests: /ready + /metrics probes, session
 * accounting close-out, and error-message redaction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";
import { resetConfigForTesting } from "../src/config.ts";
import { toHttpError } from "../src/utils/errors.ts";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
  delete process.env.NODE_ENV;
  resetConfigForTesting();
});

describe("readiness + metrics (P2-2)", () => {
  it("/ready reports ready when DB + overlay dir are fine", async () => {
    ctx = await setupTestApp();
    const res = await ctx.request().get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("/metrics exposes prometheus text with platform gauges", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const userToken = await createUserAndLogin(ctx, "metrics-user");
    await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId: 1, name: "metrics-box" });
    void admin;

    const res = await ctx.request().get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("sandbox_http_requests_total");
    expect(res.text).toContain('sandbox_containers_running 1');
    expect(res.text).toContain("process_cpu_seconds_total");
  });
});

describe("session accounting close-out (P2-3)", () => {
  it("bash/stream settles its session on completion", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "sess-user");
    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId: 1, name: "sess-box" });
    const cid = create.body.id;

    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash/stream`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "echo accounting" });

    const rows = await ctx.db.all<{ bytes_out: number; ended_at: string | null }>(
      "SELECT bytes_out, ended_at FROM sessions ORDER BY id DESC",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].ended_at).not.toBeNull();
    expect(Number(rows[0].bytes_out)).toBeGreaterThan(0);
  });

  it("/connect settles its session immediately", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "conn-user");
    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId: 1, name: "conn-box" });
    const cid = create.body.id;

    const conn = await ctx.request().get(`/api/v1/containers/${cid}/connect`).set("Authorization", `Bearer ${token}`);
    expect(conn.status).toBe(200);
    expect(conn.body.sessionId).toBeGreaterThan(0);

    const row = await ctx.db.get<{ ended_at: string | null }>(
      "SELECT ended_at FROM sessions WHERE id = ?",
      conn.body.sessionId,
    );
    expect(row!.ended_at).not.toBeNull();
  });
});

describe("error detail redaction (P2-1)", () => {
  it("regular users never see container error_message; admins do", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "redact-user");
    // Force an error state directly (simulates a failed provisioning).
    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId: 1, name: "redact-box" });
    const cid = create.body.id;
    await ctx.db.run(
      "UPDATE containers SET status = 'error', error_message = 'failed: postgres://secret:pass@internal-db:5432' WHERE id = ?",
      cid,
    );

    const userView = await ctx.request().get(`/api/v1/containers/${cid}`).set("Authorization", `Bearer ${token}`);
    expect(userView.status).toBe(200);
    expect(userView.body.error_message).toBeNull();

    const admin = await adminToken(ctx);
    const adminView = await ctx.request().get(`/api/v1/containers/${cid}`).set("Authorization", `Bearer ${admin}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.error_message).toContain("secret");
  });

  it("internal 500s return a generic message in production", async () => {
    process.env.NODE_ENV = "production";
    const err = toHttpError(new Error("connect ECONNREFUSED postgres://user:secret@10.0.0.1:5432/db"));
    expect(err.status).toBe(500);
    expect(err.message).toBe("Internal server error");

    // Development keeps the detail for debugging.
    delete process.env.NODE_ENV;
    const devErr = toHttpError(new Error("connect ECONNREFUSED postgres://user:secret@10.0.0.1:5432/db"));
    expect(devErr.message).toContain("ECONNREFUSED");
  });
});
