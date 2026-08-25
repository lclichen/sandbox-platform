/**
 * Workspace feature: CRUD, file operations, ownership isolation, path-traversal
 * containment, quota enforcement, container seeding. Exercises the full
 * MockExecutor stack on win32.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  setupTestApp,
  teardownTestApp,
  createUserAndLogin,
  adminToken,
  type TestContext,
} from "./helper.ts";
import * as storage from "../src/services/workspace-storage.ts";
import { BadRequestError } from "../src/utils/errors.ts";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
});

async function createWorkspace(token: string, name: string, description?: string): Promise<{ id: number }> {
  const res = await ctx!
    .request()
    .post("/api/v1/workspaces")
    .set("Authorization", `Bearer ${token}`)
    .send({ name, description });
  expect(res.status).toBe(201);
  return { id: res.body.id as number };
}

describe("workspaces", () => {
  it("creates a workspace and lists it", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "wsuser");
    const { id } = await createWorkspace(token, "ml-project", "my ML project");

    const list = await ctx.request().get("/api/v1/workspaces").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.workspaces[0]).toMatchObject({
      id,
      name: "ml-project",
      description: "my ML project",
      user_id: expect.any(Number),
      is_template: false,
      size_bytes: 0,
      file_count: 0,
    });
    // storage_path uses the canonical id-driven layout.
    expect(list.body.workspaces[0].storage_path).toMatch(/^user-\d+\/ws-\d+$/);
  });

  it("rejects duplicate names per user", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "dupuser");
    await createWorkspace(token, "dup");
    const res = await ctx
      .request()
      .post("/api/v1/workspaces")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "dup" });
    expect(res.status).toBe(409);
  });

  it("isolates workspaces between users (404, not 403)", async () => {
    ctx = await setupTestApp();
    const a = await createUserAndLogin(ctx, "alice");
    const b = await createUserAndLogin(ctx, "bob");
    const { id } = await createWorkspace(a, "alice-ws");

    // Bob cannot see Alice's workspace.
    const get = await ctx.request().get(`/api/v1/workspaces/${id}`).set("Authorization", `Bearer ${b}`);
    expect(get.status).toBe(404);
    // Bob's listing should not include it.
    const list = await ctx.request().get("/api/v1/workspaces").set("Authorization", `Bearer ${b}`);
    expect(list.body.total).toBe(0);
  });

  it("admin can read another user's workspace", async () => {
    ctx = await setupTestApp();
    const user = await createUserAndLogin(ctx, "u1");
    const { id } = await createWorkspace(user, "u1-ws");
    const admin = await adminToken(ctx);
    const get = await ctx
      .request()
      .get(`/api/v1/workspaces/${id}`)
      .set("Authorization", `Bearer ${admin}`);
    expect(get.status).toBe(200);
    expect(get.body.name).toBe("u1-ws");
  });

  it("updates metadata (rename + description)", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "updater");
    const { id } = await createWorkspace(token, "old");
    const res = await ctx
      .request()
      .patch(`/api/v1/workspaces/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "new", description: "renamed" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("new");
    expect(res.body.description).toBe("renamed");
  });

  it("deletes a workspace and removes its files", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "deleter");
    const { id } = await createWorkspace(token, "to-delete");
    // Seed a file via the API.
    const upload = await ctx
      .request()
      .post(`/api/v1/workspaces/${id}/files?name=hello.txt`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("hi there"));
    expect(upload.status).toBe(201);

    const del = await ctx
      .request()
      .delete(`/api/v1/workspaces/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);
    const list = await ctx.request().get("/api/v1/workspaces").set("Authorization", `Bearer ${token}`);
    expect(list.body.total).toBe(0);
  });

  it("uploads, lists, downloads, and deletes files", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "filer");
    const { id } = await createWorkspace(token, "files");

    // Upload a file.
    const payload = Buffer.from("hello world\n");
    const up = await ctx
      .request()
      .post(`/api/v1/workspaces/${id}/files?name=note.txt`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(payload);
    expect(up.status).toBe(201);

    // Create a subdir + upload into it.
    const mk = await ctx
      .request()
      .post(`/api/v1/workspaces/${id}/dirs?path=sub`)
      .set("Authorization", `Bearer ${token}`);
    expect(mk.status).toBe(201);
    const up2 = await ctx
      .request()
      .post(`/api/v1/workspaces/${id}/files?path=sub&name=deep.txt`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("deep"));
    expect(up2.status).toBe(201);

    // List root: note.txt + sub/.
    const list = await ctx
      .request()
      .get(`/api/v1/workspaces/${id}/files`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const names = list.body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("note.txt");
    expect(names).toContain("sub");

    // Download and verify byte-for-byte.
    const dl = await ctx
      .request()
      .get(`/api/v1/workspaces/${id}/files/content?path=note.txt`)
      .set("Authorization", `Bearer ${token}`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body)).toEqual(payload);

    // Size/file_count refreshed on the row.
    const get = await ctx.request().get(`/api/v1/workspaces/${id}`).set("Authorization", `Bearer ${token}`);
    expect(get.body.file_count).toBeGreaterThanOrEqual(2);
    expect(get.body.size_bytes).toBeGreaterThan(0);

    // Delete the subdir.
    const rm = await ctx
      .request()
      .delete(`/api/v1/workspaces/${id}/files?path=sub`)
      .set("Authorization", `Bearer ${token}`);
    expect(rm.status).toBe(204);
  });

  it("blocks path traversal escape at the storage layer", async () => {
    ctx = await setupTestApp();
    // Use the storage module directly to assert the security boundary.
    const token = await createUserAndLogin(ctx, "pwn");
    const { id } = await createWorkspace(token, "escape");
    // The seeded admin is id 1; the created user is id 2.
    const userId = 2;

    // Traversal with `..` that escapes the workspace root is rejected.
    await expect(storage.listFiles(userId, id, "../../../etc")).rejects.toThrow(BadRequestError);
    await expect(storage.readFile(userId, id, "../../etc/passwd")).rejects.toThrow(BadRequestError);
    await expect(storage.deleteFile(userId, id, "../../etc")).rejects.toThrow(BadRequestError);

    // Leading-slash / absolute-looking paths are normalized to relative (treated
    // as inside the workspace root), so they resolve safely rather than escape.
    // A path that stays inside the workspace is fine:
    await storage.writeFile(userId, id, "abs/secret", Buffer.from("x"));
    const entries = await storage.listFiles(userId, id, "abs");
    expect(entries.map((e) => e.name)).toContain("secret");
  });

  it("rejects deleting the workspace root", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "rootguard");
    const { id } = await createWorkspace(token, "root");
    const res = await ctx
      .request()
      .delete(`/api/v1/workspaces/${id}/files?path=/`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("enforces workspace count quota", async () => {
    ctx = await setupTestApp();
    // The 'default' quota tier allows 10 workspaces. Use a fresh user.
    const token = await createUserAndLogin(ctx, "quotawarn");
    for (let i = 0; i < 10; i++) {
      await createWorkspace(token, `ws-${i}`);
    }
    const res = await ctx
      .request()
      .post("/api/v1/workspaces")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "over-limit" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("QUOTA_EXCEEDED");
  });

  it("seeds /workspace into a container created with workspaceId", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "seeder");
    const { id: wsId } = await createWorkspace(token, "init-source");
    // Put a marker file in the workspace.
    await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/files?name=marker.txt`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("seeded-content"))
      .expect(201);

    // Fetch a public image id.
    const images = await ctx.request().get("/api/v1/images").set("Authorization", `Bearer ${token}`);
    const imageId = images.body.images[0].id;

    // Create a container seeded from the workspace.
    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId, name: "seeded", workspaceId: wsId });
    expect(create.status).toBe(201);
    const containerId = create.body.id;

    // Use the bash tool to confirm the seeded workspace file is present inside
    // the container. On the MockExecutor the container root is the overlay
    // directory; the seed lands at <root>/workspace/marker.txt. We resolve it
    // via a relative path so the mock's resolveIn works on win32.
    const bash = await ctx
      .request()
      .post(`/api/v1/containers/${containerId}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "cat workspace/marker.txt" });
    expect(bash.status).toBe(200);
    expect(bash.body.stdout).toContain("seeded-content");
  });

  it("audits workspace mutations", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "audited");
    await createWorkspace(token, "audited-ws");

    const logs = await ctx
      .request()
      .get("/api/v1/logs?search=workspace")
      .set("Authorization", `Bearer ${token}`);
    expect(logs.status).toBe(200);
    // At least one workspace.create entry recorded.
    const wsActions = logs.body.logs.filter(
      (l: { action: string }) => typeof l.action === "string" && l.action.includes("workspace"),
    );
    expect(wsActions.length).toBeGreaterThan(0);
  });
});
