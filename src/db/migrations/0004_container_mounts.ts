/**
 * 0004: Container input/output mounts.
 *
 * Each mount row records ONE user-selected input item (workspace file or
 * subtree, materialized into the container's read-only /input staging dir) or
 * the single output binding (live RW view of the workspace folder
 * outputs/<container-name>/). Rows persist across stop/start so the binds can
 * be replayed on restart (fixing the pre-existing restart-drops-bind gap) and
 * drive the mounts UI. Host paths are always DERIVED from (workspace_id,
 * rel_path) at resolve time — never stored, never accepted from clients.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  await db.exec(`CREATE TABLE IF NOT EXISTS container_mounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('input', 'output')),
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    rel_path TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  await db.exec("CREATE INDEX IF NOT EXISTS idx_container_mounts_container ON container_mounts(container_id)");
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec("DROP INDEX IF EXISTS idx_container_mounts_container");
  await db.exec("DROP TABLE IF EXISTS container_mounts");
};
