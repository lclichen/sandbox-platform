/**
 * Refresh-token family cascade (P1-3, OWASP refresh-rotation hardening).
 *
 * Adds `family_id` to refresh_tokens. Every login starts a new family; every
 * rotation inside a refresh keeps the same family. When a revoked token is
 * replayed (theft signal), the auth service revokes the ENTIRE family so a
 * stolen token cannot keep issuing new pairs.
 *
 * Legacy rows are backfilled to their own family (token_hash) so pre-upgrade
 * tokens keep working as before.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  // ALTER TABLE ... ADD COLUMN with DEFAULT works identically on both dialects.
  await db.exec(`
    ALTER TABLE refresh_tokens ADD COLUMN family_id VARCHAR(64) NOT NULL DEFAULT '';
  `);
  // Backfill: each legacy token becomes its own family.
  await db.run(`UPDATE refresh_tokens SET family_id = token_hash WHERE family_id = ''`);
  await db.exec(`
    CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
  `);
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec(`DROP INDEX IF EXISTS idx_refresh_tokens_family;`);
  // SQLite cannot easily drop a column; on pg we drop it. On sqlite we leave
  // it (harmless).
  if (db.dialect !== "sqlite") {
    await db.exec(`ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS family_id;`);
  }
};

const migration: Migration = { id: "0006_refresh_family", up, down };
export default migration;
