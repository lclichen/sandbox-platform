/**
 * Resource quota service.
 *
 * Quotas cap per-user container counts and resource sizes. The container
 * service calls `assertCanCreate` before provisioning. Reference data only;
 * admin-managed.
 */
import type { Database, SqlValue } from "../db/driver.ts";
import { ConflictError, NotFoundError, QuotaExceededError } from "../utils/errors.ts";
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
  created_at: string;
  updated_at: string;
}

export interface ResourceRequest {
  cpu: number;
  memory_mb: number;
  disk_gb: number;
}

export function createQuotaService(db: Database) {
  const users = createUserService(db);

  return {
    async getById(id: number): Promise<QuotaRow | null> {
      return db.get<QuotaRow>("SELECT * FROM resource_quotas WHERE id = ?", id);
    },

    async getByName(name: string): Promise<QuotaRow | null> {
      return db.get<QuotaRow>("SELECT * FROM resource_quotas WHERE name = ?", name);
    },

    async requireById(id: number): Promise<QuotaRow> {
      const row = await this.getById(id);
      if (!row) throw new NotFoundError("Quota", id);
      return row;
    },

    async list(): Promise<QuotaRow[]> {
      return db.all<QuotaRow>("SELECT * FROM resource_quotas ORDER BY id");
    },

    async create(input: Omit<QuotaRow, "id" | "created_at" | "updated_at">): Promise<QuotaRow> {
      const existing = await this.getByName(input.name);
      if (existing) throw new ConflictError(`Quota '${input.name}' already exists`);
      const result = await db.run(
        `INSERT INTO resource_quotas
          (name, description, max_containers, max_cpu_cores, max_memory_mb, max_disk_gb, max_snapshots_per_container)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.name,
        input.description ?? null,
        input.max_containers,
        input.max_cpu_cores,
        input.max_memory_mb,
        input.max_disk_gb,
        input.max_snapshots_per_container,
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
        values.push(value as SqlValue);
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
  };
}

export type QuotaService = ReturnType<typeof createQuotaService>;
