/**
 * 输入/输出挂载（docs/沙盒输入输出挂载设计.md）E2E：创建带挂载的容器、
 * 暂存目录物化、运行中追加/移除输入、start() 重放 binds、输出目录落位，
 * 以及 workspace 的符号链接逃逸防护（本设计的硬前置）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
});

async function firstImageId(c: TestContext, admin: string): Promise<number> {
  const list = await c.request().get("/api/v1/admin/images").set("Authorization", `Bearer ${admin}`);
  return list.body.images[0].id as number;
}

/** Create a workspace with one file + one subdir, return { id, token }. */
async function seedWorkspace(c: TestContext, token: string, name: string): Promise<number> {
  const create = await c.request().post("/api/v1/workspaces").set("Authorization", `Bearer ${token}`).send({ name });
  expect(create.status).toBe(201);
  const wsId = create.body.id as number;
  const up = await c
    .request()
    .post(`/api/v1/workspaces/${wsId}/files?path=&name=notes.md`)
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "application/octet-stream")
    .send(Buffer.from("# notes\n"));
  expect(up.status).toBe(201);
  const mkd = await c.request().post(`/api/v1/workspaces/${wsId}/dirs?path=data`).set("Authorization", `Bearer ${token}`);
  expect(mkd.status).toBe(201);
  return wsId;
}

describe("container input/output mounts", () => {
  it("creates a container with inputs + output and materializes the staging dir", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const token = await createUserAndLogin(ctx, "mount1");
    const imageId = await firstImageId(ctx, admin);
    const wsId = await seedWorkspace(ctx, token, "ws-a");

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        imageId,
        name: "mounted box",
        mounts: { inputs: [{ workspaceId: wsId, path: "notes.md" }, { workspaceId: wsId, path: "data" }], output: { workspaceId: wsId } },
      });
    expect(create.status).toBe(201);
    const cid = create.body.id;
    const instance = create.body.instance_name as string;

    // GET /:id carries the mounts inventory.
    const get = await ctx.request().get(`/api/v1/containers/${cid}`).set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    const kinds = get.body.mounts.map((m: { kind: string }) => m.kind).sort();
    expect(kinds).toEqual(["input", "input", "output"]);
    const output = get.body.mounts.find((m: { kind: string }) => m.kind === "output");
    expect(output.rel_path).toBe("outputs/mounted_box");

    // Staging dir has both items; the output dir exists under the workspace.
    const wsRoot = join(ctx.tmpDir, "ws", `user-${get.body.user_id}`, `ws-${wsId}`);
    const staging = join(ctx.tmpDir, "container-inputs", instance);
    expect(existsSync(join(staging, "notes.md"))).toBe(true);
    expect(existsSync(join(staging, "data"))).toBe(true);
    expect(existsSync(join(wsRoot, "outputs", "mounted_box"))).toBe(true);

    // The workspace now shows the outputs dir in listings.
    const ls = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/files?path=`)
      .set("Authorization", `Bearer ${token}`);
    expect(ls.status).toBe(200);
    expect(ls.body.entries.some((e: { name: string }) => e.name === "outputs")).toBe(true);
  });

  it("adds and removes an input on a RUNNING container (no restart)", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const token = await createUserAndLogin(ctx, "mount2");
    const imageId = await firstImageId(ctx, admin);
    const wsId = await seedWorkspace(ctx, token, "ws-b");
    // Extra file to mount later.
    const up = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/files?path=&name=extra.txt`)
      .set("Authorization", `Bearer ${token}`)
      .send(Buffer.from("live"));
    expect(up.status).toBe(201);

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId, name: "livebox", mounts: { inputs: [{ workspaceId: wsId, path: "notes.md" }] } });
    expect(create.status).toBe(201);
    const cid = create.body.id;
    const instance = create.body.instance_name as string;
    const staging = join(ctx.tmpDir, "container-inputs", instance);

    const add = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/inputs`)
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceId: wsId, path: "extra.txt" });
    expect(add.status).toBe(201);
    expect(existsSync(join(staging, "extra.txt"))).toBe(true);
    expect(readFileSync(join(staging, "extra.txt"), "utf8")).toBe("live");

    // Remove the first mount again.
    const get = await ctx.request().get(`/api/v1/containers/${cid}`).set("Authorization", `Bearer ${token}`);
    const first = get.body.mounts.find((m: { name: string }) => m.name === "notes.md");
    const del = await ctx
      .request()
      .delete(`/api/v1/containers/${cid}/inputs/${first.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);
    expect(existsSync(join(staging, "notes.md"))).toBe(false);
    expect(existsSync(join(staging, "extra.txt"))).toBe(true);
  });

  it("replays mounts on stop/start (the restart-drops-bind fix)", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const token = await createUserAndLogin(ctx, "mount3");
    const imageId = await firstImageId(ctx, admin);
    const wsId = await seedWorkspace(ctx, token, "ws-c");

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId, name: "rebox", mounts: { inputs: [{ workspaceId: wsId, path: "notes.md" }], output: { workspaceId: wsId } } });
    const cid = create.body.id;

    const stop = await ctx.request().post(`/api/v1/containers/${cid}/stop`).set("Authorization", `Bearer ${token}`);
    expect(stop.status).toBe(200);
    const start = await ctx.request().post(`/api/v1/containers/${cid}/start`).set("Authorization", `Bearer ${token}`);
    expect(start.status).toBe(200);
    expect(start.body.status).toBe("running");

    // After the restart the mounts inventory is intact and the binds were
    // re-derived (mock executor re-created the in-container links).
    const get = await ctx.request().get(`/api/v1/containers/${cid}`).set("Authorization", `Bearer ${token}`);
    expect(get.body.mounts.length).toBe(2);
  });

  it("rejects symlink inputs, traversal paths and foreign workspaces", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const token = await createUserAndLogin(ctx, "mount4");
    const other = await createUserAndLogin(ctx, "mount4b");
    const imageId = await firstImageId(ctx, admin);
    const wsId = await seedWorkspace(ctx, token, "ws-d");
    const otherWs = await seedWorkspace(ctx, other, "ws-other");

    // Foreign workspace → 404 (ownership via requireOwned).
    const foreign = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId, name: "x1", mounts: { inputs: [{ workspaceId: otherWs, path: "notes.md" }] } });
    expect(foreign.status).toBe(404);

    // Traversal path → 400 (storage containment).
    const traversal = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId, name: "x2", mounts: { inputs: [{ workspaceId: wsId, path: "../../etc" }] } });
    expect(traversal.status).toBe(400);

    // Symlink top-level item → 400 with the explicit message.
    const wsRoot = join(ctx.tmpDir, "ws", `user-${(await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`)).body.user.id}`, `ws-${wsId}`);
    mkdirSync(join(ctx.tmpDir, "outside"), { recursive: true });
    writeFileSync(join(ctx.tmpDir, "outside", "secret.txt"), "host-secret");
    symlinkSync(join(ctx.tmpDir, "outside"), join(wsRoot, "evil-link"), "junction");
    const evil = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId, name: "x3", mounts: { inputs: [{ workspaceId: wsId, path: "evil-link" }] } });
    expect(evil.status).toBe(400);
    expect(String(evil.body.message)).toContain("符号链接");
  });

  it("workspace API refuses to serve/delete through an escape symlink (hardening)", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "mount5");
    const wsId = await seedWorkspace(ctx, token, "ws-e");
    const me = await ctx.request().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    const wsRoot = join(ctx.tmpDir, "ws", `user-${me.body.user.id}`, `ws-${wsId}`);

    // Plant a symlink INSIDE the workspace pointing at a host file outside —
    // exactly what a container could do through its RW /output bind.
    const outside = mkdtempSync(join(tmpdir(), "escape-"));
    writeFileSync(join(outside, "secret.txt"), "host-secret");
    // Windows file-symlinks need admin rights; a directory JUNCTION exercises
    // the same realpath-escape path without privileges.
    symlinkSync(outside, join(wsRoot, "leak-dir"), "junction");

    const read = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/files/content?path=leak-dir/secret.txt`)
      .set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(400);

    const del = await ctx
      .request()
      .delete(`/api/v1/workspaces/${wsId}/files?path=leak-dir`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(400);

    // Normal files still work.
    const ok = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/files/content?path=notes.md`)
      .set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
  });
});
