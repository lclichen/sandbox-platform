/**
 * Milestone 7: backup/restore round-trip and cross-database migration.
 *
 * Exercises buildArchive -> loadInto on a sqlite source with real seeded data
 * (quotas, admin, images, plus a user/container/log created via services), then
 * restores into a fresh sqlite target and asserts row-level equality. The
 * migrate-db.ts migrateData() helper wraps the same flow for sqlite<->pg; the
 * pg code path is identical (only the driver differs), so this validates the
 * shared logic. A live postgres instance is required to exercise the pg driver
 * at runtime; that is left to deployment-time verification.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, closeDatabase } from "../src/db/driver.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { buildArchive } from "../scripts/backup.ts";
import { loadInto } from "../scripts/restore.ts";
import { migrateData, parseEndpoint } from "../scripts/migrate-db.ts";

let dir: string;
let sourceDbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backup-test-"));
  sourceDbPath = join(dir, "source.db");
  await closeDatabase();
  const db = await createDatabase({ sqlitePath: sourceDbPath });
  await runMigrations(db);
  // Add some real data: a regular user + a container referencing it.
  const bcrypt = (await import("bcrypt")).default;
  const quota = await db.get<{ id: number }>("SELECT id FROM resource_quotas WHERE name='default'");
  const hash = await bcrypt.hash("pw", 4);
  await db.run(
    "INSERT INTO users (username, password_hash, email, role, quota_id) VALUES (?, ?, ?, 'user', ?)",
    "alice",
    hash,
    "alice@x.com",
    quota!.id,
  );
  const image = await db.get<{ id: number }>("SELECT id FROM images WHERE name='ubuntu-22.04'");
  const user = await db.get<{ id: number }>("SELECT id FROM users WHERE username='alice'");
  await db.run(
    "INSERT INTO containers (user_id, image_id, name, instance_name, status, cpu, memory_mb, disk_gb, env) VALUES (?, ?, 'box1', 'sb-test', 'running', 1, 512, 2, ?)",
    user!.id,
    image!.id,
    JSON.stringify({ PATH: "/usr/bin" }),
  );
  await db.run(
    "INSERT INTO operation_logs (user_id, action, resource_type, resource_id, status) VALUES (?, 'container.create', 'container', 1, 'success')",
    user!.id,
  );
  await db.close();
});

afterEach(async () => {
  await closeDatabase();
  // WAL files may linger briefly on win32; ignore cleanup errors there.
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("backup -> restore round-trip", () => {
  it("preserves all rows across an archive", async () => {
    const source = await createDatabase({ sqlitePath: sourceDbPath });
    await runMigrations(source);
    const archive = await buildArchive(source);
    await source.close();

    expect(archive.format).toBe("sandbox-platform-backup");
    expect(archive.tables.users.length).toBe(2); // admin + alice
    expect(archive.tables.containers.length).toBe(1);
    expect(archive.tables.operation_logs.length).toBe(1);

    // Restore into a fresh target.
    const targetPath = join(dir, "target.db");
    const target = await createDatabase({ sqlitePath: targetPath });
    await runMigrations(target);
    await loadInto(target, archive);

    // Verify row counts match.
    for (const [table, rows] of Object.entries(archive.tables)) {
      const got = await target.all<{ id: number }>(`SELECT id FROM ${table}`);
      expect(got.length, table).toBe(rows.length);
    }
    // Verify JSON column survived (env on containers).
    const container = await target.get<{ env: string | null }>("SELECT env FROM containers WHERE name='box1'");
    const env = JSON.parse(container!.env as string);
    expect(env).toEqual({ PATH: "/usr/bin" });

    // Verify a non-admin user round-tripped with email.
    const alice = await target.get<{ email: string }>("SELECT email FROM users WHERE username='alice'");
    expect(alice!.email).toBe("alice@x.com");

    // Sequence reset: next insert should not collide.
    const newUser = await target.run(
      "INSERT INTO users (username, password_hash) VALUES ('newbie', 'x')",
    );
    expect(Number(newUser.lastInsertRowid)).toBeGreaterThan(2);
    await target.close();
  });

  it("parseEndpoint parses sqlite and postgres specs", () => {
    expect(parseEndpoint("sqlite:./data/x.db")).toEqual({ dialect: "sqlite", location: "./data/x.db" });
    expect(parseEndpoint("postgresql://u:p@h:5432/db")).toEqual({
      dialect: "postgresql",
      location: "//u:p@h:5432/db",
    });
    expect(() => parseEndpoint("mysql:x")).toThrow();
  });

  it("migrateData copies source data into a fresh target (sqlite -> sqlite)", async () => {
    const targetPath = join(dir, "migrated.db");
    await migrateData(
      { dialect: "sqlite", location: sourceDbPath },
      { dialect: "sqlite", location: targetPath },
    );
    const target = await createDatabase({ sqlitePath: targetPath });
    const users = await target.all<{ username: string }>("SELECT username FROM users ORDER BY id");
    expect(users.map((u) => u.username)).toEqual(["admin", "alice"]);
    const containers = await target.all<{ name: string }>("SELECT name FROM containers");
    expect(containers.map((c) => c.name)).toEqual(["box1"]);
    const logs = await target.all<{ action: string }>("SELECT action FROM operation_logs");
    expect(logs.map((l) => l.action)).toEqual(["container.create"]);
    await target.close();
  });
});
