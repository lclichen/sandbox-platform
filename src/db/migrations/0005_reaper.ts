/**
 * Idle-container reaper support (manual §5.1).
 *
 * Adds the `auto_stopped` marker so the reaper can release long-idle running
 * containers (snapshot → stop) and the next user connect/start can resume the
 * container from its most recent auto-tier snapshot automatically.
 */
import type { Migration } from "../migrate.ts";

function isSqlite(db: { dialect: string }): boolean {
  return db.dialect === "sqlite";
}

export const up: Migration["up"] = async ({ db }) => {
  const sqlite = isSqlite(db);
  // ALTER TABLE ... ADD COLUMN with DEFAULT works identically on both dialects.
  await db.exec(`
    ALTER TABLE containers ADD COLUMN auto_stopped ${sqlite ? "INTEGER NOT NULL DEFAULT 0" : "BOOLEAN NOT NULL DEFAULT FALSE"};
    ALTER TABLE containers ADD COLUMN auto_stopped_at ${sqlite ? "TEXT" : "TIMESTAMPTZ"};
  `);
  // Reaper scan: running containers ordered by last start.
  await db.exec(`
    CREATE INDEX idx_containers_reaper ON containers(status, last_started_at);
  `);
};

export const down: Migration["down"] = async ({ db }) => {
  // SQLite cannot easily drop a column; on pg we drop them. On sqlite we leave
  // them (harmless). The index is dropped on both.
  if (db.dialect !== "sqlite") {
    await db.exec(`ALTER TABLE containers DROP COLUMN IF EXISTS auto_stopped;`);
    await db.exec(`ALTER TABLE containers DROP COLUMN IF EXISTS auto_stopped_at;`);
  }
  await db.exec(`DROP INDEX IF EXISTS idx_containers_reaper;`);
};

const migration: Migration = { id: "0005_reaper", up, down };
export default migration;
