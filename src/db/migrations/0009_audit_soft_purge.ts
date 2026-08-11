/**
 * Audit retention soft-purge.
 *
 * The reaper previously hard-deleted operation_logs rows older than
 * AUDIT_RETENTION_DAYS. That destroyed the hash chain's anchor (each row's
 * prev_hash points at the previous row), so any future integrity verifier
 * would hit a gap at the purge boundary. Switching to a soft purge keeps the
 * chain reconstructable for forensic verification while still allowing the
 * reaper to mark rows as beyond retention.
 *
 * Adds a nullable `purged_at` column; the reaper now SETs purged_at instead of
 * DELETEing. A future physical-cleanup pass can remove rows where
 * purged_at IS NOT NULL AND age > a longer cold-storage threshold.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  const ts = db.dialect === "sqlite" ? "TEXT" : "TIMESTAMPTZ";
  await db.exec(`ALTER TABLE operation_logs ADD COLUMN purged_at ${ts};`);
  // Index to find unpurged rows (the live chain) cheaply.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_purged ON operation_logs(purged_at);`);
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec(`DROP INDEX IF EXISTS idx_logs_purged;`);
  if (db.dialect !== "sqlite") {
    await db.exec(`ALTER TABLE operation_logs DROP COLUMN IF EXISTS purged_at;`);
  }
  // On sqlite the column is left in place (harmless); old reaper behavior
  // (hard-delete) is unaffected by its presence.
};

const migration: Migration = { id: "0009_audit_soft_purge", up, down };
export default migration;
