/**
 * Resource quota service.
 *
 * Quotas cap per-user container counts and resource sizes. The container
 * service calls `assertCanCreate` before provisioning. Reference data only;
 * admin-managed.
 */
import type { Database, SqlValue } from "../db/driver.ts";
import { encodeJson, decodeJson } from "../db/driver.ts";
import { ConflictError, NotFoundError, QuotaExceededError, ImageNotAllowedError } from "../utils/errors.ts";
import { createUserService } from "./user.service.ts";

export interface QuotaRow {
  id: number;
  name: string;
  description: string | null;
  max_containers: number;
  max_cpu_cores: number;
  max_memory_mb: number;
  max_disk_gb: number;
  max_snapshots_per_container: number;
  max_workspaces_per_user: number;
  /** R6: image-id whitelist; null/empty = all public images allowed. */
  allowed_image_ids: number[] | null;
  created_at: string;
  updated_at: string;
}

export interface ResourceRequest {
  cpu: number;
  memory_mb: number;
  disk_gb: number;
}

/** Create input: every column except the optional workspace cap (defaults to 10)
 *  and an optional description (normalized to null by create()). */
export type QuotaCreateInput = Omit<
  QuotaRow,
  "id" | "created_at" | "updated_at" | "max_workspaces_per_user" | "description" | "allowed_image_ids"
> & {
  description?: string | null;
  max_workspaces_per_user?: number;
  allowed_image_ids?: number[] | null;
};

/** Decode a raw quota row: normalize allowed_image_ids JSON → number[] | null. */
function decodeRow(row: Record<string, unknown>, dialect: string): QuotaRow {
  const ids = decodeJson<unknown>(row.allowed_image_ids ?? null, dialect as never);
  return {
    ...(row as unknown as QuotaRow),
    allowed_image_ids: Array.isArray(ids)
      ? ids.map(Number).filter((n) => Number.isFinite(n))
      : null,
  };
}

export function createQuotaService(db: Database) {
  const users = createUserService(db);

  return {
    async getById(id: number): Promise<QuotaRow | null> {
      const row = await db.get<Record<string, unknown>>("SELECT * FROM resource_quotas WHERE id = ?", id);
      return row ? decodeRow(row, db.dialect) : null;
    },

    async getByName(name: string): Promise<QuotaRow | null> {
      const row = await db.get<Record<string, unknown>>("SELECT * FROM resource_quotas WHERE name = ?", name);
      return row ? decodeRow(row, db.dialect) : null;
    },

    async requireById(id: number): Promise<QuotaRow> {
      const row = await this.getById(id);
      if (!row) throw new NotFoundError("Quota", id);
      return row;
    },

    async list(): Promise<QuotaRow[]> {
      const rows = await db.all<Record<string, unknown>>("SELECT * FROM resource_quotas ORDER BY id");
      return rows.map((r) => decodeRow(r, db.dialect));
    },

    async create(input: QuotaCreateInput): Promise<QuotaRow> {
      const existing = await this.getByName(input.name);
      if (existing) throw new ConflictError(`Quota '${input.name}' already exists`);
      const result = await db.run(
        `INSERT INTO resource_quotas
          (name, description, max_containers, max_cpu_cores, max_memory_mb, max_disk_gb, max_snapshots_per_container, max_workspaces_per_user, allowed_image_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.name,
        input.description ?? null,
        input.max_containers,
        input.max_cpu_cores,
        input.max_memory_mb,
        input.max_disk_gb,
        input.max_snapshots_per_container,
        input.max_workspaces_per_user ?? 10,
        encodeJson(input.allowed_image_ids ?? null, db.dialect) as SqlValue,
      );
      return (await this.getById(Number(result.lastInsertRowid)))!;
    },

    async update(id: number, patch: Partial<Omit<QuotaRow, "id" | "name" | "created_at" | "updated_at">>): Promise<QuotaRow> {
      const current = await this.requireById(id);
      const sets: string[] = [];
      const values: SqlValue[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        sets.push(`${key} = ?`);
        values.push(key === "allowed_image_ids" ? (encodeJson(value ?? null, db.dialect) as SqlValue) : (value as SqlValue));
      }
      if (sets.length === 0) return current;
      values.push(id);
      await db.run(`UPDATE resource_quotas SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, ...values);
      return (await this.getById(id))!;
    },

    async delete(id: number): Promise<void> {
      // Prevent deletion if any user still references it.
      const inUse = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE quota_id = ?", id);
      if (Number(inUse?.c ?? 0) > 0) {
        throw new ConflictError("Quota is assigned to users; reassign them before deleting");
      }
      await db.run("DELETE FROM resource_quotas WHERE id = ?", id);
    },

    /** Resolve the effective quota for a user (default tier fallback). */
    async forUser(userId: number): Promise<QuotaRow> {
      const user = await users.getById(userId);
      if (user?.quota_id) {
        const q = await this.getById(user.quota_id);
        if (q) return q;
      }
      const def = await this.getByName("default");
      if (def) return def;
      throw new NotFoundError("Quota", "default");
    },

    /**
     * Enforce the user's quota against a new container request. Counts existing
     * non-destroyed containers and checks per-container size limits.
     */
    async assertCanCreate(userId: number, request: ResourceRequest): Promise<QuotaRow> {
      const quota = await this.forUser(userId);
      const usage = await db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM containers WHERE user_id = ? AND status != 'destroyed'",
        userId,
      );
      const used = Number(usage?.c ?? 0);
      if (used >= quota.max_containers) {
        throw new QuotaExceededError(
          `Container quota exceeded (${used}/${quota.max_containers})`,
          { used, limit: quota.max_containers },
        );
      }
      if (request.cpu > quota.max_cpu_cores) {
        throw new QuotaExceededError(`CPU ${request.cpu} exceeds quota ${quota.max_cpu_cores}`, { limit: quota.max_cpu_cores });
      }
      if (request.memory_mb > quota.max_memory_mb) {
        throw new QuotaExceededError(`Memory ${request.memory_mb}MB exceeds quota ${quota.max_memory_mb}MB`, { limit: quota.max_memory_mb });
      }
      if (request.disk_gb > quota.max_disk_gb) {
        throw new QuotaExceededError(`Disk ${request.disk_gb}GB exceeds quota ${quota.max_disk_gb}GB`, { limit: quota.max_disk_gb });
      }
      return quota;
    },

    /**
     * R6: enforce the quota's image whitelist. A public image is allowed when
     * the whitelist is null/empty; otherwise the image id must be listed.
     * Non-public images are never allowed via this path (admin-only concern).
     */
    async assertImageAllowed(userId: number, image: { id: number; is_public: boolean; name?: string }): Promise<void> {
      const quota = await this.forUser(userId);
      if (!image.is_public) {
        // Non-public images are reserved for admins (checked by the caller).
        return;
      }
      const whitelist = quota.allowed_image_ids;
      if (!whitelist || whitelist.length === 0) return;
      if (!whitelist.includes(image.id)) {
        throw new ImageNotAllowedError(
          `Image ${image.name ?? image.id} is not in the allowed image list for quota '${quota.name}'`,
          { imageId: image.id, quota: quota.name },
        );
      }
    },

    /**
     * Enforce the user's workspace-count quota against a new workspace.
     */
    async assertCanCreateWorkspace(userId: number): Promise<QuotaRow> {
      const quota = await this.forUser(userId);
      const usage = await db.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM workspaces WHERE user_id = ?",
        userId,
      );
      const used = Number(usage?.c ?? 0);
      if (used >= quota.max_workspaces_per_user) {
        throw new QuotaExceededError(
          `Workspace quota exceeded (${used}/${quota.max_workspaces_per_user})`,
          { used, limit: quota.max_workspaces_per_user },
        );
      }
      return quota;
    },

    /**
     * Enforce the user's AGGREGATE disk usage (manual §5.3): sum of overlay +
     * snapshot + workspace bytes must stay within max_disk_gb. `additionalBytes`
     * accounts for the resource about to be created (snapshot copy / upload).
     * Called before those creations commit.
     */
    async assertAggregateDisk(userId: number, additionalBytes = 0): Promise<void> {
      const quota = await this.forUser(userId);
      const row = await db.get<{ total: number | string }>(
        `SELECT
           COALESCE((SELECT SUM(o.size_bytes) FROM overlays o JOIN containers c ON o.container_id = c.id WHERE c.user_id = ?), 0)
           + COALESCE((SELECT SUM(s.size_bytes) FROM snapshots s JOIN containers c ON s.container_id = c.id WHERE c.user_id = ?), 0)
           + COALESCE((SELECT SUM(w.size_bytes) FROM workspaces w WHERE w.user_id = ?), 0) AS total`,
        userId,
        userId,
        userId,
      );
      const used = Number(row?.total ?? 0);
      const limitBytes = quota.max_disk_gb * 1024 * 1024 * 1024; // GiB convention
      if (used + additionalBytes > limitBytes) {
        throw new QuotaExceededError(
          `Aggregate disk quota exceeded (${(used + additionalBytes) / (1024 * 1024 * 1024)}GB of ${quota.max_disk_gb}GB)`,
          { used: used + additionalBytes, limit: limitBytes },
        );
      }
    },
  };
}

export type QuotaService = ReturnType<typeof createQuotaService>;
