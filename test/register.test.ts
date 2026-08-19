/**
 * R1 self-registration + admin approval queue + CSV import, and R9 forced
 * password change.
 *
 * REGISTER_MODE drives the public POST /auth/register behavior; tests flip the
 * env before creating the app and reset the config cache afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, type TestContext } from "./helper.ts";
import { resetConfigForTesting } from "../src/config.ts";

describe("R1 self-registration", () => {
  describe("REGISTER_MODE=off (default)", () => {
    let ctx: TestContext;
    beforeEach(async () => {
      delete process.env.REGISTER_MODE;
      resetConfigForTesting();
      ctx = await setupTestApp();
    });
    afterEach(async () => {
      await teardownTestApp(ctx);
    });

    it("GET /auth/config reports registerMode=off", async () => {
      const res = await ctx.request().get("/api/v1/auth/config");
      expect(res.status).toBe(200);
      expect(res.body.registerMode).toBe("off");
    });

    it("POST /auth/register returns 404 (endpoint appears not to exist)", async () => {
      const res = await ctx
        .request()
        .post("/api/v1/auth/register")
        .send({ username: "newuser", password: "password1" });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    });
  });

  describe("REGISTER_MODE=open", () => {
    let ctx: TestContext;
    beforeEach(async () => {
      process.env.REGISTER_MODE = "open";
      resetConfigForTesting();
      ctx = await setupTestApp();
    });
    afterEach(async () => {
      await teardownTestApp(ctx);
      delete process.env.REGISTER_MODE;
      resetConfigForTesting();
    });

    it("registers an active account that can log in immediately", async () => {
      const reg = await ctx
        .request()
        .post("/api/v1/auth/register")
        .send({ username: "student1", password: "password1", email: "s1@example.com" });
      expect(reg.status).toBe(201);
      expect(reg.body.user.status).toBe("active");
      expect(reg.body.user.quota_id).toBeTruthy(); // default quota template applied

      const login = await ctx
        .request()
        .post("/api/v1/auth/login")
        .send({ username: "student1", password: "password1" });
      expect(login.status).toBe(200);
    });

    it("rejects weak passwords per the configured policy", async () => {
      process.env.PASSWORD_MIN_LENGTH = "12";
      resetConfigForTesting();
      const res = await ctx
        .request()
        .post("/api/v1/auth/register")
        .send({ username: "student2", password: "short" });
      expect(res.status).toBe(400);
      delete process.env.PASSWORD_MIN_LENGTH;
      resetConfigForTesting();
    });

    it("rejects duplicate usernames with 409", async () => {
      await ctx.request().post("/api/v1/auth/register").send({ username: "dup", password: "password1" });
      const res = await ctx.request().post("/api/v1/auth/register").send({ username: "dup", password: "password1" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CONFLICT");
    });

    it("rate-limits registration when enabled", async () => {
      // Separate app with the limiter on and a 2/min cap.
      process.env.RATE_LIMIT_ENABLED = "true";
      process.env.RATE_LIMIT_REGISTER_PER_MINUTE = "2";
      resetConfigForTesting();
      const ctx2 = await setupTestApp();
      try {
        for (let i = 0; i < 2; i++) {
          const r = await ctx2
            .request()
            .post("/api/v1/auth/register")
            .send({ username: `rl${i}`, password: "password1" });
          expect(r.status).toBe(201);
        }
        const blocked = await ctx2
          .request()
          .post("/api/v1/auth/register")
          .send({ username: "rl3", password: "password1" });
        expect(blocked.status).toBe(429);
      } finally {
        await teardownTestApp(ctx2);
        delete process.env.RATE_LIMIT_ENABLED;
        delete process.env.RATE_LIMIT_REGISTER_PER_MINUTE;
        resetConfigForTesting();
      }
    });
  });

  describe("REGISTER_MODE=approval", () => {
    let ctx: TestContext;
    beforeEach(async () => {
      process.env.REGISTER_MODE = "approval";
      resetConfigForTesting();
      ctx = await setupTestApp();
    });
    afterEach(async () => {
      await teardownTestApp(ctx);
      delete process.env.REGISTER_MODE;
      resetConfigForTesting();
    });

    it("creates a pending account that cannot log in until approved", async () => {
      const reg = await ctx
        .request()
        .post("/api/v1/auth/register")
        .send({ username: "pending1", password: "password1" });
      expect(reg.status).toBe(201);
      expect(reg.body.user.status).toBe("pending");
      expect(reg.body.message).toBeTruthy();

      const login = await ctx
        .request()
        .post("/api/v1/auth/login")
        .send({ username: "pending1", password: "password1" });
      expect(login.status).toBe(403);
      expect(login.body.code).toBe("ACCOUNT_PENDING");

      // Admin approval queue: list pending users.
      const admin = await adminToken(ctx);
      const list = await ctx
        .request()
        .get("/api/v1/admin/users?status=pending")
        .set("Authorization", `Bearer ${admin}`);
      expect(list.status).toBe(200);
      const pending = list.body.users.filter((u: { username: string }) => u.username === "pending1");
      expect(pending).toHaveLength(1);

      // Approve, then login succeeds.
      const approve = await ctx
        .request()
        .post(`/api/v1/admin/users/${pending[0].id}/approve`)
        .set("Authorization", `Bearer ${admin}`);
      expect(approve.status).toBe(200);
      expect(approve.body.status).toBe("active");

      const login2 = await ctx
        .request()
        .post("/api/v1/auth/login")
        .send({ username: "pending1", password: "password1" });
      expect(login2.status).toBe(200);
    });

    it("reject deletes a pending account", async () => {
      await ctx.request().post("/api/v1/auth/register").send({ username: "pending2", password: "password1" });
      const admin = await adminToken(ctx);
      const list = await ctx
        .request()
        .get("/api/v1/admin/users?status=pending")
        .set("Authorization", `Bearer ${admin}`);
      const id = list.body.users.find((u: { username: string }) => u.username === "pending2").id;
      const reject = await ctx
        .request()
        .post(`/api/v1/admin/users/${id}/reject`)
        .set("Authorization", `Bearer ${admin}`);
      expect(reject.status).toBe(204);
      const gone = await ctx
        .request()
        .post("/api/v1/auth/login")
        .send({ username: "pending2", password: "password1" });
      expect(gone.status).toBe(401);
    });

    it("approve on a non-pending user returns 409", async () => {
      const admin = await adminToken(ctx);
      const res = await ctx.request().post("/api/v1/admin/users/1/approve").set("Authorization", `Bearer ${admin}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_STATE");
    });
  });

  describe("R1 CSV batch import", () => {
    let ctx: TestContext;
    beforeEach(async () => {
      ctx = await setupTestApp();
    });
    afterEach(async () => {
      await teardownTestApp(ctx);
    });

    it("imports rows, skips the header, and reports per-row failures", async () => {
      const admin = await adminToken(ctx);
      // Pre-existing user to trigger a per-row duplicate failure.
      await ctx
        .request()
        .post("/api/v1/admin/users")
        .set("Authorization", `Bearer ${admin}`)
        .send({ username: "taken", password: "password1" });

      const csv = [
        "username,password,email",
        "# a comment line is skipped",
        "alice,alicepass1,alice@example.com",
        "taken,password1,dup@example.com",
        "bob,bobpass1",
      ].join("\n");
      const res = await ctx
        .request()
        .post("/api/v1/admin/users/import")
        .set("Authorization", `Bearer ${admin}`)
        .send({ csv, mustChangePassword: true });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(2);
      expect(res.body.failed).toBe(1);
      const takenRow = res.body.results.find((r: { username: string }) => r.username === "taken");
      expect(takenRow.ok).toBe(false);

      // Imported accounts force a password change (R9 flag propagated).
      const login = await ctx
        .request()
        .post("/api/v1/auth/login")
        .send({ username: "alice", password: "alicepass1" });
      expect(login.status).toBe(200);
      expect(login.body.user.must_change_password).toBe(true);
    });

    it("rejects an empty CSV", async () => {
      const admin = await adminToken(ctx);
      const res = await ctx
        .request()
        .post("/api/v1/admin/users/import")
        .set("Authorization", `Bearer ${admin}`)
        .send({ csv: "# only comments\n\n" });
      expect(res.status).toBe(400);
    });
  });
});

describe("R9 forced password change", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupTestApp();
  });
  afterEach(async () => {
    await teardownTestApp(ctx);
  });

  it("gates flagged accounts until change-password completes", async () => {
    const admin = await adminToken(ctx);
    const create = await ctx
      .request()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({ username: "freshman", password: "password1", mustChangePassword: true });
    expect(create.status).toBe(201);
    expect(create.body.must_change_password).toBe(true);

    const login = await ctx
      .request()
      .post("/api/v1/auth/login")
      .send({ username: "freshman", password: "password1" });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;

    // Most endpoints are gated...
    const blocked = await ctx
      .request()
      .get("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");

    // ...but /me and change-password remain reachable.
    const me = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);

    const wrong = await ctx
      .request()
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "wrongpass", newPassword: "newpassword1" });
    expect(wrong.status).toBe(401);

    const change = await ctx
      .request()
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "password1", newPassword: "newpassword1" });
    expect(change.status).toBe(204);

    // The gated access token still works after the flag clears (claim was in
    // the token, but the DB no longer flags it — requireAuth consults the claim
    // only, so the client must re-login; verify fresh login is ungated).
    const relogin = await ctx
      .request()
      .post("/api/v1/auth/login")
      .send({ username: "freshman", password: "newpassword1" });
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.must_change_password).toBe(false);
    const ok = await ctx
      .request()
      .get("/api/v1/containers")
      .set("Authorization", `Bearer ${relogin.body.accessToken}`);
    expect(ok.status).toBe(200);
  });
});
