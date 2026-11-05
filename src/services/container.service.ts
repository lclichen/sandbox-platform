/**
 * Container service: lifecycle orchestration.
 *
 * Bridges the database (container rows, overlays) and the executor (actual
 * container runtime). Owns instance-name generation and quota enforcement
 * before provisioning. Snapshot/restore delegate field-recovery to the
 * executor's overlay-copy mechanism.
 */
import { nanoid } from "nanoid";
import type { Database, SqlValue } from "../db/driver.ts";
import { encodeJson, decodeJson } from "../db/driver.ts";
import type { SandboxExecutor, ContainerHandle } from "../executors/types.ts";
import { handleFromRow, persistRunningState } from "../executors/types.ts";
import { createQuotaService, type ResourceRequest } from "./quota.service.ts";
import { createImageService, resolveImagePath } from "./image.service.ts";
import { createWorkspaceService } from "./workspace.service.ts";
import {
  mountLimits,
  assertDirHasNoSymlinks,
  duBytes,
  ensureInputDir,
  ensureOutputDir,
  inputDir,
  materializeInput,
  outputRelDir,
  removeInputDir,
  removeStagingEntry,
  resolveInputSource,
} from "./container-mounts.ts";
import { withContainerLock } from "./container-lock.ts";
import { effectiveWorkspaceUploadMaxBytes } from "./runtime-settings.ts";
import { loadConfig } from "../config.ts";
import {
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
  BadRequestError,
  ContainerNotRunningError,
} from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";

export interface ContainerRow {
  id: number;
  user_id: number;
  image_id: number;
  name: string;
  instance_name: string | null;
  status: string;
  overlay_path: string | null;
  node: string | null;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  env: Record<string, string> | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  last_started_at: string | null;
  last_stopped_at: string | null;
  /** Owner username (admin cross-user listing only; NULL otherwise). */
  owner_username?: string | null;
  /** Set by the reaper when it auto-released an idle container (snapshot + stop). */
  auto_stopped: boolean | number;
  auto_stopped_at: string | null;
}

export interface ContainerPublic extends Omit<ContainerRow, "instance_name" | "overlay_path" | "node"> {
  instance_name: string | null;
  node: string | null;
  /** Decoded env overrides (hidden from the row type; toPublic decodes JSON). */
  env: Record<string, string> | null;
}

/**
 * Public projection of a container row. `error_message` may embed internal
 * paths/runtime detail, so it is only exposed to admins (P2-1). Env values that
 * look like secrets (key/token/secret substrings) are masked so injected LLM
 * virtual keys are never echoed back through GET /containers.
 */
// Substring, not suffix: keys like OPENAI_APIKEY / DB_PASS / MY_AUTH would
// otherwise be echoed in clear. A false positive (e.g. MONKEY) is harmless.
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|PRIVATE|AUTH)/i;
function toPublic(row: ContainerRow, dialect: string, isAdmin = false): ContainerPublic {
  const { env: _env, error_message: _errorMessage, ...rest } = row;
  void _env;
  void _errorMessage;
  const rawEnv = decodeJson<Record<string, string>>(row.env ?? null, dialect as never) ?? null;
  const env = rawEnv
    ? Object.fromEntries(
        Object.entries(rawEnv).map(([k, v]) => [k, SECRET_ENV_RE.test(k) ? "***" : v]),
      )
    : null;
  return {
    ...rest,
    env,
    error_message: isAdmin ? row.error_message : null,
  };
}

export interface CreateContainerInput {
  imageId: number;
  name: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  env?: Record<string, string>;
  workspaceId?: number;
  /** Input/output mounts (docs/沙盒输入输出挂载设计.md). */
  mounts?: {
    /** Workspace files/subtrees materialized into the ro /input staging dir. */
    inputs?: Array<{ workspaceId: number; path: string }>;
    /** Live RW bind of <workspace>/outputs/<container-name>/ at /output. */
    output?: { workspaceId: number };
  };
}

export interface ContainerMountRow {
  id: number;
  container_id: number;
  kind: "input" | "output";
  workspace_id: number;
  rel_path: string;
  name: string;
  created_at: string;
}

/**
 * Optional hook that returns env overrides to inject into a newly created
 * container for a given user (e.g. LLM base URL + virtual key when the user
 * has an active LLM binding). When omitted or it returns undefined, no extra
 * env is injected. Kept as a callback so this service stays decoupled from the
 * LLM service + LiteLLM client.
 */
export type LlmEnvProvider = (userId: number) => Promise<Record<string, string> | undefined>;

export function createContainerService(db: Database, executor: SandboxExecutor, llmEnvFor?: LlmEnvProvider) {
  const quotas = createQuotaService(db);
  const images = createImageService(db);
  const workspaces = createWorkspaceService(db);

  return {
    async getById(id: number): Promise<ContainerRow | null> {
      const raw = await db.get<Record<string, unknown>>(
        "SELECT * FROM containers WHERE id = ?",
        id,
      );
      return raw ? (raw as unknown as ContainerRow) : null;
    },

    async requireById(id: number): Promise<ContainerRow> {
      const row = await this.getById(id);
      if (!row) throw new NotFoundError("Container", id);
      return row;
    },

    /** List containers for a user (admins can pass userId=undefined to list all).
     *  R6: `image` filters by image id; `filter` is a friendly status alias. */
    async list(
      userId: number | undefined,
      opts: { limit?: number; offset?: number; status?: string; image?: number } = {},
    ): Promise<ContainerRow[]> {
      const limit = Math.min(opts.limit ?? 50, 200);
      const offset = opts.offset ?? 0;
      // Fragments must alias `c.` — the users join makes bare `status`
      // (users.status vs containers.status) ambiguous.
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (userId !== undefined) {
        where.push("c.user_id = ?");
        params.push(userId);
      }
      if (opts.status) {
        where.push("c.status = ?");
        params.push(opts.status);
      }
      if (opts.image) {
        where.push("c.image_id = ?");
        params.push(opts.image);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return db.all<ContainerRow>(
        `SELECT c.*, u.username AS owner_username FROM containers c LEFT JOIN users u ON u.id = c.user_id ${clause} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
    },

    async create(userId: number, input: CreateContainerInput, isAdmin = false): Promise<ContainerRow> {
      const image = await images.requireById(input.imageId);
      // R6: the owner's quota may whitelist which images are provisionable;
      // private (is_public=false) images are admin-only.
      await quotas.assertImageAllowed(
        userId,
        {
          id: image.id,
          is_public: Boolean(image.is_public),
          name: image.name,
        },
        isAdmin,
      );
      // Fallback disk is intentionally small (1 GB): overlays are
      // pre-allocated ext3 images, so diskGb is real disk usage per container —
      // on a small single-box deployment 5 GB/container plus same-size
      // snapshots exhausts the disk fast. Images that need more set their own
      // default_resources (authoritative override).
      const defaults = image.default_resources ?? { cpu: 1, memoryMb: 1024, diskGb: 1 };
      const request: ResourceRequest = {
        cpu: input.cpu ?? defaults.cpu,
        memory_mb: input.memoryMb ?? defaults.memoryMb,
        disk_gb: input.diskGb ?? defaults.diskGb,
      };
      // Enforce quota before any provisioning.
      await quotas.assertCanCreate(userId, request);
      // Per-image per-user instance cap (project-template policies).
      await quotas.assertImageInstanceLimit(userId, {
        id: image.id,
        max_per_user: Number((image as { max_per_user?: number | null }).max_per_user ?? 0),
        name: image.name,
      });

      // Inject platform-managed env (LLM base URL + virtual key) when the owner
      // has an active binding. The LLM env wins over user-supplied same-name
      // keys so a user cannot bypass the platform's budgeted virtual key. A
      // failure here is non-fatal: we proceed without LLM env rather than
      // blocking container creation.
      let llmEnv: Record<string, string> | undefined;
      if (llmEnvFor) {
        try {
          llmEnv = await llmEnvFor(userId);
        } catch (err) {
          logger.warn({ userId, err: (err as Error).message }, "container.service: LLM env injection skipped");
        }
      }
      const mergedEnv: Record<string, string> | undefined =
        input.env || llmEnv ? { ...(input.env ?? {}), ...(llmEnv ?? {}) } : undefined;

      const instanceName = `sb-${nanoid(12)}`;

      // Resolve an optional workspace to seed /workspace from. Ownership is
      // enforced via requireOwned (404 for non-owners). The host path is passed
      // to the executor which decides how to apply it (cp or bind-mount).
      let seedFromPath: string | undefined;
      if (input.workspaceId !== undefined) {
        const ws = await workspaces.requireOwned(input.workspaceId, userId);
        seedFromPath = workspaces.hostDir(ws);
      }

      // Input/output mounts: resolve BEFORE the row insert so a bad selection
      // (missing item / symlink / over-cap / foreign workspace) fails without
      // leaking a 'creating' row that still counts against the user's quota.
      const mountSetup = await this._prepareMounts(userId, instanceName, input.name, input.mounts);

      const result = await db.run(
        `INSERT INTO containers
          (user_id, image_id, name, instance_name, status, cpu, memory_mb, disk_gb, env)
         VALUES (?, ?, ?, ?, 'creating', ?, ?, ?, ?)`,
        userId,
        input.imageId,
        input.name,
        instanceName,
        request.cpu,
        request.memory_mb,
        request.disk_gb,
        encodeJson(mergedEnv ?? null, db.dialect) as SqlValue,
      );
      const containerId = Number(result.lastInsertRowid);

      try {
        const handle = await executor.create({
          id: instanceName,
          imagePath: resolveImagePath(image.sif_path),
          cpu: request.cpu,
          memoryMb: request.memory_mb,
          diskGb: request.disk_gb,
          env: mergedEnv,
          seedFromPath,
          ...(mountSetup ? { mountDirs: mountSetup.mountDirs } : {}),
          // Admin opt-in per image: 'dir' provisions a thin directory overlay
          // instead of a pre-sized ext3 image (see images.overlay_kind).
          ...(image.overlay_kind === "dir" ? { overlayKind: "dir" as const } : {}),
        });
        // Record overlay path + node, then mark running.
        await db.run(
          "UPDATE containers SET status = 'running', overlay_path = ?, node = ?, last_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          handle.overlayPath,
          handle.node,
          containerId,
        );
        // Record the initial overlay row.
        await db.run(
          "INSERT INTO overlays (container_id, path, is_current, size_bytes) VALUES (?, ?, 1, 0)",
          containerId,
          handle.overlayPath,
        );
        // Persist the mount rows (replayed on every restart).
        for (const m of mountSetup?.rows ?? []) {
          await db.run(
            "INSERT INTO container_mounts (container_id, kind, workspace_id, rel_path, name) VALUES (?, ?, ?, ?, ?)",
            containerId,
            m.kind,
            m.workspaceId,
            m.relPath,
            m.name,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.run(
          "UPDATE containers SET status = 'error', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          message,
          containerId,
        );
        throw err;
      }

      return (await this.requireById(containerId))!;
    },

    async start(id: number, userId: number, isAdmin = false): Promise<ContainerRow> {
      return withContainerLock(id, async () => {
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status === "running") return row;
      if (row.status === "destroyed") throw new InvalidStateError("Cannot start a destroyed container");
      // Reaper semantics: an auto-released container resumes from its most
      // recent auto-tier snapshot (the state at release time) instead of the
      // current overlay, then the marker is cleared.
      if (row.auto_stopped && row.status === "stopped") {
        const snap = await db.get<{ id: number; name: string; overlay_path: string; size_bytes: number }>(
          "SELECT id, name, overlay_path, size_bytes FROM snapshots WHERE container_id = ? AND name LIKE ? ORDER BY id DESC LIMIT 1",
          id,
          "auto-%",
        );
        if (snap) {
          await this._restoreFromSnapshot(row, { id: snap.id, name: snap.name, overlay_path: snap.overlay_path, ...(snap.size_bytes != null ? { size_bytes: snap.size_bytes } : {}) });
          // Clear the marker only AFTER a successful restore — clearing first
          // orphans the resume snapshot on failure (the next start would fall
          // through to the stale overlay).
          await db.run(
            "UPDATE containers SET auto_stopped = 0, auto_stopped_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            id,
          );
          return (await this.requireById(id))!;
        }
        await db.run(
          "UPDATE containers SET auto_stopped = 0, auto_stopped_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          id,
        );
        // No snapshot to resume from — fall through to a plain overlay start.
      }
      const image = await images.requireById(row.image_id);
      // Mount replay: containers with persisted mounts re-derive their bind
      // dirs on EVERY start (this also fixes the pre-existing gap where the
      // seed bind silently vanished after stop/start).
      const replayMounts = await this._replayMounts(row);
      const handle = await executor.create({
        id: row.instance_name!,
        imagePath: resolveImagePath(image.sif_path),
        cpu: row.cpu,
        memoryMb: row.memory_mb,
        diskGb: row.disk_gb,
        env: decodeJson<Record<string, string>>(row.env ?? null, db.dialect as never) ?? undefined,
        ...(replayMounts ? { mountDirs: replayMounts } : {}),
      });
      await db.run(
        "UPDATE containers SET status = 'running', overlay_path = ?, node = ?, last_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, error_message = NULL WHERE id = ?",
        handle.overlayPath,
        handle.node,
        id,
      );
      return (await this.requireById(id))!;
      });
    },

    async stop(id: number, userId: number, isAdmin = false): Promise<ContainerRow> {
      return withContainerLock(id, async () => {
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status !== "running") throw new InvalidStateError(`Cannot stop a container in '${row.status}' state`);
      const handle = handleFromRow(row);
      await executor.stop(handle);
      await persistRunningState(db, id, false);
      return (await this.requireById(id))!;
      });
    },

    async destroy(id: number, userId: number, isAdmin = false): Promise<void> {
      return withContainerLock(id, async () => {
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status === "destroyed") return;
      try {
        if (row.status === "running") {
          const handle = handleFromRow(row);
          await executor.stop(handle);
        }
        const handle = handleFromRow(row);
        await executor.destroy(handle);
      } catch (err) {
        // Even if destroy fails on the runtime side, mark destroyed in DB.
        logger.warn({ err, containerId: id }, "executor destroy error (container still marked destroyed)");
      }
      // Input staging is container-scoped (the workspace SOURCES and the
      // reclaimed outputs both live in the user's workspace) — clean it up.
      // Best-effort: a stuck file must not block destruction.
      if (row.instance_name) {
        await removeInputDir(row.instance_name).catch((err) => {
          logger.warn({ containerId: id, err: (err as Error).message }, "destroy: input staging cleanup failed (best-effort)");
        });
      }
      // Snapshots OUTLIVE the container (migration 0005: user-owned save
      // points — the recycle-then-restore workflow). Do NOT touch them here;
      // their rows/files are managed through the user-scoped snapshot APIs.
      await db.run("DELETE FROM overlays WHERE container_id = ?", id);
      await db.run(
        "UPDATE containers SET status = 'destroyed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        id,
      );
      });
    },

    async snapshot(id: number, userId: number, name: string, description?: string, isAdmin = false, opts: { restartAfter?: boolean } = {}): Promise<{ id: number; name: string; sizeBytes: number }> {
      return withContainerLock(id, async () => {
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status === "destroyed") throw new InvalidStateError("Cannot snapshot a destroyed container");
      // Quota/snapshot ownership follows the CONTAINER owner, not the actor:
      // an admin snapshotting someone else's container must not consume the
      // admin's disk quota or create an admin-owned save point for another
      // user's data.
      const ownerId = row.user_id;
      const quota = await quotas.forUser(ownerId);
      const existingCount = await db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM snapshots WHERE container_id = ?",
        id,
      );
      if (Number(existingCount?.c ?? 0) >= quota.max_snapshots_per_container) {
        throw new InvalidStateError(
          `Snapshot quota reached (${existingCount?.c}/${quota.max_snapshots_per_container})`,
        );
      }
      const dup = await db.get<{ id: number }>("SELECT id FROM snapshots WHERE container_id = ? AND name = ?", id, name);
      if (dup) throw new BadRequestError(`Snapshot name '${name}' already exists for this container`);

      // Stop-Then-Copy (manual §4.1): a running overlay may be mid-write, so we
      // quiesce the instance, copy the overlay, then bring it back up. The
      // reaper passes restartAfter:false to leave the instance stopped.
      const handle = handleFromRow(row);
      const wasRunning = row.status === "running";
      if (wasRunning) {
        try {
          await executor.stop(handle);
        } catch (err) {
          logger.warn({ id, err: (err as Error).message }, "snapshot: pre-copy stop failed; copying anyway");
        }
      }
      let copied: string | undefined;
      try {
        const snap = await executor.snapshot(handle, name);
        copied = snap.overlayPath;
        // P2-5: the copy already happened on disk, but refuse to record it if
        // it would push the OWNER past their aggregate disk ceiling.
        await quotas.assertAggregateDisk(ownerId, snap.sizeBytes);
        const result = await db.run(
          `INSERT INTO snapshots (container_id, user_id, image_id, name, description, overlay_path, size_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id,
          ownerId,
          row.image_id,
          name,
          description ?? null,
          snap.overlayPath,
          snap.sizeBytes,
        );
        copied = undefined; // recorded — the row now owns the copy
        // P3-1 overlay maintenance: link the snapshot to the current overlay
        // row and refresh that row's size_bytes (a snapshot is a copy of the
        // overlay, so its size approximates the overlay's usage).
        const overlayRow = await db.get<{ id: number }>(
          "SELECT id FROM overlays WHERE container_id = ? AND is_current = 1 ORDER BY id DESC LIMIT 1",
          id,
        );
        if (overlayRow) {
          await db.run(
            "UPDATE snapshots SET overlay_id = ? WHERE id = ?",
            overlayRow.id,
            Number(result.lastInsertRowid),
          );
          await db.run("UPDATE overlays SET size_bytes = ? WHERE id = ?", snap.sizeBytes, overlayRow.id);
        }
        return { id: Number(result.lastInsertRowid), name, sizeBytes: snap.sizeBytes };
      } catch (err) {
        // Quota-refused (or insert failed) AFTER the disk copy: delete the
        // orphan so it never counts or leaks (the reaper hit this constantly
        // for over-quota users).
        if (copied) await executor.removePath(copied, row.node ?? undefined).catch(() => undefined);
        throw err;
      } finally {
        if (wasRunning && opts.restartAfter !== false) {
          try {
            // Re-read the row INSIDE the lock: a concurrent destroy may have
            // removed the container while the copy ran — restarting here would
            // resurrect an instance the DB no longer tracks.
            const current = await db.get<{ status: string }>("SELECT status FROM containers WHERE id = ?", id);
            if (!current || current.status === "destroyed") {
              logger.info({ id }, "snapshot: container destroyed during copy; skipping restart");
            } else {
              // Resume from the existing overlay via create (which carries the
              // image path) — a bare executor.start() cannot rebuild the full
              // instance-start command for SSH/CLI from a DB-derived handle.
              const image = await images.requireById(row.image_id);
              await executor.create({
                id: row.instance_name!,
                imagePath: resolveImagePath(image.sif_path),
                cpu: row.cpu,
                memoryMb: row.memory_mb,
                diskGb: row.disk_gb,
                overlayPath: handle.overlayPath,
                env: decodeJson<Record<string, string>>(row.env ?? null, db.dialect as never) ?? undefined,
              });
            }
          } catch (err) {
            // The instance is stopped but the row says running — every later
            // tool call would fail with "instance not found". Mark stopped.
            logger.warn({ id, err: (err as Error).message }, "snapshot: restart after copy failed; marking stopped");
            await persistRunningState(db, id, false).catch(() => undefined);
          }
        }
      }
      });
    },

    async listSnapshots(id: number, userId: number, isAdmin = false) {
      await this.requireOwned(id, userId, isAdmin);
      return db.all<{ id: number; name: string; description: string | null; size_bytes: number; created_at: string }>(
        "SELECT id, name, description, size_bytes, created_at FROM snapshots WHERE container_id = ? ORDER BY id DESC",
        id,
      );
    },

    /** The user's snapshots across ALL containers, including save points whose
     *  container was destroyed/recycled (container_id NULL). This is the
     *  "game save list" the web UI groups by project. */
    async listMySnapshots(userId: number) {
      return db.all<{
        id: number; name: string; description: string | null; size_bytes: number;
        created_at: string; container_id: number | null; container_name: string | null;
        container_status: string | null; image_id: number; image_name: string | null;
      }>(
        `SELECT s.id, s.name, s.description, s.size_bytes, s.created_at,
                s.container_id, c.name AS container_name, c.status AS container_status,
                s.image_id, i.name AS image_name
           FROM snapshots s
           LEFT JOIN containers c ON c.id = s.container_id
           LEFT JOIN images i ON i.id = s.image_id
          WHERE s.user_id = ?
          ORDER BY s.id DESC`,
        userId,
      );
    },

    /** Restore an orphaned (or any owned) snapshot into a BRAND-NEW container:
     *  create from the snapshot's image with a fresh overlay, then swap the
     *  snapshot overlay in and start — the recycle-then-restore workflow. */
    async restoreSnapshotToNewContainer(
      snapshotId: number,
      userId: number,
      name: string,
      isAdmin = false,
    ): Promise<ContainerRow> {
      const snap = await this.requireOwnedSnapshot(snapshotId, userId, isAdmin);
      if (!snap.image_id) throw new BadRequestError("Snapshot has no recorded image; cannot restore to a new container");
      // Reuse create()'s image gate: a user may not resurrect a private image
      // through a snapshot row they happen to own.
      const row = await this.create(userId, { imageId: snap.image_id, name }, isAdmin);
      try {
        await this._restoreFromSnapshot(row, {
          id: snap.id,
          name: snap.name,
          overlay_path: snap.overlay_path,
          ...(snap.size_bytes != null ? { size_bytes: snap.size_bytes } : {}),
        });
      } catch (err) {
        // Best-effort cleanup of the half-built container; the snapshot row
        // survives (it owns its files independently).
        await this.destroy(row.id, userId, isAdmin).catch(() => undefined);
        throw err;
      }
      return (await this.requireById(row.id))!;
    },

    /** Delete one of MY snapshots — works for orphans too (container gone). */
    async deleteMySnapshot(snapshotId: number, userId: number, isAdmin = false): Promise<void> {
      const snap = await this.requireOwnedSnapshot(snapshotId, userId, isAdmin);
      await executor.removePath(snap.overlay_path, snap.node ?? undefined).catch((err) => {
        logger.warn({ snapshotId, err: (err as Error).message }, "deleteMySnapshot: file cleanup failed (row still deleted)");
      });
      await db.run("DELETE FROM snapshots WHERE id = ?", snapshotId);
    },

    /** Ownership check for a snapshot row (user_id is the boundary since
     *  snapshots outlive their containers). */
    async requireOwnedSnapshot(snapshotId: number, userId: number, isAdmin = false): Promise<{
      id: number; name: string; overlay_path: string; size_bytes: number | null;
      image_id: number | null; container_id: number | null; node: string | null;
    }> {
      const snap = await db.get<{
        id: number; name: string; overlay_path: string; size_bytes: number | null;
        image_id: number | null; container_id: number | null; user_id: number;
        node: string | null;
      }>(
        `SELECT s.id, s.name, s.overlay_path, s.size_bytes, s.image_id, s.container_id, s.user_id,
                c.node AS node
           FROM snapshots s LEFT JOIN containers c ON c.id = s.container_id
          WHERE s.id = ?`,
        snapshotId,
      );
      if (!snap || (!isAdmin && snap.user_id !== userId)) {
        throw new NotFoundError("Snapshot", snapshotId);
      }
      return snap;
    },

    async restoreSnapshot(id: number, snapshotId: number, userId: number, isAdmin = false): Promise<ContainerRow> {
      return withContainerLock(id, async () => {
      const row = await this.requireOwned(id, userId, isAdmin);
      const snap = await db.get<{ id: number; name: string; overlay_path: string; size_bytes: number }>(
        "SELECT id, name, overlay_path, size_bytes FROM snapshots WHERE id = ? AND container_id = ?",
        snapshotId,
        id,
      );
      if (!snap) throw new NotFoundError("Snapshot", snapshotId);
      await this._restoreFromSnapshot(row, snap);
      return (await this.requireById(id))!;
      });
    },

    /** Shared restore path: quiesce the current instance, restore overlay, start.
     *  On failure the row is marked stopped (the instance WAS stopped above and
     *  the executor may already have swapped the overlay) — leaving it "running"
     *  produced the classic zombie: every tool call fails with "instance not
     *  found" until a manual stop. */
    async _restoreFromSnapshot(row: ContainerRow, snap: { id: number; name: string; overlay_path: string; size_bytes?: number }): Promise<void> {
      const image = await images.requireById(row.image_id);
      // Stop current instance if running, then restore from snapshot overlay.
      if (row.status === "running") {
        try {
          await executor.stop(handleFromRow(row));
        } catch {
          // ignore
        }
      }
      try {
        const handle = await executor.restore(
          { id: `${row.instance_name}:${snap.name}`, overlayPath: snap.overlay_path, sizeBytes: 0 },
          {
            id: row.instance_name!,
            imagePath: resolveImagePath(image.sif_path),
            cpu: row.cpu,
            memoryMb: row.memory_mb,
            diskGb: row.disk_gb,
            env: decodeJson<Record<string, string>>(row.env ?? null, db.dialect as never) ?? undefined,
            ...(await this._replayMounts(row)),
          },
        );
        await db.run(
          "UPDATE containers SET status = 'running', overlay_path = ?, node = ?, last_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, error_message = NULL WHERE id = ?",
          handle.overlayPath,
          handle.node,
          row.id,
        );
        // P3-1: the restored overlay is now the current one; demote previous
        // overlay rows and record the new path.
        await db.run("UPDATE overlays SET is_current = 0 WHERE container_id = ?", row.id);
        await db.run(
          "INSERT INTO overlays (container_id, path, is_current, size_bytes) VALUES (?, ?, 1, ?)",
          row.id,
          handle.overlayPath,
          snap.size_bytes ?? 0,
        );
      } catch (err) {
        await db.run(
          "UPDATE containers SET status = 'stopped', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          `snapshot restore failed: ${(err as Error).message}`.slice(0, 500),
          row.id,
        ).catch(() => undefined);
        throw err;
      }
    },

    async deleteSnapshot(id: number, snapshotId: number, userId: number, isAdmin = false): Promise<void> {
      const row = await this.requireOwned(id, userId, isAdmin);
      const snap = await db.get<{ overlay_path: string }>(
        "SELECT overlay_path FROM snapshots WHERE id = ? AND container_id = ?",
        snapshotId,
        id,
      );
      // Free the disk copy too — deleting only the row leaked the full size.
      if (snap) {
        await executor.removePath(snap.overlay_path, row.node ?? undefined).catch((err) => {
          logger.warn({ snapshotId, err: (err as Error).message }, "deleteSnapshot: file cleanup failed (row still deleted)");
        });
      }
      await db.run("DELETE FROM snapshots WHERE id = ? AND container_id = ?", snapshotId, id);
    },

    /** Resolve the current handle for the tools routes (must be running). */
    async resolveRunningHandle(id: number, userId: number, isAdmin = false): Promise<{ row: ContainerRow; handle: ContainerHandle }> {
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status !== "running") throw new ContainerNotRunningError();
      return { row, handle: handleFromRow(row) };
    },

    /** Ownership helper: fetch + verify the container belongs to the user
     *  (admins may operate on any container). Returns 404 for non-owners to
     *  avoid leaking a container's existence. */
    async requireOwned(id: number, userId: number, isAdmin = false): Promise<ContainerRow> {
      const row = await this.requireById(id);
      if (!isAdmin && row.user_id !== userId) {
        // Distinguish "not found" from "forbidden" to avoid leaking existence.
        throw new NotFoundError("Container", id);
      }
      return row;
    },

    // ---- input/output mounts (docs/沙盒输入输出挂载设计.md) ----

    /** Resolve create-time mounts into executor bind dirs + persistable rows.
     *  Runs BEFORE the container row exists, so validation failures leave no
     *  side effects beyond the (empty) staging dir. */
    async _prepareMounts(
      userId: number,
      instanceName: string,
      containerName: string,
      mounts: CreateContainerInput["mounts"],
    ): Promise<{ mountDirs: { inputDir: string; outputDir?: string }; rows: Array<{ kind: "input" | "output"; workspaceId: number; relPath: string; name: string }> } | undefined> {
      if (!mounts || (!mounts.inputs?.length && !mounts.output)) return undefined;
      const caps = mountLimits();
      const inputs = mounts.inputs ?? [];
      if (inputs.length > caps.maxInputs) {
        throw new BadRequestError(`输入挂载项过多（>${caps.maxInputs}）`);
      }

      const stagingDir = await ensureInputDir(instanceName);
      const rows: Array<{ kind: "input" | "output"; workspaceId: number; relPath: string; name: string }> = [];
      let totalBytes = 0;
      for (const item of inputs) {
        const ws = await workspaces.requireOwned(item.workspaceId, userId);
        const src = await resolveInputSource(ws.user_id, ws.id, item.path);
        totalBytes += src.sizeBytes;
        if (totalBytes > caps.maxInputBytes) {
          throw new BadRequestError(`输入挂载总量超过 ${caps.maxInputBytes} 字节上限`);
        }
        const name = await materializeInput(src.hostPath, stagingDir, src.name);
        rows.push({ kind: "input", workspaceId: ws.id, relPath: item.path.replace(/^\/+/, ""), name });
      }

      let outputDir: string | undefined;
      if (mounts.output) {
        const ws = await workspaces.requireOwned(mounts.output.workspaceId, userId);
        outputDir = await ensureOutputDir(ws.user_id, ws.id, containerName);
        rows.push({ kind: "output", workspaceId: ws.id, relPath: outputRelDir(containerName), name: "output" });
      }

      // Inputs-only containers bind just /input; the RW /output bind only
      // exists when an output workspace was chosen.
      return { mountDirs: { inputDir: stagingDir, ...(outputDir ? { outputDir } : {}) }, rows };
    },

    /** Re-derive the bind dirs for a container that has persisted mounts.
     *  Called on EVERY start/restore so binds survive restarts. Returns
     *  undefined when the container has no mounts. */
    async _replayMounts(row: ContainerRow): Promise<{ inputDir: string; outputDir?: string } | undefined> {
      const rows = await db.all<{ kind: string; workspace_id: number; rel_path: string }>(
        "SELECT kind, workspace_id, rel_path FROM container_mounts WHERE container_id = ?",
        row.id,
      );
      if (rows.length === 0) return undefined;
      const inputDir = await ensureInputDir(row.instance_name!);
      const output = rows.find((r) => r.kind === "output");
      if (!output) return { inputDir };
      // Ownership may have changed hands only via admin flows; the row's
      // owner is the authority for the workspace path.
      const ws = await workspaces.requireOwned(output.workspace_id, row.user_id, true);
      const outputDir = await ensureOutputDir(ws.user_id, ws.id, row.name);
      // Security gate: the RW bind lets the container plant symlinks in the
      // workspace; refuse to restart into a poisoned output dir.
      await assertDirHasNoSymlinks(outputDir);
      return { inputDir, outputDir };
    },

    /** List a container's mounts (inputs + the output binding, if any). */
    async getMounts(containerId: number): Promise<ContainerMountRow[]> {
      return db.all<ContainerMountRow>(
        "SELECT id, container_id, kind, workspace_id, rel_path, name, created_at FROM container_mounts WHERE container_id = ? ORDER BY id",
        containerId,
      );
    },

    /** Add ONE input mount at runtime — materialize into the staging dir; the
     *  ro /input bind makes it visible in the container instantly (no restart).
     *  Allowed in any non-destroyed state. */
    async addInput(
      containerId: number,
      userId: number,
      item: { workspaceId: number; path: string },
      isAdmin = false,
    ): Promise<ContainerMountRow> {
      const row = await this.requireOwned(containerId, userId, isAdmin);
      if (row.status === "destroyed") throw new InvalidStateError("Cannot mount inputs on a destroyed container");
      if (!row.instance_name) throw new InvalidStateError("Container has no instance name");

      const caps = mountLimits();
      const existing = await this.getMounts(containerId);
      const inputRows = existing.filter((m) => m.kind === "input");
      if (inputRows.length >= caps.maxInputs) {
        throw new BadRequestError(`输入挂载项过多（>${caps.maxInputs}）：请先移除部分挂载`);
      }

      const ws = await workspaces.requireOwned(item.workspaceId, userId, isAdmin);
      const src = await resolveInputSource(ws.user_id, ws.id, item.path);
      const stagingDir = await ensureInputDir(row.instance_name);
      const usedBytes = await duBytes(stagingDir);
      if (usedBytes + src.sizeBytes > caps.maxInputBytes) {
        throw new BadRequestError(`输入挂载总量将超过 ${caps.maxInputBytes} 字节上限`);
      }
      const name = await materializeInput(src.hostPath, stagingDir, src.name);
      const result = await db.run(
        "INSERT INTO container_mounts (container_id, kind, workspace_id, rel_path, name) VALUES (?, 'input', ?, ?, ?)",
        containerId,
        ws.id,
        item.path.replace(/^\/+/, ""),
        name,
      );
      const mounted = await db.get<ContainerMountRow>(
        "SELECT id, container_id, kind, workspace_id, rel_path, name, created_at FROM container_mounts WHERE id = ?",
        Number(result.lastInsertRowid),
      );
      return mounted!;
    },

    /** Remove one input mount: delete the staging entry + the row. The item
     *  disappears from /input immediately (bind is live). */
    async removeInput(containerId: number, userId: number, mountId: number, isAdmin = false): Promise<void> {
      const row = await this.requireOwned(containerId, userId, isAdmin);
      const m = await db.get<ContainerMountRow>(
        "SELECT id, container_id, kind, workspace_id, rel_path, name, created_at FROM container_mounts WHERE id = ? AND container_id = ?",
        mountId,
        containerId,
      );
      if (!m || m.kind !== "input") throw new NotFoundError("Input mount", mountId);
      if (row.instance_name) {
        await removeStagingEntry(inputDir(row.instance_name), m.name);
      }
      await db.run("DELETE FROM container_mounts WHERE id = ?", mountId);
    },

    /** Open a relay connection session record (used by tools/routes). */
    async openSession(containerId: number, userId: number, clientIp?: string): Promise<number> {
      const result = await db.run(
        "INSERT INTO sessions (container_id, user_id, client_ip) VALUES (?, ?, ?)",
        containerId,
        userId,
        clientIp ?? null,
      );
      return Number(result.lastInsertRowid);
    },

    async closeSession(sessionId: number, bytesIn: number, bytesOut: number): Promise<void> {
      await db.run(
        "UPDATE sessions SET ended_at = CURRENT_TIMESTAMP, bytes_in = ?, bytes_out = ? WHERE id = ?",
        bytesIn,
        bytesOut,
        sessionId,
      );
    },

    /** Expose helpers for the routes layer. */
    _toPublic: (row: ContainerRow, isAdmin = false): ContainerPublic => toPublic(row, db.dialect, isAdmin),

    /** Archive the container's /workspace into the user's cloud workspace as a
     *  single .tar.gz (one-way export; the reverse direction is create-time
     *  seeding). Requires a binary-capable executor (local CLI); SSH falls
     *  back to erroring clearly instead of corrupting the archive. */
    async exportWorkspaceToUserWorkspace(
      containerId: number,
      userId: number,
      workspaceId: number,
      isAdmin = false,
      workspaceService: { uploadFile(wsId: number, ownerId: number, dirRel: string, name: string, content: Buffer, admin?: boolean): Promise<unknown> },
    ): Promise<{ fileName: string; sizeBytes: number }> {
      const row = await this.requireOwned(containerId, userId, isAdmin);
      if (row.status !== "running") throw new ContainerNotRunningError();
      if (typeof executor.execBuffer !== "function") {
        throw new Error("This executor cannot export binaries (local apptainer only)");
      }
      const handle = handleFromRow(row);
      // The archive is buffered before it is written into a workspace, so cap
      // it independently of the (much larger) per-file upload policy.
      const buf = await executor.execBuffer(handle, "tar czf - -C /workspace .", {
        maxBytes: Math.min(effectiveWorkspaceUploadMaxBytes(), loadConfig().workspace.exportMaxBytes),
      });
      if (buf.byteLength === 0) throw new Error("Export produced an empty archive");
      const fileName = `${row.name.replace(/[^a-zA-Z0-9_.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.tar.gz`;
      await workspaceService.uploadFile(workspaceId, userId, "", fileName, buf, isAdmin);
      return { fileName, sizeBytes: buf.byteLength };
    },
    _quotas: quotas,
    _images: images,
    _executor: executor,
  };
}

export type ContainerService = ReturnType<typeof createContainerService>;

/** Re-export for route use. */
export { ForbiddenError };
