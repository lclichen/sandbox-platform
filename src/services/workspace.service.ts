/**
 * Workspace service: per-user persistent file storage that seeds a container's
 * /workspace on create and survives container destroy.
 *
 * A workspace is a DB row (metadata) plus a host directory under
 * WORKSPACE_BASE_DIR. The directory layout is `user-<userId>/ws-<wsId>/`. All
 * host-FS work is delegated to workspace-storage.ts which enforces path
 * containment (no traversal escape).
 *
 * Ownership follows the apikey.service pattern: every method takes a userId,
 * SQL is scoped with `WHERE user_id = ?`, and cross-user access returns 404
 * (NotFoundError) rather than 403 to avoid leaking existence.
 */
import type { Database, SqlValue } from "../db/driver.ts";
import { createQuotaService } from "./quota.service.ts";
import { NotFoundError, ConflictError, BadRequestError } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { loadConfig } from "../config.ts";
import { nanoid } from "nanoid";
import * as storage from "./workspace-storage.ts";
import type { WorkspaceFileEntry } from "./workspace-storage.ts";

export interface WorkspaceRow {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  storage_path: string;
  size_bytes: number;
  file_count: number;
  source_container_id: number | null;
  is_template: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  isTemplate?: boolean;
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string | null;
  isTemplate?: boolean;
}

function toBool(v: unknown, dialect: string): boolean {
  if (dialect === "sqlite") return Number(v) === 1;
  return Boolean(v);
}

export function createWorkspaceService(db: Database) {
  const quotas = createQuotaService(db);

  /** Decode a raw row into the public WorkspaceRow shape (normalize booleans). */
  function decode(row: Record<string, unknown>): WorkspaceRow {
    return {
      id: Number(row.id),
      user_id: Number(row.user_id),
      name: String(row.name),
      description: (row.description as string | null) ?? null,
      storage_path: String(row.storage_path),
      size_bytes: Number(row.size_bytes ?? 0),
      file_count: Number(row.file_count ?? 0),
      source_container_id:
        row.source_container_id == null ? null : Number(row.source_container_id),
      is_template: toBool(row.is_template, db.dialect),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  /** Recompute size_bytes + file_count from disk and persist. */
  async function refreshStats(id: number, userId: number): Promise<void> {
    const stats = await storage.statWorkspace(userId, id);
    await db.run(
      "UPDATE workspaces SET size_bytes = ?, file_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      stats.sizeBytes,
      stats.fileCount,
      id,
    );
  }

  return {
    async getById(id: number, userId: number, isAdmin = false): Promise<WorkspaceRow | null> {
      const row = await db.get<Record<string, unknown>>(
        "SELECT * FROM workspaces WHERE id = ?",
        id,
      );
      if (!row) return null;
      const ws = decode(row);
      if (!isAdmin && ws.user_id !== userId) return null;
      return ws;
    },

    /** Ownership helper: 404 for non-owners to avoid leaking existence. */
    async requireOwned(id: number, userId: number, isAdmin = false): Promise<WorkspaceRow> {
      const ws = await this.getById(id, userId, isAdmin);
      if (!ws) throw new NotFoundError("Workspace", id);
      return ws;
    },

    async list(
      userId: number,
      opts: { limit?: number; offset?: number; search?: string } = {},
    ): Promise<{ total: number; workspaces: WorkspaceRow[] }> {
      const limit = Math.min(opts.limit ?? 50, 200);
      const offset = opts.offset ?? 0;
      const where: string[] = ["user_id = ?"];
      const params: SqlValue[] = [userId];
      if (opts.search) {
        where.push("name LIKE ?");
        params.push(`%${opts.search}%`);
      }
      const clause = where.join(" AND ");
      const totalRow = await db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM workspaces WHERE ${clause}`,
        ...params,
      );
      const rows = await db.all<Record<string, unknown>>(
        `SELECT * FROM workspaces WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
      return { total: Number(totalRow?.c ?? 0), workspaces: rows.map(decode) };
    },

    async create(userId: number, input: CreateWorkspaceInput): Promise<WorkspaceRow> {
      // Quota first (before any FS or DB work).
      await quotas.assertCanCreateWorkspace(userId);
      // Name uniqueness per-user.
      const dup = await db.get<{ id: number }>(
        "SELECT id FROM workspaces WHERE user_id = ? AND name = ?",
        userId,
        input.name,
      );
      if (dup) throw new ConflictError(`Workspace '${input.name}' already exists`);

      const result = await db.run(
        `INSERT INTO workspaces (user_id, name, description, storage_path, is_template)
         VALUES (?, ?, ?, ?, ?)`,
        userId,
        input.name,
        input.description ?? null,
        // Placeholder; corrected with the real id-driven path below.
        `user-${userId}/ws-pending`,
        input.isTemplate ? 1 : 0,
      );
      const id = Number(result.lastInsertRowid);
      const storagePath = `user-${userId}/ws-${id}`;
      // Create the directory and stamp the canonical storage_path.
      await storage.ensureWorkspaceDir(userId, id);
      await db.run(
        "UPDATE workspaces SET storage_path = ? WHERE id = ?",
        storagePath,
        id,
      );
      return (await this.getById(id, userId))!;
    },

    async update(
      id: number,
      userId: number,
      patch: UpdateWorkspaceInput,
      isAdmin = false,
    ): Promise<WorkspaceRow> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      const sets: string[] = [];
      const values: SqlValue[] = [];
      if (patch.name !== undefined && patch.name !== ws.name) {
        // Uniqueness check on rename.
        const dup = await db.get<{ id: number }>(
          "SELECT id FROM workspaces WHERE user_id = ? AND name = ? AND id != ?",
          ws.user_id,
          patch.name,
          id,
        );
        if (dup) throw new ConflictError(`Workspace '${patch.name}' already exists`);
        sets.push("name = ?");
        values.push(patch.name);
      }
      if (patch.description !== undefined) {
        sets.push("description = ?");
        values.push(patch.description);
      }
      if (patch.isTemplate !== undefined) {
        sets.push("is_template = ?");
        values.push(patch.isTemplate ? 1 : 0);
      }
      if (sets.length === 0) return ws;
      values.push(id);
      await db.run(
        `UPDATE workspaces SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ...values,
      );
      return (await this.getById(id, userId, isAdmin))!;
    },

    async delete(id: number, userId: number, isAdmin = false): Promise<void> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      // Best-effort FS cleanup; DB row is removed regardless.
      try {
        await storage.removeWorkspaceDir(ws.user_id, id);
      } catch (err) {
        logger.warn({ err, workspaceId: id }, "workspace dir removal failed (row still deleted)");
      }
      await db.run("DELETE FROM workspaces WHERE id = ?", id);
    },

    // ---- file operations (all routed through workspace-storage for containment) ----

    async listFiles(
      id: number,
      userId: number,
      rel: string,
      isAdmin = false,
    ): Promise<WorkspaceFileEntry[]> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      const entries = await storage.listFiles(ws.user_id, id, rel);
      // Refresh stats opportunistically (cheap-ish; only on listings of the root).
      if (rel === "" || rel === "/" || rel === ".") {
        void refreshStats(id, ws.user_id).catch(() => {
          /* ignore stat refresh failures */
        });
      }
      return entries;
    },

    async uploadFile(
      id: number,
      userId: number,
      dirRel: string,
      filename: string,
      content: Buffer,
      isAdmin = false,
    ): Promise<{ path: string; size: number }> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
        throw new BadRequestError("Invalid filename");
      }
      // Avoid path-component tricks: build the target as dirRel/filename and
      // let resolveInWorkspace's containment check do the final enforcement.
      const rel = dirRel ? `${dirRel.replace(/\/+$/, "")}/${filename}` : filename;
      // P2-5: the upload must stay within the user's aggregate disk ceiling.
      await quotas.assertAggregateDisk(userId, content.byteLength);
      await storage.writeFile(ws.user_id, id, rel, content);
      await refreshStats(id, ws.user_id);
      return { path: rel, size: content.byteLength };
    },

    async downloadFile(
      id: number,
      userId: number,
      rel: string,
      isAdmin = false,
    ): Promise<{ buffer: Buffer; filename: string }> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      const buffer = await storage.readFile(ws.user_id, id, rel);
      const filename = rel.split("/").pop() ?? "download";
      return { buffer, filename };
    },

    async deleteFile(
      id: number,
      userId: number,
      rel: string,
      isAdmin = false,
    ): Promise<void> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      await storage.deleteFile(ws.user_id, id, rel);
      await refreshStats(id, ws.user_id);
    },

    async makeDir(
      id: number,
      userId: number,
      rel: string,
      isAdmin = false,
    ): Promise<{ path: string }> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      if (!rel || rel === "/" || rel === ".") {
        throw new BadRequestError("Directory path is required");
      }
      await storage.makeDir(ws.user_id, id, rel);
      return { path: rel.replace(/^\/+/, "") };
    },

    /** Resolve the host directory path for a workspace (used by container.service to seed). */
    hostDir(ws: WorkspaceRow): string {
      return storage.workspaceDir(ws.user_id, ws.id);
    },

    // ---- R5: recursive tree, move, chunked uploads ----

    /** One-request recursive tree (depth-capped, ignore-listed, cursor-paged). */
    async tree(
      id: number,
      userId: number,
      rel: string,
      opts: { depth?: number; cursor?: string } = {},
      isAdmin = false,
    ): Promise<{ root: string; entries: storage.TreeEntry[]; truncated: boolean; nextCursor?: string }> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      const cfg = loadConfig();
      const depth = Math.min(Math.max(opts.depth ?? 8, 1), 32);
      const result = await storage.walkTree(ws.user_id, id, rel, {
        ignore: cfg.workspace.treeIgnore,
        maxDepth: depth,
        maxEntries: 5000,
        ...(opts.cursor ? { afterPath: opts.cursor } : {}),
      });
      return { root: rel === "/" ? "" : rel.replace(/^\/+|\/+$/g, ""), ...result };
    },

    /** Move/rename a file or directory (mv semantics for `to`). */
    async moveFile(
      id: number,
      userId: number,
      fromRel: string,
      toRel: string,
      isAdmin = false,
    ): Promise<{ path: string }> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      const result = await storage.move(ws.user_id, id, fromRel, toRel);
      void refreshStats(id, ws.user_id).catch(() => {});
      return result;
    },

    /** Start a chunked upload session; sweeps stale sessions opportunistically. */
    async startUpload(
      id: number,
      userId: number,
      input: { name: string; dirRel: string; size?: number },
      isAdmin = false,
    ): Promise<{ uploadId: string; partBytesMax: number; maxBytes: number }> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      if (!input.name || input.name.includes("/") || input.name.includes("\\") || input.name.includes("\0")) {
        throw new BadRequestError("Invalid filename");
      }
      const cfg = loadConfig();
      if (input.size !== undefined && input.size > cfg.workspace.uploadMaxBytes) {
        throw new BadRequestError(
          `File exceeds the per-file limit of ${cfg.workspace.uploadMaxBytes} bytes`,
        );
      }
      void storage.sweepStaleUploads(cfg.workspace.uploadTtlHours).catch(() => {});
      const uploadId = nanoid(16);
      await storage.createUpload({
        uploadId,
        userId: ws.user_id,
        wsId: id,
        name: input.name,
        dirRel: input.dirRel.replace(/\/+$/, ""),
        ...(input.size !== undefined ? { size: input.size } : {}),
      });
      // Part cap 8 MiB keeps a single request body bounded; sessions may span
      // as many parts as needed up to the total cap enforced at completion.
      return { uploadId, partBytesMax: 8 * 1024 * 1024, maxBytes: cfg.workspace.uploadMaxBytes };
    },

    /** Append one part to a session. The session must belong to this user. */
    async uploadPart(
      id: number,
      userId: number,
      uploadId: string,
      part: number,
      content: Buffer,
      isAdmin = false,
    ): Promise<{ part: number; received: number }> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      const meta = await storage.readUpload(uploadId);
      if (!meta || meta.wsId !== id || meta.userId !== ws.user_id) {
        throw new NotFoundError("Upload session", uploadId);
      }
      const received = await storage.writeUploadPart(uploadId, part, content);
      return { part, received };
    },

    /** Concatenate parts, enforce size + disk quota, write the final file. */
    async completeUpload(
      id: number,
      userId: number,
      uploadId: string,
      isAdmin = false,
    ): Promise<{ path: string; size: number }> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      const meta = await storage.readUpload(uploadId);
      if (!meta || meta.wsId !== id || meta.userId !== ws.user_id) {
        throw new NotFoundError("Upload session", uploadId);
      }
      const cfg = loadConfig();
      const parts = await storage.collectUploadParts(uploadId);
      const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
      if (total > cfg.workspace.uploadMaxBytes) {
        await storage.removeUpload(uploadId).catch(() => {});
        throw new BadRequestError(
          `Upload exceeds the per-file limit of ${cfg.workspace.uploadMaxBytes} bytes`,
        );
      }
      const rel = meta.dirRel ? `${meta.dirRel}/${meta.name}` : meta.name;
      await quotas.assertAggregateDisk(ws.user_id, total);
      await storage.writeFile(ws.user_id, id, rel, Buffer.concat(parts));
      await storage.removeUpload(uploadId).catch(() => {});
      await refreshStats(id, ws.user_id);
      return { path: rel, size: total };
    },

    /** Abort a session and discard its parts. */
    async abortUpload(id: number, userId: number, uploadId: string, isAdmin = false): Promise<void> {
      const ws = await this.requireOwned(id, userId, isAdmin);
      const meta = await storage.readUpload(uploadId);
      if (!meta || meta.wsId !== id || meta.userId !== ws.user_id) {
        throw new NotFoundError("Upload session", uploadId);
      }
      await storage.removeUpload(uploadId);
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
