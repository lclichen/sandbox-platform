/**
 * P2-4/P2-5/P2-6 tests: audit integrity chain, aggregate disk quota,
 * and the backup --include-files tar helper.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";
import { createLogService } from "../src/services/log.service.ts";
import { tarFileDirs } from "../scripts/backup.ts";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
});

describe("audit integrity chain (P2-4)", () => {
  it("chains rows: each hash covers the previous row's hash", async () => {
    ctx = await setupTestApp();
    const logs = createLogService(ctx.db);
    await logs.record({ userId: 1, action: "test.first", resourceType: "test", detail: { a: 1 }, status: "success" });
    await logs.record({ userId: 1, action: "test.second", resourceType: "test", detail: { b: 2 }, status: "failure", errorMessage: "boom" });

    const rows = await ctx.db.all<{ action: string; prev_hash: string | null; hash: string | null; detail: unknown }>(
      "SELECT action, prev_hash, hash, detail FROM operation_logs ORDER BY id",
    );
    expect(rows.length).toBe(2);
    expect(rows[0].prev_hash).toBe(""); // genesis row
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1].prev_hash).toBe(rows[0].hash); // chained

    // Tamper detection: recompute row 1's hash from row 0's hash + payload.
    const canonical = JSON.stringify([
      1,
      "test.second",
      "test",
      null,
      { b: 2 },
      null,
      "failure",
      "boom",
    ]);
    const expected = createHash("sha256").update(`${rows[0].hash}${canonical}`).digest("hex");
    expect(rows[1].hash).toBe(expected);
  });
});

describe("aggregate disk quota (P2-5)", () => {
  it("blocks workspace uploads past the user's total disk ceiling", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "disk-user");
    // Shrink the user's quota tier to a tiny ceiling for the test.
    await ctx.db.run(
      "UPDATE resource_quotas SET max_disk_gb = 0 WHERE name = 'default'",
    );

    const ws = await ctx
      .request()
      .post("/api/v1/workspaces")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "disk-ws" });
    expect(ws.status).toBe(201);

    const upload = await ctx
      .request()
      .post(`/api/v1/workspaces/${ws.body.id}/files?path=&name=x.txt`)
      .set("Authorization", `Bearer ${token}`)
      .send(Buffer.from("hello"));
    expect(upload.status).toBe(422);
    expect(upload.body.code).toBe("quota_exceeded");
    expect(upload.body.message).toContain("Aggregate disk quota");
  });

  it("blocks snapshots past the user's total disk ceiling", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "snap-disk-user");
    // Create the container first (needs a sane per-container disk check),
    // THEN shrink the user's tier to a zero-byte aggregate ceiling.
    const create = await ctx
      .request()
      .post("/api/v1/containers")
      .set("Authorization", `Bearer ${token}`)
      .send({ imageId: 1, name: "disk-snap-box" });
    expect(create.status).toBe(201);
    const cid = create.body.id;
    await ctx.db.run(
      "UPDATE resource_quotas SET max_disk_gb = 0 WHERE name = 'default'",
    );

    const snap = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/snapshots`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "v1" });
    expect(snap.status).toBe(422);
    expect(snap.body.code).toBe("quota_exceeded");
  });
});

describe("backup file tar (P2-6)", () => {
  it("tars the file-storage directories into a companion archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "backup-files-"));
    try {
      // Relative paths + cwd: the MSYS tar on win32 mis-parses absolute
      // `C:\...` paths as remote hosts (see tarFileDirs doc).
      const overlay = "overlays";
      const workspace = "workspaces";
      await mkdir(join(dir, overlay, "mock-containers", "sb-x"), { recursive: true });
      await mkdir(join(dir, workspace, "user-1"), { recursive: true });
      await fsWriteFile(join(dir, overlay, "mock-containers", "sb-x", ".sandbox_root"), "marker");
      await fsWriteFile(join(dir, workspace, "user-1", "note.txt"), "hello workspace");

      const tarPath = "files.tar";
      await tarFileDirs(tarPath, [overlay, workspace], { cwd: dir });
      const st = await import("node:fs/promises").then((m) => m.stat(join(dir, tarPath)));
      expect(st.size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
