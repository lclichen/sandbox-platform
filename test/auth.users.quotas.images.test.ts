/**
 * Milestone 2 E2E: auth flow, RBAC, and admin CRUD for users/quotas/images.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, type TestContext } from "./helper.ts";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
});

describe("auth", () => {
  it("logs in with seeded admin and returns a token pair", async () => {
    ctx = await setupTestApp();
    const res = await ctx
      .request()
      .post("/api/v1/auth/login")
      .send({ username: ctx.admin.username, password: ctx.admin.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf("string");
    expect(res.body.refreshToken).toBeTypeOf("string");
    expect(res.body.user.username).toBe("admin");
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it("rejects wrong password with 401", async () => {
    ctx = await setupTestApp();
    const res = await ctx
      .request()
      .post("/api/v1/auth/login")
      .send({ username: ctx.admin.username, password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("exposes /me behind a token", async () => {
    ctx = await setupTestApp();
    const token = await adminToken(ctx);
    const res = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("admin");
  });

  it("denies /me without a token", async () => {
    ctx = await setupTestApp();
    const res = await ctx.request().get("/api/v1/auth/me");
    expect(res.status).toBe(401);
  });

  it("rotates refresh tokens and revokes the whole family on replay", async () => {
    ctx = await setupTestApp();
    const login = await ctx
      .request()
      .post("/api/v1/auth/login")
      .send({ username: ctx.admin.username, password: ctx.admin.password });
    const oldRefresh = login.body.refreshToken;

    const refresh1 = await ctx.request().post("/api/v1/auth/refresh").send({ refreshToken: oldRefresh });
    expect(refresh1.status).toBe(200);
    expect(refresh1.body.refreshToken).not.toBe(oldRefresh);
    const sibling = refresh1.body.refreshToken;

    // Replay of the revoked token is a theft signal: the ENTIRE family dies
    // (P1-3), so the sibling token rotated alongside it is dead too.
    const reuse = await ctx.request().post("/api/v1/auth/refresh").send({ refreshToken: oldRefresh });
    expect(reuse.status).toBe(401);

    const siblingReuse = await ctx.request().post("/api/v1/auth/refresh").send({ refreshToken: sibling });
    expect(siblingReuse.status).toBe(401);
  });
});

describe("RBAC", () => {
  it("blocks non-admin from admin users list", async () => {
    ctx = await setupTestApp();
    // Create a regular user via admin.
    const adminTokenValue = await adminToken(ctx);
    const create = await ctx
      .request()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${adminTokenValue}`)
      .send({ username: "alice", password: "password1" });
    expect(create.status).toBe(201);

    const login = await ctx.request().post("/api/v1/auth/login").send({ username: "alice", password: "password1" });
    const userToken = login.body.accessToken;

    const blocked = await ctx
      .request()
      .get("/api/v1/admin/users")
      .set("Authorization", `Bearer ${userToken}`);
    expect(blocked.status).toBe(403);
  });
});

describe("admin users CRUD", () => {
  it("creates, lists, updates, changes password, deletes a user", async () => {
    ctx = await setupTestApp();
    const token = await adminToken(ctx);

    const create = await ctx
      .request()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "bob", password: "initialpw1", email: "bob@x.com" });
    expect(create.status).toBe(201);
    expect(create.body.username).toBe("bob");
    const bobId = create.body.id;

    const list = await ctx.request().get("/api/v1/admin/users").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(2);

    const patch = await ctx
      .request()
      .patch(`/api/v1/admin/users/${bobId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "bob2@x.com", status: "disabled" });
    expect(patch.status).toBe(200);
    expect(patch.body.email).toBe("bob2@x.com");
    expect(patch.body.status).toBe("disabled");

    const pw = await ctx
      .request()
      .post(`/api/v1/admin/users/${bobId}/password`)
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "newpassword1" });
    expect(pw.status).toBe(204);

    // New password works.
    const relogin = await ctx
      .request()
      .post("/api/v1/auth/login")
      .send({ username: "bob", password: "newpassword1" });
    expect(relogin.status).toBe(403); // disabled account cannot log in

    // Re-enable then delete.
    await ctx.request().patch(`/api/v1/admin/users/${bobId}`).set("Authorization", `Bearer ${token}`).send({ status: "active" });
    const del = await ctx.request().delete(`/api/v1/admin/users/${bobId}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);
  });

  it("rejects duplicate username", async () => {
    ctx = await setupTestApp();
    const token = await adminToken(ctx);
    const dup = await ctx
      .request()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: "admin", password: "whatever1" });
    expect(dup.status).toBe(409);
  });

  it("treats empty/'undefined' search as no filter instead of matching nothing", async () => {
    ctx = await setupTestApp();
    const token = await adminToken(ctx);

    const empty = await ctx
      .request()
      .get("/api/v1/admin/users?limit=20&offset=0&search=")
      .set("Authorization", `Bearer ${token}`);
    expect(empty.status).toBe(200);
    expect(empty.body.total).toBeGreaterThanOrEqual(1);

    // A client serializing `undefined` sends the literal string "undefined".
    const undefinedStr = await ctx
      .request()
      .get("/api/v1/admin/users?limit=20&offset=0&search=undefined")
      .set("Authorization", `Bearer ${token}`);
    expect(undefinedStr.status).toBe(200);
    expect(undefinedStr.body.total).toBeGreaterThanOrEqual(1);

    // A real search term still filters.
    const real = await ctx
      .request()
      .get("/api/v1/admin/users?limit=20&offset=0&search=admin")
      .set("Authorization", `Bearer ${token}`);
    expect(real.status).toBe(200);
    expect(real.body.total).toBeGreaterThanOrEqual(1);
    expect(real.body.users.map((u: { username: string }) => u.username)).toContain("admin");
  });
});

describe("admin quotas CRUD", () => {
  it("lists seeded quotas and creates a new one", async () => {
    ctx = await setupTestApp();
    const token = await adminToken(ctx);
    const list = await ctx.request().get("/api/v1/admin/quotas").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.quotas.map((q: { name: string }) => q.name)).toContain("default");

    const create = await ctx
      .request()
      .post("/api/v1/admin/quotas")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "tiny",
        max_containers: 1,
        max_cpu_cores: 1,
        max_memory_mb: 512,
        max_disk_gb: 2,
        max_snapshots_per_container: 1,
      });
    expect(create.status).toBe(201);
    expect(create.body.name).toBe("tiny");
  });
});

describe("admin images CRUD", () => {
  it("lists seeded images and creates/updates/deletes one", async () => {
    ctx = await setupTestApp();
    const token = await adminToken(ctx);
    const list = await ctx.request().get("/api/v1/admin/images").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.images.length).toBe(3);

    const create = await ctx
      .request()
      .post("/api/v1/admin/images")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "rust-1.80",
        display_name: "Rust 1.80",
        sif_path: "/srv/rust-1.80.sif",
        tags: ["linux", "rust"],
        default_resources: { cpu: 2, memoryMb: 2048, diskGb: 8 },
      });
    expect(create.status).toBe(201);
    expect(create.body.tags).toEqual(["linux", "rust"]);
    expect(create.body.default_resources).toEqual({ cpu: 2, memoryMb: 2048, diskGb: 8 });

    const patch = await ctx
      .request()
      .patch(`/api/v1/admin/images/${create.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ display_name: "Rust 1.80 (updated)" });
    expect(patch.status).toBe(200);
    expect(patch.body.display_name).toBe("Rust 1.80 (updated)");

    const del = await ctx.request().delete(`/api/v1/admin/images/${create.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);
  });
});
