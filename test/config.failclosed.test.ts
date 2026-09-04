/**
 * Fail-closed startup & isolation guarantees (fix plan C1/C2):
 *  - a known-weak JWT_SECRET placeholder is refused in EVERY environment;
 *  - unset JWT_SECRET yields a generated ephemeral secret (never a known one);
 *  - EXECUTOR_KIND defaults to "auto" and the factory HARD-FAILS when no real
 *    executor is available (no silent MockExecutor degradation);
 *  - mock "container" shells never see the platform process env (JWT_SECRET,
 *    SSH_PASSWORD, ... would otherwise be one `env` away);
 *  - seeding the admin with the well-known default password puts the account
 *    behind the R9 must-change-password gate.
 */
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, resetConfigForTesting } from "../src/config.ts";
import { getExecutor, resetExecutorForTesting } from "../src/executors/factory.ts";
import { MockExecutor } from "../src/executors/mock-executor.ts";
import { createDatabase, closeDatabase, type Database } from "../src/db/driver.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertestDefault from "supertest";
import { createApp } from "../src/app.ts";
import type { Express } from "express";

const request = supertestDefault as unknown as (app: Express) => ReturnType<typeof supertestDefault>;

const SAVED_ENV = [
  "JWT_SECRET",
  "NODE_ENV",
  "EXECUTOR_KIND",
  "SSH_HOST",
  "SEED_ADMIN_PASSWORD",
  "APPTAINER_BIN",
];

const saved: Record<string, string | undefined> = {};
for (const key of SAVED_ENV) saved[key] = process.env[key];

function restoreEnv(): void {
  for (const key of SAVED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetConfigForTesting();
}

afterEach(() => {
  restoreEnv();
  resetExecutorForTesting();
});

describe("fail-closed configuration", () => {
  it("refuses a known-weak JWT_SECRET placeholder even outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = "dev-insecure-secret-change-me";
    resetConfigForTesting();
    expect(() => loadConfig()).toThrow(/JWT_SECRET/);

    process.env.JWT_SECRET = "change-me-in-production-please-use-a-long-random-string";
    resetConfigForTesting();
    expect(() => loadConfig()).toThrow(/JWT_SECRET/);
  });

  it("generates a random ephemeral secret when JWT_SECRET is unset", () => {
    delete process.env.JWT_SECRET;
    resetConfigForTesting();
    const config = loadConfig();
    expect(config.auth.jwtSecretEphemeral).toBe(true);
    expect(config.auth.jwtSecret).toMatch(/^[0-9a-f]{64}$/);

    resetConfigForTesting();
    const second = loadConfig();
    expect(second.auth.jwtSecret).not.toBe(config.auth.jwtSecret);
  });

  it("executor kind defaults to auto and the factory hard-fails without a real executor", async () => {
    delete process.env.JWT_SECRET;
    delete process.env.EXECUTOR_KIND;
    delete process.env.SSH_HOST;
    process.env.NODE_ENV = "development";
    process.env.APPTAINER_BIN = "apptainer-binary-that-does-not-exist";
    resetConfigForTesting();

    const config = loadConfig();
    expect(config.executor.kind).toBe("auto");
    // No SSH host, no apptainer binary: must throw — NOT silently become mock.
    await expect(getExecutor()).rejects.toThrow(/EXECUTOR_KIND|没有可用的沙盒执行器/);
  });

  it("mock shells never inherit platform secrets from process.env", async () => {
    process.env.JWT_SECRET = "top-secret-for-this-test";
    process.env.SSH_PASSWORD = "ssh-secret-for-this-test";
    resetConfigForTesting();

    const tmp = await mkdtemp(join(tmpdir(), "mock-env-test-"));
    try {
      const executor = new MockExecutor(join(tmp, "exec"));
      await executor.isAvailable();
      const handle = await executor.create({
        id: "sb-envtest",
        imageRef: { sifPath: join(tmp, "img.sif") },
        overlayPath: join(tmp, "ovl"),
        env: { CONTAINER_VAR: "visible" },
      });
      const result = await executor.exec(handle, "echo JWT=$JWT_SECRET SSH=$SSH_PASSWORD CONTAINER=$CONTAINER_VAR PATH_SET=${PATH:+yes}");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("JWT=");
      expect(result.stdout).not.toContain("top-secret-for-this-test");
      expect(result.stdout).toContain("SSH=");
      expect(result.stdout).not.toContain("ssh-secret-for-this-test");
      expect(result.stdout).toContain("CONTAINER=visible");
      expect(result.stdout).toContain("PATH_SET=yes");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("seeding admin with the well-known default password forces a password change", async () => {
    await closeDatabase();
    const tmp = await mkdtemp(join(tmpdir(), "seed-admin-test-"));
    let db: Database | undefined;
    try {
      delete process.env.SEED_ADMIN_PASSWORD; // → migration seeds with changeme123
      delete process.env.JWT_SECRET;
      resetConfigForTesting();
      db = await createDatabase({ sqlitePath: join(tmp, "t.db") });
      await runMigrations(db);
      const executor = new MockExecutor(join(tmp, "exec"));
      const { app } = await createApp({ db, executor });
      const res = await request(app).post("/api/v1/auth/login").send({ username: "admin", password: "changeme123" });
      // Login itself succeeds (tokens carry a mustChangePassword claim); every
      // other endpoint is gated by requireAuth until change-password completes.
      expect(res.status).toBe(200);
      expect(res.body?.accessToken).toBeTruthy();
      const gated = await request(app)
        .get("/api/v1/containers")
        .set("Authorization", `Bearer ${res.body.accessToken}`);
      expect(gated.status).toBe(403);
      expect(gated.body?.code).toBe("PASSWORD_CHANGE_REQUIRED");
    } finally {
      await db?.close();
      await closeDatabase();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
