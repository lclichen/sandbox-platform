/**
 * Fix-plan C4/C5 coverage:
 *  - tools resource caps (read size, stderr truncation, grep line/pattern caps)
 *  - token_version revocation: password change/reset kills outstanding access
 *    tokens immediately and admin reset also revokes refresh tokens
 *  - admin self-protection on PATCH /admin/users
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await setupTestApp();
});

afterEach(async () => {
  await teardownTestApp(ctx);
});

async function createContainer(token: string): Promise<number> {
  const images = await ctx.request().get("/api/v1/images").set("Authorization", `Bearer ${token}`);
  const imageId = images.body.images[0].id as number;
  const res = await ctx
    .request()
    .post("/api/v1/containers")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageId, name: `caps-c-${Date.now()}` });
  if (res.status !== 201) throw new Error(`container create failed: ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

describe("C4 tools resource caps", () => {
  it("rejects reads above the size cap with 413", async () => {
    const token = await createUserAndLogin(ctx, "capread");
    const containerId = await createContainer(token);
    // 3 MB via dd (portable across Git Bash / Linux container shells).
    const mk = await ctx
      .request()
      .post(`/api/v1/containers/${containerId}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "mkdir -p tmp && dd if=/dev/zero of=tmp/big.bin bs=1024 count=3072 2>/dev/null && echo made" });
    expect(mk.status).toBeLessThan(300);
    expect(mk.body.exitCode).toBe(0);
    const res = await ctx
      .request()
      .post(`/api/v1/containers/${containerId}/tools/read`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "tmp/big.bin" });
    expect(res.status).toBe(413);
    expect(res.body?.code).toBe("FILE_TOO_LARGE");
  });

  it("truncates huge stderr like stdout", async () => {
    const token = await createUserAndLogin(ctx, "capstderr");
    const containerId = await createContainer(token);
    // A bounded loop: `yes | head` relies on SIGPIPE, which MSYS/Git Bash does
    // not deliver reliably and would hang the exec until its timeout.
    const res = await ctx
      .request()
      .post(`/api/v1/containers/${containerId}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "i=0; while [ $i -lt 20000 ]; do echo spamspamspamspam >&2; i=$((i+1)); done; true" });
    expect(res.status).toBeLessThan(300);
    expect(Buffer.byteLength(res.body.stderr ?? "")).toBeLessThanOrEqual(60_000);
    expect(res.body.truncated).toBe(true);
  }, 60_000);

  it("rejects oversized grep patterns", async () => {
    const token = await createUserAndLogin(ctx, "cappattern");
    const containerId = await createContainer(token);
    const res = await ctx
      .request()
      .post(`/api/v1/containers/${containerId}/tools/grep`)
      .set("Authorization", `Bearer ${token}`)
      .send({ pattern: "a".repeat(2000), literal: true });
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe("PATTERN_TOO_LONG");
  });

  it("grep cannot be stalled by a catastrophic-backtracking pattern on a long line", async () => {
    const token = await createUserAndLogin(ctx, "capredos");
    const containerId = await createContainer(token);
    // A long line (200k chars of 'a') + classic catastrophic pattern. Without
    // the line-truncation cap this pins the event loop for minutes.
    const mk = await ctx
      .request()
      .post(`/api/v1/containers/${containerId}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "dd if=/dev/zero bs=1024 count=200 2>/dev/null | tr '\\0' 'a' > longline.txt && echo ok" });
    expect(mk.status).toBeLessThan(300);
    expect(mk.body.exitCode).toBe(0);
    const began = Date.now();
    const res = await ctx
      .request()
      .post(`/api/v1/containers/${containerId}/tools/grep`)
      .set("Authorization", `Bearer ${token}`)
      .send({ pattern: "(a+)+$", path: "." });
    expect(res.status).toBeLessThan(300);
    expect(Date.now() - began).toBeLessThan(15_000);
  }, 30_000);
});

describe("C5 token_version revocation", () => {
  it("a password change invalidates outstanding access tokens immediately", async () => {
    const token = await createUserAndLogin(ctx, "tvuser", "password1");
    // token works
    const before = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);
    // self password change
    const change = await ctx
      .request()
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "password1", newPassword: "password2A" });
    expect(change.status).toBeLessThan(300);
    // the SAME token must now be rejected (not after 15 minutes)
    const after = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it("an admin reset also revokes the target's refresh tokens", async () => {
    const admin = await adminToken(ctx);
    const password = "password1";
    const create = await ctx
      .request()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({ username: "tvreset", password });
    expect(create.status).toBe(201);
    const userId = create.body.id as number;

    const login = await ctx.request().post("/api/v1/auth/login").send({ username: "tvreset", password });
    expect(login.status).toBe(200);
    const refresh = login.body.refreshToken as string;

    const reset = await ctx
      .request()
      .post(`/api/v1/admin/users/${userId}/password`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ password: "newPassword2B" });
    expect(reset.status).toBeLessThan(300);

    const replay = await ctx.request().post("/api/v1/auth/refresh").send({ refreshToken: refresh });
    expect(replay.status).toBe(401);
  });

  it("disabling a user kills their live access tokens", async () => {
    const admin = await adminToken(ctx);
    const token = await createUserAndLogin(ctx, "tvdisable", "password1");
    const userId = (
      await (
        await ctx.request().get("/api/v1/admin/users?search=tvdisable").set("Authorization", `Bearer ${admin}`)
      ).body
    ).users?.[0]?.id as number;
    expect(userId).toBeTruthy();
    const disable = await ctx
      .request()
      .patch(`/api/v1/admin/users/${userId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ status: "disabled" });
    expect(disable.status).toBeLessThan(300);
    const denied = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(denied.status).toBe(401);
  });

  it("admin cannot demote/disable themselves or the last active admin", async () => {
    const admin = await adminToken(ctx);
    const self = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${admin}`);
    const adminId = self.body.user.id as number;
    const demote = await ctx
      .request()
      .patch(`/api/v1/admin/users/${adminId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ role: "user" });
    expect(demote.status).toBe(400);
    const disable = await ctx
      .request()
      .patch(`/api/v1/admin/users/${adminId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ status: "disabled" });
    expect(disable.status).toBe(400);
  });
});
