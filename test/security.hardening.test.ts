/**
 * Regression tests for the 2026-11 security hardening pass.
 *
 * Covers the authorization/secret/path fixes that are easy to reintroduce:
 * OIDC return-URL matching, private-image access, live JWT role state, login
 * account-state enumeration, workspace symlink escapes, chunked-upload disk
 * caps, broad env masking, and concurrent refresh-token rotation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, symlink, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { isAllowedOidcRedirect } from "../src/routes/auth.routes.ts";
import { resolveImagePath } from "../src/services/image.service.ts";
import { uploadPartMaxBytes } from "../src/services/workspace-storage.ts";
import {
  setupTestApp,
  teardownTestApp,
  adminToken,
  createUserAndLogin,
  type TestContext,
} from "./helper.ts";

// Dummy fixtures — not real credentials. Kept in variables so secret scanners
// do not treat test payloads as leaked production secrets.
const pw = "password1";
const badPw = "wrong-password";
const fixture = "redacted";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestApp();
});

afterAll(async () => {
  delete process.env.RUNTIME_SETTINGS_PATH;
  await teardownTestApp(ctx);
});

describe("OIDC redirect allowlist", () => {
  it("matches by origin + path boundary, not raw string prefix", () => {
    const allow = ["https://pi.example.com/app"];
    expect(isAllowedOidcRedirect("https://pi.example.com/app", allow)).toBe(true);
    expect(isAllowedOidcRedirect("https://pi.example.com/app/cb?x=1", allow)).toBe(true);
    // The vulnerabilities this replaced: sibling-domain and path-prefix bypass.
    expect(isAllowedOidcRedirect("https://pi.example.com.evil.com/app", allow)).toBe(false);
    expect(isAllowedOidcRedirect("https://pi.example.com/application", allow)).toBe(false);
    expect(isAllowedOidcRedirect("https://pi.example.com@app.evil.com/app", allow)).toBe(false);
    expect(isAllowedOidcRedirect("http://pi.example.com/app", allow)).toBe(false);
    expect(isAllowedOidcRedirect("javascript:alert(1)", allow)).toBe(false);
  });

  it("an origin-only entry allows any path but not a different origin", () => {
    const allow = ["https://pi.example.com"];
    expect(isAllowedOidcRedirect("https://pi.example.com/a/b", allow)).toBe(true);
    expect(isAllowedOidcRedirect("https://evil.example.com/", allow)).toBe(false);
  });
});

describe("container image authorization", () => {
  it("rejects a private image for a regular user but allows an admin", async () => {
    const admin = await adminToken(ctx);
    const image = await ctx
      .request()
      .post("/api/v1/admin/images")
      .set("Authorization", `Bearer ${admin}`)
      .send({ name: `private-${Date.now()}`, display_name: "Private", sif_path: "private.sif", is_public: false });
    expect(image.status).toBe(201);

    const user = await createUserAndLogin(ctx, `privuser${Date.now() % 100000}`);
    const denied = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${user}`)
      .send({ imageId: image.body.id, name: "priv-user" });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("IMAGE_NOT_ALLOWED");

    const allowed = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${admin}`)
      .send({ imageId: image.body.id, name: "priv-admin" });
    expect(allowed.status).toBe(201);
  });

  it("rejects relative image paths that escape IMAGE_BASE_DIR", () => {
    expect(() => resolveImagePath("../../../etc/passwd")).toThrow(/IMAGE_BASE_DIR/);
  });
});

describe("live credential state", () => {
  it("demoting an admin invalidates their existing admin token", async () => {
    const admin = await adminToken(ctx);
    const username = `demote${Date.now() % 100000}`;
    const created = await ctx
      .request()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({ username, password: pw });
    expect(created.status).toBe(201);
    const userId = created.body.id as number;

    const promote = await ctx
      .request()
      .patch(`/api/v1/admin/users/${userId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ role: "admin" });
    expect(promote.status).toBe(200);

    const promotedLogin = await ctx.request().post("/api/v1/auth/login").send({ username, password: pw });
    expect(promotedLogin.status).toBe(200);
    const promotedToken = promotedLogin.body.accessToken as string;

    const demote = await ctx
      .request()
      .patch(`/api/v1/admin/users/${userId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ role: "user" });
    expect(demote.status).toBe(200);

    const after = await ctx
      .request()
      .get("/api/v1/admin/users")
      .set("Authorization", `Bearer ${promotedToken}`);
    expect([401, 403]).toContain(after.status);
  });

  it("does not disclose pending status to a wrong password", async () => {
    const admin = await adminToken(ctx);
    const username = `pending${Date.now() % 100000}`;
    const created = await ctx
      .request()
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({ username, password: pw });
    expect(created.status).toBe(201);

    const pending = await ctx
      .request()
      .patch(`/api/v1/admin/users/${created.body.id}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ status: "pending" });
    expect(pending.status).toBe(200);

    const wrong = await ctx.request().post("/api/v1/auth/login").send({ username, password: badPw });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("UNAUTHORIZED");

    const right = await ctx.request().post("/api/v1/auth/login").send({ username, password: pw });
    expect(right.status).toBe(403);
    expect(right.body.code).toBe("ACCOUNT_PENDING");
  });

  it("allows exactly one of two concurrent refreshes of the same token", async () => {
    const username = `refreshrace${Date.now() % 100000}`;
    await createUserAndLogin(ctx, username);
    const login = await ctx.request().post("/api/v1/auth/login").send({ username, password: pw });
    expect(login.status).toBe(200);
    const refreshToken = login.body.refreshToken as string;

    const [a, b] = await Promise.all([
      ctx.request().post("/api/v1/auth/refresh").send({ refreshToken }),
      ctx.request().post("/api/v1/auth/refresh").send({ refreshToken }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });
});

describe("workspace path containment", () => {
  it("refuses to write through a symlinked parent directory", async () => {
    const token = await createUserAndLogin(ctx, `symlink${Date.now() % 100000}`);
    const me = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    const userId = me.body.user.id as number;

    const ws = await ctx
      .request()
      .post("/api/v1/workspaces")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "symlink-ws" });
    expect(ws.status).toBe(201);

    const wsDir = join(process.env.WORKSPACE_BASE_DIR!, `user-${userId}`, `ws-${ws.body.id}`);
    const outside = join(ctx.tmpDir, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(wsDir, "link"), process.platform === "win32" ? "junction" : "dir");

    const res = await ctx
      .request()
      .post(`/api/v1/workspaces/${ws.body.id}/files?path=link&name=evil.txt`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("pwned"));
    expect(res.status).toBe(400);
    await expect(access(join(outside, "evil.txt"))).rejects.toBeTruthy();
  });
});

describe("resource caps", () => {
  it("enforces the chunked-upload total on every part write", async () => {
    process.env.RUNTIME_SETTINGS_PATH = join(ctx.tmpDir, "runtime-settings.json");
    const admin = await adminToken(ctx);
    const setCap = await ctx
      .request()
      .put("/api/v1/admin/limits")
      .set("Authorization", `Bearer ${admin}`)
      .send({ workspaceUploadMaxBytes: 1024 * 1024 });
    expect(setCap.status).toBe(200);

    const token = await createUserAndLogin(ctx, `uploadcap${Date.now() % 100000}`);
    const ws = await ctx
      .request()
      .post("/api/v1/workspaces")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "upload-ws" });
    expect(ws.status).toBe(201);
    const start = await ctx
      .request()
      .post(`/api/v1/workspaces/${ws.body.id}/uploads`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "big.bin" });
    expect(start.status).toBe(201);

    const part = await ctx
      .request()
      .put(`/api/v1/workspaces/${ws.body.id}/uploads/${start.body.uploadId}?part=1`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(1024 * 1024 + 1));
    expect(part.status).toBe(413);
    expect(part.body.code).toBe("UPLOAD_TOO_LARGE");

    // Restore the env default for the rest of the suite.
    await ctx
      .request()
      .put("/api/v1/admin/limits")
      .set("Authorization", `Bearer ${admin}`)
      .send({ workspaceUploadMaxBytes: null });
    expect(uploadPartMaxBytes()).toBeGreaterThan(1024 * 1024);
  });

  it("masks secret-looking env values (substring, not just suffix)", async () => {
    const user = await createUserAndLogin(ctx, `envmask${Date.now() % 100000}`);
    const images = await ctx.request().get("/api/v1/images").set("Authorization", `Bearer ${user}`);
    const imageId = images.body.images[0].id as number;

    const created = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${user}`)
      .send({
        imageId,
        name: "env-mask",
        env: { OPENAI_APIKEY: fixture, DB_PASS: fixture, NORMAL_VALUE: "visible" },
      });
    expect(created.status).toBe(201);

    const fetched = await ctx
      .request()
      .get(`/api/v1/containers/${created.body.id}`)
      .set("Authorization", `Bearer ${user}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.env.OPENAI_APIKEY).toBe("***");
    expect(fetched.body.env.DB_PASS).toBe("***");
    expect(fetched.body.env.NORMAL_VALUE).toBe("visible");
  });
});
