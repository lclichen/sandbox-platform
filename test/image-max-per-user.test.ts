/**
 * Per-image per-user instance cap (images.max_per_user): project-template
 * style policies such as "one DocQA instance per student".
 *
 * Enforcement happens inside POST /containers regardless of the caller
 * (project provisioning, snapshot restore-to-new, manual create all funnel
 * through container.service.create).
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

describe("image max_per_user quota", () => {
  it("admin can set the cap via PATCH and it reaches GET", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const imageId = await firstImageId(ctx, admin);

    const patch = await ctx
      .request()
      .patch(`/api/v1/admin/images/${imageId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ max_per_user: 1 });
    expect(patch.status).toBe(200);
    expect(patch.body.max_per_user).toBe(1);

    const get = await ctx.request().get(`/api/v1/admin/images/${imageId}`).set("Authorization", `Bearer ${admin}`);
    expect(get.body.max_per_user).toBe(1);

    // clearing with null restores unlimited
    const clear = await ctx
      .request()
      .patch(`/api/v1/admin/images/${imageId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ max_per_user: null });
    expect(clear.status).toBe(200);
    expect(clear.body.max_per_user).toBeNull();
    // restore for the next test bodies that reuse this db? (each test gets a fresh app)
  });

  it("blocks a second create beyond the cap and frees the slot on destroy", async () => {
    ctx = await setupTestApp();
    const admin = await adminToken(ctx);
    const imageId = await firstImageId(ctx, admin);
    const userToken = await createUserAndLogin(ctx, "quota1");

    const setCap = await ctx
      .request()
      .patch(`/api/v1/admin/images/${imageId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ max_per_user: 1 });
    expect(setCap.status).toBe(200);

    const first = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId, name: "only-one" });
    expect(first.status).toBe(201);

    const second = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId, name: "greedy" });
    expect(second.status).toBe(422); // QuotaExceededError → 422 in the error mapper

    // a different user is unaffected by someone else's usage
    const otherToken = await createUserAndLogin(ctx, "quota2");
    const theirs = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ imageId, name: "theirs" });
    expect(theirs.status).toBe(201);

    // destroy frees the slot
    const destroy = await ctx
      .request()
      .delete(`/api/v1/containers/${first.body.id}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect([200, 202, 204]).toContain(destroy.status);

    const retry = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId, name: "second-life" });
    expect(retry.status).toBe(201);
  });
});

async function firstImageId(ctx: TestContext, adminTokenValue: string): Promise<number> {
  const list = await ctx.request().get("/api/v1/admin/images").set("Authorization", `Bearer ${adminTokenValue}`);
  return list.body.images[0].id as number;
}
