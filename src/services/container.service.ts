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
import { createImageService } from "./image.service.ts";
import { createWorkspaceService } from "./workspace.service.ts";
import {
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
  BadRequestError,
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

function toPublic(row: ContainerRow, dialect: string): ContainerPublic {
  const { env: _env, ...rest } = row;
  void _env;
  return { ...rest, env: decodeJson<Record<string, string>>(row.env ?? null, dialect as never) ?? null };
}

export interface CreateContainerInput {
  imageId: number;
  name: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  env?: Record<string, string>;
  workspaceId?: number;
}

export function createContainerService(db: Database, executor: SandboxExecutor) {
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

    /** List containers for a user (admins can pass userId=undefined to list all). */
    async list(userId: number | undefined, opts: { limit?: number; offset?: number; status?: string } = {}): Promise<ContainerRow[]> {
      const limit = Math.min(opts.limit ?? 50, 200);
      const offset = opts.offset ?? 0;
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (userId !== undefined) {
        where.push("user_id = ?");
        params.push(userId);
      }
      if (opts.status) {
        where.push("status = ?");
        params.push(opts.status);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return db.all<ContainerRow>(
        `SELECT * FROM containers ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
    },

    async create(userId: number, input: CreateContainerInput): Promise<ContainerRow> {
      const image = await images.requireById(input.imageId);
      const defaults = image.default_resources ?? { cpu: 1, memoryMb: 1024, diskGb: 5 };
      const request: ResourceRequest = {
        cpu: input.cpu ?? defaults.cpu,
        memory_mb: input.memoryMb ?? defaults.memoryMb,
        disk_gb: input.diskGb ?? defaults.diskGb,
      };
      // Enforce quota before any provisioning.
      await quotas.assertCanCreate(userId, request);

      const instanceName = `sb-${nanoid(12)}`;
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
        encodeJson(input.env ?? null, db.dialect) as SqlValue,
      );
      const containerId = Number(result.lastInsertRowid);

      // Resolve an optional workspace to seed /workspace from. Ownership is
      // enforced via requireOwned (404 for non-owners). The host path is passed
      // to the executor which decides how to apply it (cp or bind-mount).
      let seedFromPath: string | undefined;
      if (input.workspaceId !== undefined) {
        const ws = await workspaces.requireOwned(input.workspaceId, userId);
        seedFromPath = workspaces.hostDir(ws);
      }

      try {
        const handle = await executor.create({
          id: instanceName,
          imagePath: image.sif_path,
          cpu: request.cpu,
          memoryMb: request.memory_mb,
          diskGb: request.disk_gb,
          env: input.env,
          seedFromPath,
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
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status === "running") return row;
      if (row.status === "destroyed") throw new InvalidStateError("Cannot start a destroyed container");
      // Reaper semantics: an auto-released container resumes from its most
      // recent auto-tier snapshot (the state at release time) instead of the
      // current overlay, then the marker is cleared.
      if (row.auto_stopped && row.status === "stopped") {
        const snap = await db.get<{ id: number; name: string; overlay_path: string }>(
          "SELECT id, name, overlay_path FROM snapshots WHERE container_id = ? AND name LIKE ? ORDER BY id DESC LIMIT 1",
          id,
          "auto-%",
        );
        await db.run(
          "UPDATE containers SET auto_stopped = 0, auto_stopped_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          id,
        );
        if (snap) {
          await this._restoreFromSnapshot(row, snap);
          return (await this.requireById(id))!;
        }
        // No snapshot to resume from — fall through to a plain overlay start.
      }
      const image = await images.requireById(row.image_id);
      const handle = await executor.create({
        id: row.instance_name!,
        imagePath: image.sif_path,
        cpu: row.cpu,
        memoryMb: row.memory_mb,
        diskGb: row.disk_gb,
      });
      await db.run(
        "UPDATE containers SET status = 'running', overlay_path = ?, node = ?, last_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, error_message = NULL WHERE id = ?",
        handle.overlayPath,
        handle.node,
        id,
      );
      return (await this.requireById(id))!;
    },

    async stop(id: number, userId: number, isAdmin = false): Promise<ContainerRow> {
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status !== "running") throw new InvalidStateError(`Cannot stop a container in '${row.status}' state`);
      const handle = handleFromRow(row);
      await executor.stop(handle);
      await persistRunningState(db, id, false);
      return (await this.requireById(id))!;
    },

    async destroy(id: number, userId: number, isAdmin = false): Promise<void> {
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
        // eslint-disable-next-line no-console
        console.warn("executor destroy error:", err);
      }
      await db.run(
        "UPDATE containers SET status = 'destroyed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        id,
      );
    },

    async snapshot(id: number, userId: number, name: string, description?: string, isAdmin = false, opts: { restartAfter?: boolean } = {}): Promise<{ id: number; name: string; sizeBytes: number }> {
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status === "destroyed") throw new InvalidStateError("Cannot snapshot a destroyed container");
      const quota = await quotas.forUser(userId);
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
      try {
        const snap = await executor.snapshot(handle, name);
        const result = await db.run(
          `INSERT INTO snapshots (container_id, name, description, overlay_path, size_bytes)
           VALUES (?, ?, ?, ?, ?)`,
          id,
          name,
          description ?? null,
          snap.overlayPath,
          snap.sizeBytes,
        );
        return { id: Number(result.lastInsertRowid), name, sizeBytes: snap.sizeBytes };
      } finally {
        if (wasRunning && opts.restartAfter !== false) {
          try {
            await executor.start(handle);
          } catch (err) {
            logger.warn({ id, err: (err as Error).message }, "snapshot: restart after copy failed");
          }
        }
      }
    },

    async listSnapshots(id: number, userId: number, isAdmin = false) {
      await this.requireOwned(id, userId, isAdmin);
      return db.all<{ id: number; name: string; description: string | null; size_bytes: number; created_at: string }>(
        "SELECT id, name, description, size_bytes, created_at FROM snapshots WHERE container_id = ? ORDER BY id DESC",
        id,
      );
    },

    async restoreSnapshot(id: number, snapshotId: number, userId: number, isAdmin = false): Promise<ContainerRow> {
      const row = await this.requireOwned(id, userId, isAdmin);
      const snap = await db.get<{ id: number; name: string; overlay_path: string }>(
        "SELECT id, name, overlay_path FROM snapshots WHERE id = ? AND container_id = ?",
        snapshotId,
        id,
      );
      if (!snap) throw new NotFoundError("Snapshot", snapshotId);
      await this._restoreFromSnapshot(row, snap);
      return (await this.requireById(id))!;
    },

    /** Shared restore path: quiesce the current instance, restore overlay, start. */
    async _restoreFromSnapshot(row: ContainerRow, snap: { id: number; name: string; overlay_path: string }): Promise<void> {
      const image = await images.requireById(row.image_id);
      // Stop current instance if running, then restore from snapshot overlay.
      if (row.status === "running") {
        try {
          await executor.stop(handleFromRow(row));
        } catch {
          // ignore
        }
      }
      const handle = await executor.restore(
        { id: `${row.instance_name}:${snap.name}`, overlayPath: snap.overlay_path, sizeBytes: 0 },
        {
          id: row.instance_name!,
          imagePath: image.sif_path,
          cpu: row.cpu,
          memoryMb: row.memory_mb,
          diskGb: row.disk_gb,
          env: decodeJson<Record<string, string>>(row.env ?? null, db.dialect as never) ?? undefined,
        },
      );
      await db.run(
        "UPDATE containers SET status = 'running', overlay_path = ?, node = ?, last_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        handle.overlayPath,
        handle.node,
        row.id,
      );
    },

    async deleteSnapshot(id: number, snapshotId: number, userId: number, isAdmin = false): Promise<void> {
      await this.requireOwned(id, userId, isAdmin);
      await db.run("DELETE FROM snapshots WHERE id = ? AND container_id = ?", snapshotId, id);
    },

    /** Resolve the current handle for the tools routes (must be running). */
    async resolveRunningHandle(id: number, userId: number, isAdmin = false): Promise<{ row: ContainerRow; handle: ContainerHandle }> {
      const row = await this.requireOwned(id, userId, isAdmin);
      if (row.status !== "running") throw new InvalidStateError("Container is not running");
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
    _toPublic: (row: ContainerRow): ContainerPublic => toPublic(row, db.dialect),
    _quotas: quotas,
    _images: images,
    _executor: executor,
  };
}

export type ContainerService = ReturnType<typeof createContainerService>;

/** Re-export for route use. */
export { ForbiddenError };
