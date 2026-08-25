/**
 * Remove the seeded DEMO images (0002) from real deployments.
 *
 * The 0002 seed shipped three catalogue rows whose sif_path points at
 * placeholder locations (/srv/apptainer/images/*.sif) that do not exist on
 * any real host. Users selected them, container creation failed after the row
 * was already marked running, and every later tool call surfaced as a
 * baffling "instance not found". The catalogue should start EMPTY — admins
 * register images that actually exist (docs/IMAGES.md lists pull commands).
 *
 * Demo/mock environments (EXECUTOR_KIND=mock) may keep the rows by setting
 * SEED_DEMO_IMAGES=on — the mock executor never touches the sif files.
 *
 * Rows referenced by containers are kept (history must stay consistent);
 * they are safe to delete from the admin console after those containers are
 * destroyed.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  if (process.env.SEED_DEMO_IMAGES === "on" || process.env.SEED_DEMO_IMAGES === "1") {
    return;
  }
  await db.run(
    `DELETE FROM images
      WHERE sif_path LIKE '/srv/apptainer/images/%'
        AND id NOT IN (SELECT image_id FROM containers)`,
  );
};

export const down: Migration["down"] = async () => {
  // Irreversible by design — the demo rows are intentionally not restored.
};
