/**
 * Milestone 6: audit logging + admin dashboard/logs endpoints.
 *
 * Verifies the audit middleware records mutating requests and that admins can
 * query the trail and see a dashboard summary.
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

async function newContainer(ctx: TestContext, token: string): Promise<number> {
  const admin = await adminToken(ctx);
  const images = await ctx.request().get("/api/v1/admin/images").set("Authorization", `Bearer ${admin}`);
  const imageId = images.body.images[0].id;
  const res = await ctx
    .request()
    .post("/api/v1/containers")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageId, name: "logged-box" });
  return res.body.id as number;
}

describe("audit logging", () => {
  it("records container create + tool bash in operation_logs", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "audited");
    const cid = await newContainer(ctx, token);

    // Run a tool bash to generate a tool audit entry.
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "echo logged" });

    const admin = await adminToken(ctx);
    const logs = await ctx
      .request()
      .get("/api/v1/admin/logs?resourceType=container")
      .set("Authorization", `Bearer ${admin}`);
    expect(logs.status).toBe(200);
    const actions = logs.body.logs.map((l: { action: string }) => l.action);
    expect(actions).toContain("container.create");
    expect(actions).toContain("container.tool.bash");
  });

  it("records auth login attempts", async () => {
    ctx = await setupTestApp();
    // A successful admin login.
    await ctx.request().post("/api/v1/auth/login").send({ username: "admin", password: "changeme123" });
    // A failed login.
    await ctx.request().post("/api/v1/auth/login").send({ username: "admin", password: "wrong" });

    const admin = await adminToken(ctx);
    const logs = await ctx
      .request()
      .get("/api/v1/admin/logs?resourceType=auth")
      .set("Authorization", `Bearer ${admin}`);
    const authLogs = logs.body.logs;
    const statuses = authLogs.map((l: { status: string }) => l.status);
    expect(statuses).toContain("success");
    expect(statuses).toContain("failure");
  });

  it("records user create/delete by admin", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const create = await ctx
      .request()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({ username: "tempuser", password: "password1" });
    await ctx.request().delete(`/api/v1/admin/users/${create.body.id}`).set("Authorization", `Bearer ${admin}`);

    const logs = await ctx
      .request()
      .get("/api/v1/admin/logs?resourceType=user")
      .set("Authorization", `Bearer ${admin}`);
    const actions = logs.body.logs.map((l: { action: string }) => l.action);
    expect(actions).toContain("user.create");
    expect(actions).toContain("user.delete");
  });

  it("supports filtering logs by status and user", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "filteruser");
    const userId = (
      await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`)
    ).body.user.id;
    await newContainer(ctx, token); // success

    const admin = await adminToken(ctx);
    const successOnly = await ctx
      .request()
      .get(`/api/v1/admin/logs?userId=${userId}&status=success`)
      .set("Authorization", `Bearer ${admin}`);
    expect(successOnly.body.logs.every((l: { status: string }) => l.status === "success")).toBe(true);
    expect(successOnly.body.logs.some((l: { user_id: number }) => l.user_id === userId)).toBe(true);
  });
});

describe("admin dashboard", () => {
  it("returns platform summary counts", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "dashuser");
    await newContainer(ctx, token);

    const admin = await adminToken(ctx);
    const dash = await ctx.request().get("/api/v1/admin/dashboard").set("Authorization", `Bearer ${admin}`);
    expect(dash.status).toBe(200);
    expect(dash.body.users).toBeGreaterThanOrEqual(2); // admin + dashuser
    expect(dash.body.images).toBe(3);
    expect(dash.body.runningContainers).toBeGreaterThanOrEqual(1);
    expect(dash.body.containersByStatus.running).toBeGreaterThanOrEqual(1);
    expect(dash.body.executor).toBe("mock");
  });

  it("admin can list all containers across users", async () => {
    ctx = await setupTestApp();
    await createUserAndLogin(ctx, "u1");
    await createUserAndLogin(ctx, "u2");
    await newContainer(ctx, await ctx.request().post("/api/v1/auth/login").send({ username: "u1", password: "password1" }).then((r) => r.body.accessToken));

    const admin = await adminToken(ctx);
    const list = await ctx.request().get("/api/v1/admin/containers").set("Authorization", `Bearer ${admin}`);
    expect(list.status).toBe(200);
    expect(list.body.containers.length).toBeGreaterThanOrEqual(1);
  });
});
