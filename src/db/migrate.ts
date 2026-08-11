/**
 * Migration runner.
 *
 * Each migration is a TS module in `./migrations/` exporting `up`/`down`.
 * Applied migrations are tracked in a `schema_migrations` table. Each
 * migration receives the `Database` instance and is responsible for its own
 * dialect-conditional DDL (via `db.dialect`).
 *
 * Migrations run inside a single transaction per migration (best-effort on
 * sqlite; explicit BEGIN/COMMIT on pg).
 */
import type { Database } from "./driver.ts";

export interface MigrationContext {
  db: Database;
}

export interface Migration {
  readonly id: string;
  up(ctx: MigrationContext): Promise<void>;
  down(ctx: MigrationContext): Promise<void>;
}

// Imported dynamically below. Paths use explicit .ts so --experimental-transform-types resolves them.
const migrationModules: Array<{ id: string; module: string }> = [
  { id: "0001_init", module: "./migrations/0001_init.ts" },
  { id: "0002_seed_defaults", module: "./migrations/0002_seed_defaults.ts" },
  { id: "0003_api_keys", module: "./migrations/0003_api_keys.ts" },
  { id: "0004_workspaces", module: "./migrations/0004_workspaces.ts" },
  { id: "0005_reaper", module: "./migrations/0005_reaper.ts" },
  { id: "0006_refresh_family", module: "./migrations/0006_refresh_family.ts" },
  { id: "0007_audit_chain", module: "./migrations/0007_audit_chain.ts" },
  { id: "0008_llm_bindings", module: "./migrations/0008_llm_bindings.ts" },
];

async function ensureSchemaMigrationsTable(db: Database): Promise<void> {
  if (db.dialect === "sqlite") {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
}

async function listApplied(db: Database): Promise<Set<string>> {
  const rows = await db.all<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(rows.map((r) => r.id));
}

export async function runMigrations(db: Database): Promise<string[]> {
  await ensureSchemaMigrationsTable(db);
  const applied = await listApplied(db);
  const pending = migrationModules.filter((m) => !applied.has(m.id));
  const appliedNow: string[] = [];

  for (const meta of pending) {
    const mod = (await import(meta.module)) as Migration;
    await db.tx(async (tx) => {
      // Migrations use the tx as a Database-shaped interface.
      const ctxDb = tx as unknown as Database;
      await mod.up({ db: ctxDb });
      await ctxDb.run("INSERT INTO schema_migrations (id) VALUES (?)", meta.id);
    });
    appliedNow.push(meta.id);
  }
  return appliedNow;
}

export async function rollbackLast(db: Database): Promise<string | null> {
  await ensureSchemaMigrationsTable(db);
  const applied = await listApplied(db);
  if (applied.size === 0) return null;
  // Roll back the highest-id migration that we know how to reverse.
  const known = migrationModules.map((m) => m.id);
  const appliedKnown = known.filter((k) => applied.has(k));
  if (appliedKnown.length === 0) return null;
  const target = appliedKnown[appliedKnown.length - 1];
  const meta = migrationModules.find((m) => m.id === target);
  if (!meta) return null;
  const mod = (await import(meta.module)) as Migration;
  await db.tx(async (tx) => {
    const ctxDb = tx as unknown as Database;
    await mod.down({ db: ctxDb });
    await ctxDb.run("DELETE FROM schema_migrations WHERE id = ?", target);
  });
  return target;
}
