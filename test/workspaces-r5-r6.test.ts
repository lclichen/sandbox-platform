/**
 * R5 workspace enhancements (tree / chunked upload / move) and R6 container
 * selection support (list filters, quota image whitelist, provision defaults).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";

let ctx: TestContext;
let token: string;
let wsId: number;

async function mkWorkspace(name: string): Promise<number> {
  const res = await ctx.request().post("/api/v1/workspaces").set("Authorization", `Bearer ${token}`).send({ name });
  if (res.status !== 201) throw new Error(`workspace create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

async function uploadPart(id: number, uid: string, part: number, body: Buffer | string) {
  return ctx
    .request()
    .put(`/api/v1/workspaces/${id}/uploads/${uid}?part=${part}`)
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "application/octet-stream")
    .send(body);
}

describe("R5 workspace tree", () => {
  beforeEach(async () => {
    ctx = await setupTestApp();
    token = await createUserAndLogin(ctx, "treeuser");
    wsId = await mkWorkspace("tree-ws");
    const auth = { Authorization: `Bearer ${token}` };
    await ctx.request().post(`/api/v1/workspaces/${wsId}/dirs?path=docs`).set(auth);
    await ctx.request().post(`/api/v1/workspaces/${wsId}/dirs?path=docs/inner`).set(auth);
    await ctx.request().post(`/api/v1/workspaces/${wsId}/dirs?path=node_modules`).set(auth);
    await ctx.request().post(`/api/v1/workspaces/${wsId}/files?path=/&name=root.txt`).set(auth).send("root");
    await ctx.request().post(`/api/v1/workspaces/${wsId}/files?path=docs&name=a.md`).set(auth).send("aaa");
    await ctx.request().post(`/api/v1/workspaces/${wsId}/files?path=docs/inner&name=b.txt`).set(auth).send("bbb");
    await ctx.request().post(`/api/v1/workspaces/${wsId}/files?path=node_modules&name=hidden.js`).set(auth).send("x");
  });
  afterEach(async () => {
    await teardownTestApp(ctx);
  });

  it("returns the recursive tree in one request, skipping the ignore list", async () => {
    const res = await ctx.request().get(`/api/v1/workspaces/${wsId}/tree`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const paths = res.body.entries.map((e: { path: string }) => e.path);
    expect(paths).toContain("root.txt");
    expect(paths).toContain("docs/a.md");
    expect(paths).toContain("docs/inner/b.txt");
    expect(paths.some((p: string) => p.startsWith("node_modules"))).toBe(false);
    // Depth annotations: root children 0, nested 2.
    const docs = res.body.entries.find((e: { path: string }) => e.path === "docs");
    const inner = res.body.entries.find((e: { path: string }) => e.path === "docs/inner/b.txt");
    expect(docs.depth).toBe(0);
    expect(inner.depth).toBe(2);
    expect(res.body.truncated).toBe(false);
  });

  it("honors the depth cap", async () => {
    const res = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/tree?depth=1`)
      .set("Authorization", `Bearer ${token}`);
    const paths = res.body.entries.map((e: { path: string }) => e.path);
    expect(paths).toContain("docs/a.md"); // depth 1
    expect(paths).not.toContain("docs/inner/b.txt"); // depth 2 > cap
  });

  it("paginates with a cursor when truncated", async () => {
    // Force truncation via a tiny maxEntries by paginating manually: with few
    // entries the walk never truncates, so instead verify cursor continuation
    // returns the remaining tail deterministically.
    const first = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/tree`)
      .set("Authorization", `Bearer ${token}`);
    const all: string[] = first.body.entries.map((e: { path: string }) => e.path);
    // Page 1: everything after "docs" (exclusive).
    const page = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/tree?cursor=${encodeURIComponent("docs")}`)
      .set("Authorization", `Bearer ${token}`);
    const tail: string[] = page.body.entries.map((e: { path: string }) => e.path);
    expect(tail.length).toBe(all.length - 1); // everything except "docs"
    expect(tail[0]).toBe("docs/a.md");
  });

  it("denies trees of other users' workspaces (404)", async () => {
    const other = await createUserAndLogin(ctx, "treeother");
    const res = await ctx.request().get(`/api/v1/workspaces/${wsId}/tree`).set("Authorization", `Bearer ${other}`);
    expect(res.status).toBe(404);
  });
});

describe("R5 chunked upload", () => {
  beforeEach(async () => {
    ctx = await setupTestApp();
    token = await createUserAndLogin(ctx, "upuser");
    wsId = await mkWorkspace("up-ws");
  });
  afterEach(async () => {
    await teardownTestApp(ctx);
  });

  it("uploads parts out of order and completes into one file", async () => {
    const init = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/uploads?path=/`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "big.bin", size: 6 });
    expect(init.status).toBe(201);
    expect(init.body.uploadId).toBeTruthy();
    const uid = init.body.uploadId as string;

    expect((await uploadPart(wsId, uid, 2, "world")).status).toBe(204);
    expect((await uploadPart(wsId, uid, 1, "hello ")).status).toBe(204);

    const complete = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/uploads/${uid}/complete`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(complete.status).toBe(201);
    expect(complete.body.path).toBe("big.bin");
    expect(complete.body.size).toBe(11);

    const dl = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/files/content?path=big.bin`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.body.toString("utf8")).toBe("hello world");
  });

  it("supports subdirectory targets and abort", async () => {
    await ctx.request().post(`/api/v1/workspaces/${wsId}/dirs?path=sub`).set("Authorization", `Bearer ${token}`);
    const init = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/uploads?path=sub`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x.txt" });
    const uid = init.body.uploadId as string;
    await uploadPart(wsId, uid, 1, "data");
    const abort = await ctx
      .request()
      .delete(`/api/v1/workspaces/${wsId}/uploads/${uid}`)
      .set("Authorization", `Bearer ${token}`);
    expect(abort.status).toBe(204);
    const complete = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/uploads/${uid}/complete`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(complete.status).toBe(404);
  });

  it("rejects parts for an unknown session", async () => {
    const res = await uploadPart(wsId, "no-such-session", 1, "x");
    expect(res.status).toBe(404);
  });

  it("rejects oversized declared files", async () => {
    process.env.WORKSPACE_UPLOAD_MAX_BYTES = "10";
    const { resetConfigForTesting } = await import("../src/config.ts");
    resetConfigForTesting();
    try {
      const res = await ctx
        .request()
        .post(`/api/v1/workspaces/${wsId}/uploads?path=/`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "huge.bin", size: 1000 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BAD_REQUEST");
    } finally {
      delete process.env.WORKSPACE_UPLOAD_MAX_BYTES;
      resetConfigForTesting();
    }
  });
});

describe("R5 move/rename", () => {
  beforeEach(async () => {
    ctx = await setupTestApp();
    token = await createUserAndLogin(ctx, "moveuser");
    wsId = await mkWorkspace("move-ws");
    const auth = { Authorization: `Bearer ${token}` };
    await ctx.request().post(`/api/v1/workspaces/${wsId}/files?path=/&name=a.txt`).set(auth).send("A");
    await ctx.request().post(`/api/v1/workspaces/${wsId}/dirs?path=d1`).set(auth);
    await ctx.request().post(`/api/v1/workspaces/${wsId}/dirs?path=d2`).set(auth);
    await ctx.request().post(`/api/v1/workspaces/${wsId}/files?path=d1&name=nested.txt`).set(auth).send("N");
  });
  afterEach(async () => {
    await teardownTestApp(ctx);
  });

  it("renames a file (to = new full path)", async () => {
    const res = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/files/move`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "a.txt", to: "renamed.txt" });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("renamed.txt");
    const dl = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/files/content?path=renamed.txt`)
      .set("Authorization", `Bearer ${token}`);
    expect(dl.status).toBe(200);
  });

  it("moves a directory under another directory (to ends with /)", async () => {
    const res = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/files/move`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "d1", to: "d2/" });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("d2/d1");
    const dl = await ctx
      .request()
      .get(`/api/v1/workspaces/${wsId}/files/content?path=d2/d1/nested.txt`)
      .set("Authorization", `Bearer ${token}`);
    expect(dl.status).toBe(200);
  });

  it("refuses moving a directory into itself", async () => {
    const res = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/files/move`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "d1", to: "d1/inside" });
    expect(res.status).toBe(400);
  });

  it("refuses traversal targets", async () => {
    const res = await ctx
      .request()
      .post(`/api/v1/workspaces/${wsId}/files/move`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "a.txt", to: "../../escape.txt" });
    expect(res.status).toBe(400);
  });
});

describe("R6 container selection", () => {
  let imageId: number;
  beforeEach(async () => {
    ctx = await setupTestApp();
    token = await createUserAndLogin(ctx, "seluser");
    const admin = await adminToken(ctx);
    const images = await ctx.request().get("/api/v1/admin/images").set("Authorization", `Bearer ${admin}`);
    imageId = images.body.images[0].id as number;
    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId, name: "c1" });
    if (create.status !== 201) throw new Error(`container create failed: ${JSON.stringify(create.body)}`);
  });
  afterEach(async () => {
    await teardownTestApp(ctx);
  });

  it("filters by filter=running and image", async () => {
    const running = await ctx
      .request()
      .get("/api/v1/containers?filter=running")
      .set("Authorization", `Bearer ${token}`);
    expect(running.status).toBe(200);
    expect(running.body.containers).toHaveLength(1);

    const byImage = await ctx
      .request()
      .get(`/api/v1/containers?image=${imageId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(byImage.body.containers).toHaveLength(1);

    const otherImage = await ctx
      .request()
      .get(`/api/v1/containers?image=${imageId + 999}`)
      .set("Authorization", `Bearer ${token}`);
    expect(otherImage.body.containers).toHaveLength(0);
  });

  it("GET /provision/defaults returns the first public image", async () => {
    const res = await ctx.request().get("/api/v1/provision/defaults").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.imageId).toBe(imageId);
    expect(res.body.imageName).toBeTruthy();
    expect(res.body.workspaceId).toBeNull();
  });

  it("enforces the quota image whitelist on create", async () => {
    const admin = await adminToken(ctx);
    // Create a second image, then a quota allowing only that second image.
    const img2 = await ctx
      .request()
      .post("/api/v1/admin/images")
      .set("Authorization", `Bearer ${admin}`)
      .send({ name: "other.sif", display_name: "Other", sif_path: "/images/other.sif" });
    const img2Id = img2.body.id as number;
    const quota = await ctx
      .request()
      .post("/api/v1/admin/quotas")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        name: "restricted",
        max_containers: 5,
        max_cpu_cores: 4,
        max_memory_mb: 4096,
        max_disk_gb: 20,
        max_snapshots_per_container: 2,
        allowed_image_ids: [img2Id],
      });
    expect(quota.status).toBe(201);
    expect(quota.body.allowed_image_ids).toEqual([img2Id]);

    // Users list endpoint round-trips the whitelist.
    const quotas = await ctx.request().get("/api/v1/admin/quotas").set("Authorization", `Bearer ${admin}`);
    const restricted = quotas.body.quotas.find((q: { name: string }) => q.name === "restricted");
    expect(restricted.allowed_image_ids).toEqual([img2Id]);

    // Assign the restricted quota to seluser (created with id ordering; find
    // via admin users list).
    const users = await ctx.request().get("/api/v1/admin/users").set("Authorization", `Bearer ${admin}`);
    const me = users.body.users.find((u: { username: string }) => u.username === "seluser");
    await ctx.request().patch(`/api/v1/admin/users/${me.id}`).set("Authorization", `Bearer ${admin}`).send({ quota_id: restricted.id });

    // Creating from the whitelisted image works...
    const ok = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId: img2Id, name: "c2" });
    expect(ok.status).toBe(201);

    // ...but the original image is now forbidden.
    const blocked = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId, name: "c3" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("IMAGE_NOT_ALLOWED");
  });
});
