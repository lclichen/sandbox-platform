/**
 * Snapshot lifecycle decoupling + overlay kind.
 *
 * Snapshots used to be a child of containers (`container_id ... ON DELETE
 * CASCADE`): destroying (or auto-recycling) a container silently deleted every
 * snapshot ROW, while the copied overlay files leaked on disk — the exact
 * opposite of the "recycle the container, keep the save points" teaching
 * workflow. This migration rebuilds the table so a snapshot owns itself:
 *
 *   - container_id becomes NULLABLE with no FK enforcement: rows survive
 *     container deletion (a NULL container_id = orphaned save point)
 *   - user_id (NOT NULL): the owner at snapshot time — the access boundary
 *     once the container row is gone
 *   - image_id: which image the overlay was layered on; restoring into a NEW
 *     container needs it
 *   - name uniqueness moves to (user_id, name): names are the user's save
 *     slots now
 *
 * Also adds images.overlay_kind ('ext3' default | 'dir'): admins may flag an
 * image to provision a directory overlay (thin by nature) instead of a
 * pre-sized ext3 image — opt-in per image, ext3 stays the default hard cap.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  // images.overlay_kind (additive; SQLite ALTER ADD COLUMN)
  const imageCols = await db.all<{ name: string }>("PRAGMA table_info(images)");
  if (!imageCols.some((c) => c.name === "overlay_kind")) {
    await db.run("ALTER TABLE images ADD COLUMN overlay_kind TEXT NOT NULL DEFAULT 'ext3'");
  }

  // snapshots rebuild (SQLite cannot drop FK constraints in place)
  const snapCols = await db.all<{ name: string }>("PRAGMA table_info(snapshots)");
  const hasUserId = snapCols.some((c) => c.name === "user_id");
  if (hasUserId) return; // already migrated

  await db.run(`
    CREATE TABLE snapshots_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
      overlay_id INTEGER REFERENCES overlays(id) ON DELETE SET NULL,
      user_id INTEGER NOT NULL,
      image_id INTEGER,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      overlay_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, name)
    )
  `);
  // Backfill owner/image from the container row; snapshots whose container is
  // already gone cannot be re-attributed and are dropped with their files
  // (they were unreachable through any API before this migration anyway).
  await db.run(`
    INSERT INTO snapshots_new (id, container_id, overlay_id, user_id, image_id, name, description, overlay_path, size_bytes, created_at)
    SELECT s.id, s.container_id, s.overlay_id, c.user_id, c.image_id, s.name, s.description, s.overlay_path, s.size_bytes, s.created_at
      FROM snapshots s JOIN containers c ON c.id = s.container_id
  `);
  await db.run("DROP TABLE snapshots");
  await db.run("ALTER TABLE snapshots_new RENAME TO snapshots");
  await db.run("CREATE INDEX idx_snapshots_user ON snapshots(user_id)");
  await db.run("CREATE INDEX idx_snapshots_container ON snapshots(container_id)");
};
