/**
 * API key lifecycle: create, authenticate via X-API-Key and Bearer, revoke.
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

async function createKey(ctx: TestContext, userToken: string, name: string): Promise<{ id: number; key: string }> {
  const res = await ctx
    .request()
    .post("/api/v1/auth/api-keys")
    .set("Authorization", `Bearer ${userToken}`)
    .send({ name });
  expect(res.status).toBe(201);
  expect(res.body.key).toMatch(/^sk_[0-9a-f]{32}$/);
  return { id: res.body.id as number, key: res.body.key as string };
}

describe("API keys", () => {
  it("creates a key and authenticates with X-API-Key", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "keyuser");
    const { key } = await createKey(ctx, token, "my-ci-key");

    // The plaintext works as X-API-Key.
    const me = await ctx.request().get("/api/v1/auth/me").set("X-API-Key", key);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe("keyuser");
  });

  it("authenticates with Authorization: Bearer sk-...", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "beareruser");
    const { key } = await createKey(ctx, token, "bearer-key");

    const me = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${key}`);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe("beareruser");
  });

  it("key grants the owner's permissions (creates a container)", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "containeruser");
    const { key } = await createKey(ctx, token, "work-key");

    // Need an image id (public listing works for any auth).
    const images = await ctx.request().get("/api/v1/images").set("Authorization", `Bearer ${key}`);
    const imageId = images.body.images[0].id;

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${key}`)
      .send({ imageId, name: "via-apikey" });
    expect(create.status).toBe(201);
    expect(create.body.user_id).toBeDefined();
  });

  it("lists keys without exposing the secret", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "lister");
    await createKey(ctx, token, "k1");
    await createKey(ctx, token, "k2");

    const res = await ctx.request().get("/api/v1/auth/api-keys").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.apiKeys.length).toBe(2);
    // No key field, no hash field in the listing.
    for (const k of res.body.apiKeys) {
      expect(k.key).toBeUndefined();
      expect(k.key_hash).toBeUndefined();
      expect(k.key_prefix).toMatch(/^sk_[0-9a-f]{8}$/);
      expect(k.name).toBeTypeOf("string");
    }
  });

  it("revoked key can no longer authenticate", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "revoker");
    const { id, key } = await createKey(ctx, token, "doomed");

    const revoke = await ctx
      .request()
      .delete(`/api/v1/auth/api-keys/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(revoke.status).toBe(204);

    const me = await ctx.request().get("/api/v1/auth/me").set("X-API-Key", key);
    expect(me.status).toBe(401);
  });

  it("admin endpoint still rejects a regular user's API key", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "regular");
    const { key } = await createKey(ctx, token, "admin-probe");

    const res = await ctx.request().get("/api/v1/admin/users").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(403); // key carries the user's role (user, not admin)
  });

  it("admin's API key can access admin endpoints", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const { key } = await createKey(ctx, admin, "admin-key");

    const res = await ctx.request().get("/api/v1/admin/users").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(200);
  });
});
