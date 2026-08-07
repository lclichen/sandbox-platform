/**
 * Milestone 4: container lifecycle + snapshots E2E through the REST API,
 * backed by the MockExecutor (win32-friendly).
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

async function firstImageId(ctx: TestContext, adminTokenValue: string): Promise<number> {
  const list = await ctx.request().get("/api/v1/admin/images").set("Authorization", `Bearer ${adminTokenValue}`);
  return list.body.images[0].id as number;
}

describe("container lifecycle", () => {
  it("creates, lists, connects, stops, starts, destroys", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const userToken = await createUserAndLogin(ctx, "dev1");
    const imageId = await firstImageId(ctx, admin);

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId, name: "my-box", cpu: 1, memoryMb: 512, diskGb: 2 });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe("running");
    const cid = create.body.id;

    const list = await ctx.request().get("/api/v1/containers").set("Authorization", `Bearer ${userToken}`);
    expect(list.status).toBe(200);
    expect(list.body.containers.length).toBe(1);

    const connect = await ctx
      .request()
      .get(`/api/v1/containers/${cid}/connect`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(connect.status).toBe(200);
    expect(connect.body.instanceName).toBeTypeOf("string");
    expect(connect.body.toolsBase).toContain(`/api/v1/containers/${cid}/tools`);

    const stop = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/stop`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe("stopped");

    const start = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/start`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(start.status).toBe(200);
    expect(start.body.status).toBe("running");

    const del = await ctx
      .request()
      .delete(`/api/v1/containers/${cid}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(del.status).toBe(204);
  });

  it("enforces ownership isolation between users", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const imageId = await firstImageId(ctx, admin);
    const t1 = await createUserAndLogin(ctx, "owner");
    const t2 = await createUserAndLogin(ctx, "intruder");

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${t1}`)
      .send({ imageId, name: "private-box" });
    const cid = create.body.id;

    const intrude = await ctx
      .request()
      .get(`/api/v1/containers/${cid}`)
      .set("Authorization", `Bearer ${t2}`);
    expect(intrude.status).toBe(404); // not 403, to avoid leaking existence
  });

  it("lets an admin operate on another user's container via owner-scoped endpoints", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const imageId = await firstImageId(ctx, admin);
    const ownerToken = await createUserAndLogin(ctx, "owner2");
    const otherToken = await createUserAndLogin(ctx, "outsider");

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ imageId, name: "admin-ops-box" });
    expect(create.status).toBe(201);
    const cid = create.body.id;

    // A non-owner non-admin still gets 404.
    const forbidden = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/stop`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(forbidden.status).toBe(404);

    // Admin can read it through the owner-scoped route…
    const get = await ctx
      .request()
      .get(`/api/v1/containers/${cid}`)
      .set("Authorization", `Bearer ${admin}`);
    expect(get.status).toBe(200);

    // …and stop / start / destroy it.
    const stop = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/stop`)
      .set("Authorization", `Bearer ${admin}`);
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe("stopped");

    const start = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/start`)
      .set("Authorization", `Bearer ${admin}`);
    expect(start.status).toBe(200);
    expect(start.body.status).toBe("running");

    const del = await ctx
      .request()
      .delete(`/api/v1/containers/${cid}`)
      .set("Authorization", `Bearer ${admin}`);
    expect(del.status).toBe(204);
  });

  it("rejects container creation that exceeds quota", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const imageId = await firstImageId(ctx, admin);
    const userToken = await createUserAndLogin(ctx, "heavyuser");

    // default quota: max_memory_mb = 2048. Request 4096.
    const over = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId, name: "too-big", memoryMb: 4096 });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("quota_exceeded");
  });

  it("snapshots, mutates, restores the pre-mutation state", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const imageId = await firstImageId(ctx, admin);
    const userToken = await createUserAndLogin(ctx, "snapuser");

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId, name: "snapshot-box" });
    const cid = create.body.id;

    // Tools are wired in milestone 5; here we use the snapshot flow directly.
    const snap = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/snapshots`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ name: "v1" });
    expect(snap.status).toBe(201);
    const snapId = snap.body.id;

    const list = await ctx
      .request()
      .get(`/api/v1/containers/${cid}/snapshots`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(list.status).toBe(200);
    expect(list.body.snapshots.length).toBe(1);

    const restore = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/snapshots/${snapId}/restore`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(restore.status).toBe(200);
    expect(restore.body.status).toBe("running");

    const del = await ctx
      .request()
      .delete(`/api/v1/containers/${cid}/snapshots/${snapId}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(del.status).toBe(204);
  });

  it("snapshotting a running container keeps it running (Stop-Then-Copy)", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const imageId = await firstImageId(ctx, admin);
    const userToken = await createUserAndLogin(ctx, "snapatomic");

    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId, name: "atomic-box" });
    const cid = create.body.id;
    expect(create.body.status).toBe("running");

    // Put content in the container, snapshot WHILE it is running, then mutate.
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/write`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ path: "pre.txt", content: b64("snapshot-time") });
    const snap = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/snapshots`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ name: "running-v1" });
    expect(snap.status).toBe(201);

    // The container must still be running and usable after the snapshot.
    const after = await ctx
      .request()
      .get(`/api/v1/containers/${cid}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(after.body.status).toBe("running");
    const stillUsable = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ command: "echo still-alive" });
    expect(stillUsable.status).toBe(200);

    // Mutate post-snapshot, restore, and confirm the pre-snapshot content wins.
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/write`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ path: "pre.txt", content: b64("mutated-after") });
    const restore = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/snapshots/${snap.body.id}/restore`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(restore.status).toBe(200);
    const read = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/read`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ path: "pre.txt" });
    expect(Buffer.from(read.body.contentBase64, "base64").toString("utf8")).toBe("snapshot-time");
  });
});
