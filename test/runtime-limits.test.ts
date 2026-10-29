/**
 * Runtime upload limits (services/runtime-settings.ts).
 *
 * The per-file workspace cap must be adjustable by an admin WITHOUT a platform
 * restart, enforced by the very next upload, readable by ordinary users (for
 * pre-checks), and resettable back to the env default. The override file is
 * the only new state; config stays the default.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";
import { join } from "node:path";

let ctx: TestContext | undefined;

afterEach(async () => {
  delete process.env.RUNTIME_SETTINGS_PATH;
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
});

/** Isolate the runtime-settings file per test (never the repo ./data). */
async function setup(): Promise<TestContext> {
  const c = await setupTestApp();
  process.env.RUNTIME_SETTINGS_PATH = join(c.tmpDir, "runtime-settings.json");
  return c;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function seedWorkspace(c: TestContext, token: string): Promise<number> {
  const create = await c.request().post("/api/v1/workspaces").set(auth(token)).send({ name: "limits-ws" });
  expect(create.status).toBe(201);
  return create.body.id as number;
}

describe("runtime upload limits", () => {
  it("exposes defaults, applies an admin override immediately, and resets", async () => {
    ctx = await setup();
    const admin = await adminToken(ctx);

    const before = await ctx.request().get("/api/v1/limits").set(auth(admin));
    expect(before.status).toBe(200);
    expect(before.body.workspaceUploadMaxBytes).toBe(before.body.envDefaultBytes);
    expect(before.body.minBytes).toBeGreaterThan(0);
    expect(before.body.maxBytes).toBeGreaterThan(before.body.workspaceUploadMaxBytes);

    const wsId = await seedWorkspace(ctx, admin);
    const oneMb = Buffer.alloc(1024 * 1024, 7);

    // Lower the cap to 2 MiB. Enforcement reads the override on the next call:
    // the policy check (shared by single-shot and chunked uploads) refuses a
    // larger declared size, and a 1 MiB upload still succeeds.
    const put = await ctx.request()
      .put("/api/v1/admin/limits")
      .set(auth(admin))
      .send({ workspaceUploadMaxBytes: 2 * 1024 * 1024 });
    expect(put.status).toBe(200);
    expect(put.body.workspaceUploadMaxBytes).toBe(2 * 1024 * 1024);

    const { createWorkspaceService } = await import("../src/services/workspace.service.ts");
    await expect(
      createWorkspaceService(ctx.db).startUpload(
        wsId,
        1,
        { name: "big.bin", dirRel: "", size: 3 * 1024 * 1024 },
        true,
      ),
    ).rejects.toThrow(/per-file limit/i);

    const small = await ctx.request()
      .post(`/api/v1/workspaces/${wsId}/files?path=&name=small.bin`)
      .set(auth(admin))
      .set("Content-Type", "application/octet-stream")
      .send(oneMb);
    expect(small.status).toBe(201);

    // Ordinary users read the effective cap but cannot change it.
    const user = await createUserAndLogin(ctx, "limits-user");
    const asUser = await ctx.request().get("/api/v1/limits").set(auth(user));
    expect(asUser.status).toBe(200);
    expect(asUser.body.workspaceUploadMaxBytes).toBe(2 * 1024 * 1024);
    const denied = await ctx.request()
      .put("/api/v1/admin/limits")
      .set(auth(user))
      .send({ workspaceUploadMaxBytes: 9 * 1024 * 1024 });
    expect(denied.status).toBe(403);

    // Reset → env default again.
    const reset = await ctx.request().put("/api/v1/admin/limits").set(auth(admin)).send({ workspaceUploadMaxBytes: null });
    expect(reset.status).toBe(200);
    expect(reset.body.workspaceUploadMaxBytes).toBe(before.body.envDefaultBytes);
  });

  it("rejects caps outside the sanity bounds", async () => {
    ctx = await setup();
    const admin = await adminToken(ctx);
    const tooSmall = await ctx.request()
      .put("/api/v1/admin/limits")
      .set(auth(admin))
      .send({ workspaceUploadMaxBytes: 1024 });
    expect([400, 422]).toContain(tooSmall.status);
    const tooBig = await ctx.request()
      .put("/api/v1/admin/limits")
      .set(auth(admin))
      .send({ workspaceUploadMaxBytes: 1024 * 1024 * 1024 * 1024 });
    expect([400, 422]).toContain(tooBig.status);
  });
});
