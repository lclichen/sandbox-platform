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
// The chain was squashed (0001..0006 → 0001_baseline): fresh databases run the
// single baseline; databases that already ran the full former chain are marked
// at the baseline without re-running it (identical end state).
const migrationModules: Array<{ id: string; module: string }> = [
  { id: "0001_baseline", module: "./migrations/0001_baseline.ts" },
  { id: "0002_token_version", module: "./migrations/0002_token_version.ts" },
];

/** The former incremental chain — kept only to recognize already-migrated
 *  deployments (see runMigrations); no module is loaded for these ids. */
const LEGACY_MIGRATION_IDS = [
  "0001_schema",
  "0002_seed",
  "0003_pi_web_integration",
  "0004_remove_demo_images",
  "0005_snapshot_decouple",
  "0006_image_max_per_user",
];
const BASELINE_ID = "0001_baseline";

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

  // Legacy-chain recognition: a database that ran the FULL former chain is at
  // the same end state as the squashed baseline — record the baseline as
  // applied without re-running it. A PARTIAL legacy chain (stopped on an old
  // release) cannot be advanced by this code: its pending increments no
  // exist. Fail loudly with the remedy instead of silently re-baselining a
  // half-migrated schema.
  const legacyApplied = LEGACY_MIGRATION_IDS.filter((id) => applied.has(id));
  if (legacyApplied.length > 0) {
    if (legacyApplied.length !== LEGACY_MIGRATION_IDS.length) {
      throw new Error(
        `数据库停留在旧迁移链的中间状态（已应用 ${legacyApplied.length}/${LEGACY_MIGRATION_IDS.length}: ${legacyApplied.join(", ")}）。` +
        "请先用上一版本代码完成一次启动（应用全部旧迁移），或导出数据后在全新数据库上重新初始化。",
      );
    }
    if (!applied.has(BASELINE_ID)) {
      await db.run("INSERT INTO schema_migrations (id) VALUES (?)", BASELINE_ID);
      applied.add(BASELINE_ID);
    }
  }

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
