/**
 * Audit integrity chain (P2-4).
 *
 * Adds prev_hash / hash columns to operation_logs. Every row's hash is
 * sha256(prev_hash + canonical-payload), forming a tamper-evident chain:
 * changing any earlier row invalidates every subsequent hash. The canonical
 * payload is computed from logical (decoded) values by log.service so the
 * chain survives dialect migration and backup/restore.
 *
 * Retention purging (reaper) still deletes old rows — hash verification then
 * starts from the oldest surviving row, which is expected.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  await db.exec(`
    ALTER TABLE operation_logs ADD COLUMN prev_hash TEXT;
    ALTER TABLE operation_logs ADD COLUMN hash TEXT;
  `);
  await db.exec(`
    CREATE INDEX idx_logs_hash ON operation_logs(hash);
  `);
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec(`DROP INDEX IF EXISTS idx_logs_hash;`);
  // SQLite cannot easily drop a column; on pg we drop them. On sqlite we leave
  // them (harmless).
  if (db.dialect !== "sqlite") {
    await db.exec(`ALTER TABLE operation_logs DROP COLUMN IF EXISTS prev_hash;`);
    await db.exec(`ALTER TABLE operation_logs DROP COLUMN IF EXISTS hash;`);
  }
};

const migration: Migration = { id: "0007_audit_chain", up, down };
export default migration;
