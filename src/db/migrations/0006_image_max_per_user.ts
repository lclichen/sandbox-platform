/**
 * Migration 0006: per-image per-user instance cap.
 *
 * images.max_per_user — when set (>0), a user may own at most this many
 * non-destroyed containers of THIS image. Drives the "one DocQA instance
 * per student" style project-template policies; null = unlimited (counted
 * only by the quota tier's max_containers as before).
 */
import type { Migration } from "./migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  // Nullable additive column is identical DDL on both dialects.
  await db.exec("ALTER TABLE images ADD COLUMN max_per_user INTEGER");
};

export const down: Migration["down"] = async ({ db }) => {
  // SQLite cannot drop columns without a table rebuild — overkill for an
  // additive nullable column, so there it stays on rollback.
  if (db.dialect !== "sqlite") {
    await db.exec("ALTER TABLE images DROP COLUMN max_per_user");
  }
};
