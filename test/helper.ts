/**
 * Test helpers: spin up an isolated in-memory sqlite database, run migrations,
 * and return a supertest agent bound to the Express app.
 */
import { createApp } from "../src/app.ts";
import { createDatabase, closeDatabase, type Database } from "../src/db/driver.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { MockExecutor } from "../src/executors/mock-executor.ts";
import { setExecutorForTesting, resetExecutorForTesting } from "../src/executors/factory.ts";
import { resetConfigForTesting } from "../src/config.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import supertestDefault, { type Agent } from "supertest";

// supertest ships a CJS module; the default export is the request factory.
const request = supertestDefault as unknown as (app: Express) => Agent;

let testDbCounter = 0;

export interface TestContext {
  app: Express;
  db: Database;
  request: () => Agent;
  /** Temp dir backing the MockExecutor + (for cleanup) the db file. */
  tmpDir: string;
  /** Default admin credentials seeded by migrations. */
  admin: { username: string; password: string };
  /** Restore WORKSPACE_BASE_DIR after teardown (set by setupTestApp). */
  restoreWsBase: () => void;
}

export async function setupTestApp(): Promise<TestContext> {
  testDbCounter += 1;
  const tmpDir = await mkdtemp(join(tmpdir(), `sandbox-test-${process.pid}-${testDbCounter}-`));
  const dbPath = join(tmpDir, "test.db");

  // Reset any cached singleton database/executor so the new instances take effect.
  await closeDatabase();
  resetExecutorForTesting();

  // Point workspace storage at the temp dir so file operations never touch
  // ./data/workspaces (stale files there leak between runs and break
  // content-sensitive assertions like the R5 tree tests).
  const prevWsBase = process.env.WORKSPACE_BASE_DIR;
  process.env.WORKSPACE_BASE_DIR = join(tmpDir, "ws");
  resetConfigForTesting();

  const db = await createDatabase({ sqlitePath: dbPath });
  await runMigrations(db);

  // Inject a MockExecutor rooted in the temp dir so tests run fully isolated
  // and never touch a real container runtime.
  const executor = new MockExecutor(join(tmpDir, "mock-exec"));
  await executor.isAvailable();
  setExecutorForTesting(executor);

  const { app } = await createApp({ db, executor });
  return {
    app,
    db,
    tmpDir,
    request: () => request(app),
    admin: { username: "admin", password: "changeme123" },
    restoreWsBase: () => {
      if (prevWsBase === undefined) delete process.env.WORKSPACE_BASE_DIR;
      else process.env.WORKSPACE_BASE_DIR = prevWsBase;
      resetConfigForTesting();
    },
  };
}

export async function teardownTestApp(ctx: TestContext): Promise<void> {
  await ctx.db.close();
  await closeDatabase();
  resetExecutorForTesting();
  ctx.restoreWsBase();
  await rm(ctx.tmpDir, { recursive: true, force: true });
}

/** Login as admin and return the access token. */
export async function adminToken(ctx: TestContext): Promise<string> {
  const res = await ctx
    .request()
    .post("/api/v1/auth/login")
    .send({ username: ctx.admin.username, password: ctx.admin.password });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

/** Create a regular user via admin, return its access token. */
export async function createUserAndLogin(
  ctx: TestContext,
  username: string,
  password = "password1",
): Promise<string> {
  const admin = await adminToken(ctx);
  const create = await ctx
    .request()
    .post("/api/v1/admin/users")
    .set("Authorization", `Bearer ${admin}`)
    .send({ username, password });
  if (create.status !== 201) throw new Error(`user create failed: ${create.status} ${JSON.stringify(create.body)}`);
  const login = await ctx.request().post("/api/v1/auth/login").send({ username, password });
  if (login.status !== 200) throw new Error(`user login failed: ${login.status}`);
  return login.body.accessToken as string;
}
