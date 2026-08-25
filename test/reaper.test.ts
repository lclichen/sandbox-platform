/**
 * Reaper tests: idle-container auto-release (manual §5.1).
 *
 * Drives `createReaper(db, executor).tick()` directly against the test app's
 * MockExecutor. Idle time is simulated by backdating last_started_at in the
 * DB; the sweep interval wrapper is not exercised (tick is the unit under test).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, createUserAndLogin, type TestContext } from "./helper.ts";
import { createReaper } from "../src/scheduler/reaper.ts";
import { resetConfigForTesting } from "../src/config.ts";
import { getExecutor } from "../src/executors/index.ts";
import type { SandboxExecutor } from "../src/executors/types.ts";

describe("reaper", () => {
  let ctx: TestContext;
  let executor: SandboxExecutor;

  beforeEach(async () => {
    ctx = await setupTestApp();
    // setupTestApp injects a temp-dir MockExecutor via setExecutorForTesting;
    // the factory returns that singleton.
    executor = await getExecutor();
  });

  afterEach(async () => {
    await teardownTestApp(ctx);
    resetConfigForTesting();
  });

  async function createContainerForUser(userToken: string): Promise<number> {
    const res = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ imageId: 1, name: `reaper-${Date.now()}` });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  /** Backdate last_started_at so the container looks idle for `hours` (sqlite). */
  async function backdateContainer(id: number, hours: number): Promise<void> {
    await ctx.db.run(
      `UPDATE containers SET last_started_at = datetime('now', '-' || ? || ' hours') WHERE id = ?`,
      hours,
      id,
    );
  }

  it("releases idle running containers: snapshot + stop + auto_stopped marker", async () => {
    process.env.IDLE_AUTO_STOP_HOURS = "1";
    process.env.IDLE_AUTO_STOP_SNAPSHOT = "true";
    resetConfigForTesting();

    const userToken = await createUserAndLogin(ctx, "reaper-user");
    const id = await createContainerForUser(userToken);
    await backdateContainer(id, 200); // way past the 1h threshold

    const reaper = createReaper(ctx.db, executor);
    const summary = await reaper.tick();

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    const reclaimed = summary.reclaimed.find((r) => r.containerId === id);
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.snapshotId).not.toBeNull();

    const row = await ctx.db.get<{ status: string; auto_stopped: number }>(
      "SELECT status, auto_stopped FROM containers WHERE id = ?",
      id,
    );
    expect(row!.status).toBe("stopped");
    expect(Number(row!.auto_stopped)).toBe(1);

    const snap = await ctx.db.get<{ name: string; size_bytes: number }>(
      "SELECT name, size_bytes FROM snapshots WHERE container_id = ? ORDER BY id DESC LIMIT 1",
      id,
    );
    expect(snap!.name).toMatch(/^auto-/);
    expect(snap!.size_bytes).toBeGreaterThan(0);
  });

  it("does not touch recently-active containers", async () => {
    process.env.IDLE_AUTO_STOP_HOURS = "168";
    resetConfigForTesting();

    const userToken = await createUserAndLogin(ctx, "reaper-active");
    const id = await createContainerForUser(userToken);
    // Container started just now -> far below the 168h threshold.

    const reaper = createReaper(ctx.db, executor);
    const summary = await reaper.tick();

    expect(summary.reclaimed.find((r) => r.containerId === id)).toBeUndefined();
    const row = await ctx.db.get<{ status: string }>("SELECT status FROM containers WHERE id = ?", id);
    expect(row!.status).toBe("running");
  });

  it("start() resumes an auto-stopped container from its auto snapshot", async () => {
    process.env.IDLE_AUTO_STOP_HOURS = "1";
    process.env.IDLE_AUTO_STOP_SNAPSHOT = "true";
    resetConfigForTesting();

    const userToken = await createUserAndLogin(ctx, "reaper-resume");
    const id = await createContainerForUser(userToken);
    // Put a marker file in the container so we can tell restore happened.
    await ctx
      .request()
      .post(`/api/v1/containers/${id}/tools/write`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ path: "before-stop.txt", content: Buffer.from("release-state", "utf8").toString("base64") });

    await backdateContainer(id, 200);
    await createReaper(ctx.db, executor).tick();

    // Now the user reconnects: POST /start must restore + clear the marker.
    const start = await ctx
      .request()
      .post(`/api/v1/containers/${id}/start`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(start.status).toBe(200);
    expect(start.body.status).toBe("running");

    const row = await ctx.db.get<{ auto_stopped: number }>(
      "SELECT auto_stopped FROM containers WHERE id = ?",
      id,
    );
    expect(Number(row!.auto_stopped)).toBe(0);

    // The restored container serves the pre-stop file again.
    const read = await ctx
      .request()
      .post(`/api/v1/containers/${id}/tools/read`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ path: "before-stop.txt" });
    expect(read.status).toBe(200);
    expect(Buffer.from(read.body.contentBase64 as string, "base64").toString("utf8")).toBe("release-state");
  });

  it("releases containers even when the auto snapshot fails (quota edge)", async () => {
    process.env.IDLE_AUTO_STOP_HOURS = "1";
    process.env.IDLE_AUTO_STOP_SNAPSHOT = "true";
    resetConfigForTesting();

    const userToken = await createUserAndLogin(ctx, "reaper-nosnap");
    const id = await createContainerForUser(userToken);
    // Drain the snapshot quota (default tier: 5 per container) so the auto
    // snapshot is rejected, then verify the container is still released.
    for (let i = 0; i < 5; i++) {
      const res = await ctx
        .request()
        .post(`/api/v1/containers/${id}/snapshots`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ name: `manual-${i}` });
      expect(res.status).toBe(201);
    }
    await backdateContainer(id, 200);

    const summary = await createReaper(ctx.db, executor).tick();
    const reclaimed = summary.reclaimed.find((r) => r.containerId === id);
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.snapshotId).toBeNull();

    const row = await ctx.db.get<{ status: string }>("SELECT status FROM containers WHERE id = ?", id);
    expect(row!.status).toBe("stopped");
  });

  it("soft-purges audit logs older than AUDIT_RETENTION_DAYS (keeps the row for chain integrity)", async () => {
    process.env.AUDIT_RETENTION_DAYS = "1";
    resetConfigForTesting();

    // Create an old log row directly (sqlite format, UTC).
    await ctx.db.run(
      `INSERT INTO operation_logs (user_id, action, resource_type, detail, status, created_at)
       VALUES (NULL, 'test.old', 'test', NULL, 'success', datetime('now', '-10 days'))`,
    );
    const summary = await createReaper(ctx.db, executor).tick();
    expect(summary.purgedAuditRows).toBe(1);

    // Soft-purge: the row is still present (chain stays reconstructable) but
    // marked purged_at, so the admin log query hides it.
    const stillThere = await ctx.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM operation_logs");
    expect(Number(stillThere!.c)).toBe(1);
    const purged = await ctx.db.get<{ purged_at: string | null }>(
      "SELECT purged_at FROM operation_logs WHERE action = 'test.old'",
    );
    expect(purged!.purged_at).not.toBeNull();
  });
});
