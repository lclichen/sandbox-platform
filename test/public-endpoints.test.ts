/**
 * Milestone 1: public endpoints + ownership isolation.
 *
 * Verifies that regular users can access /auth/dashboard, /images (public),
 * and /logs (own), and that they see ONLY their own data.
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

async function newContainer(ctx: TestContext, token: string, name: string): Promise<number> {
  const admin = await adminToken(ctx);
  const images = await ctx.request().get("/api/v1/admin/images").set("Authorization", `Bearer ${admin}`);
  const imageId = images.body.images[0].id;
  const res = await ctx
    .request()
    .post("/api/v1/containers")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageId, name });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe("public images endpoint", () => {
  it("lists public images for any authenticated user", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "viewer");
    const res = await ctx.request().get("/api/v1/images").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Seeded images are all public.
    expect(res.body.images.length).toBe(3);
    expect(res.body.images.every((i: { is_public: boolean }) => i.is_public)).toBe(true);
  });

  it("denies unauthenticated access", async () => {
    ctx = await setupTestApp();
    const res = await ctx.request().get("/api/v1/images");
    expect(res.status).toBe(401);
  });
});

describe("per-user dashboard", () => {
  it("returns the current user's own container counts", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "alice");
    await newContainer(ctx, token, "alice-box");

    const res = await ctx.request().get("/api/v1/auth/dashboard").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.myContainers).toBe(1);
    expect(res.body.runningContainers).toBe(1);
    expect(res.body.containersByStatus.running).toBe(1);
  });

  it("does not count other users' containers", async () => {
    ctx = await setupTestApp();
    const alice = await createUserAndLogin(ctx, "alice");
    const bob = await createUserAndLogin(ctx, "bob");
    await newContainer(ctx, alice, "alice-box");
    await newContainer(ctx, bob, "bob-box-1");
    await newContainer(ctx, bob, "bob-box-2");

    const aliceDash = await ctx.request().get("/api/v1/auth/dashboard").set("Authorization", `Bearer ${alice}`);
    expect(aliceDash.body.myContainers).toBe(1); // only her own
    const bobDash = await ctx.request().get("/api/v1/auth/dashboard").set("Authorization", `Bearer ${bob}`);
    expect(bobDash.body.myContainers).toBe(2);
  });
});

describe("per-user logs endpoint", () => {
  it("returns only the current user's log entries", async () => {
    ctx = await setupTestApp();
    const alice = await createUserAndLogin(ctx, "alice");
    const bob = await createUserAndLogin(ctx, "bob");
    // Each creating a container generates a container.create audit entry.
    await newContainer(ctx, alice, "alice-box");
    await newContainer(ctx, bob, "bob-box");

    const aliceLogs = await ctx.request().get("/api/v1/logs").set("Authorization", `Bearer ${alice}`);
    expect(aliceLogs.status).toBe(200);
    const aliceActions = aliceLogs.body.logs.map((l: { action: string }) => l.action);
    expect(aliceActions).toContain("container.create");
    // Alice should NOT see bob's entries: every entry's user_id must be alice's.
    const aliceId = (await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${alice}`)).body.user.id;
    expect(aliceLogs.body.logs.every((l: { user_id: number }) => l.user_id === aliceId)).toBe(true);
  });
});
