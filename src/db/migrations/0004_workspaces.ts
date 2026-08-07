/**
 * User workspaces: persistent per-user file storage that survives container
 * destroy and seeds a new container's /workspace on create.
 *
 * Each workspace row references a directory on the host FS under
 * WORKSPACE_BASE_DIR. The platform (control plane) owns these files; the
 * executor seeds them into a container at create time (see CreateRequest.seedFromPath).
 *
 * Also adds a per-user workspace count quota to resource_quotas.
 */
import type { Migration } from "../migrate.ts";

function isSqlite(db: { dialect: string }): boolean {
  return db.dialect === "sqlite";
}

export const up: Migration["up"] = async ({ db }) => {
  const sqlite = isSqlite(db);

  await db.exec(`
    CREATE TABLE workspaces (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      -- Host-relative path under WORKSPACE_BASE_DIR (e.g. "user-3/ws-7").
      storage_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      -- When committed-back from a container (Phase 2), records the source.
      source_container_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
      is_template ${sqlite ? "INTEGER NOT NULL DEFAULT 0" : "BOOLEAN NOT NULL DEFAULT FALSE"},
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      updated_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      UNIQUE(user_id, name)
    );
    CREATE INDEX idx_workspaces_user ON workspaces(user_id);
  `);

  // Per-user workspace count quota. ALTER TABLE ADD COLUMN with DEFAULT works
  // identically on both dialects; existing seeded quota tiers inherit the default.
  await db.exec(`
    ALTER TABLE resource_quotas ADD COLUMN max_workspaces_per_user INTEGER NOT NULL DEFAULT 10;
  `);

  // Give elevated tiers more workspaces. (default stays at 10 from the column default.)
  await db.run("UPDATE resource_quotas SET max_workspaces_per_user = 50 WHERE name = 'admin'");
  await db.run("UPDATE resource_quotas SET max_workspaces_per_user = 100 WHERE name = 'enterprise'");
};

export const down: Migration["down"] = async ({ db }) => {
  // SQLite cannot easily drop a column; on pg we drop it. On sqlite we leave it
  // (harmless). The table drop is reversible on both.
  if (db.dialect !== "sqlite") {
    await db.exec(`ALTER TABLE resource_quotas DROP COLUMN IF EXISTS max_workspaces_per_user;`);
  }
  await db.exec(`DROP TABLE IF EXISTS workspaces;`);
};

const migration: Migration = { id: "0004_workspaces", up, down };
export default migration;
