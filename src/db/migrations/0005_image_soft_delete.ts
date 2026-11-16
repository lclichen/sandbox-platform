/**
 * 0005: soft-delete tombstones for images.
 *
 * Destroyed containers and snapshots keep their image_id for history, so a
 * physical image DELETE would either violate the containers FK or require a
 * SQLite table rebuild. A nullable deleted_at keeps the row for those joins
 * while hiding the image from the catalogue and from new containers.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  if (db.dialect === "sqlite") {
    await db.exec("ALTER TABLE images ADD COLUMN deleted_at TEXT");
  } else {
    await db.exec("ALTER TABLE images ADD COLUMN deleted_at TIMESTAMPTZ");
  }
  await db.exec("CREATE INDEX IF NOT EXISTS idx_images_deleted_at ON images(deleted_at)");
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec("DROP INDEX IF EXISTS idx_images_deleted_at");
  await db.exec("ALTER TABLE images DROP COLUMN deleted_at");
};
