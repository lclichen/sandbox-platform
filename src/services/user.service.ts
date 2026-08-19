/**
 * User service: CRUD + password + status operations.
 *
 * Admin-only mutating operations; any authenticated user can read its own
 * profile (handled in auth routes /me). R1 adds a `pending` status used by the
 * approval register mode; R9 adds must_change_password.
 */
import type { Database, SqlValue } from "../db/driver.ts";
import { hashPassword } from "../auth/password.ts";
import { ConflictError, NotFoundError, InvalidStateError } from "../utils/errors.ts";

export type UserStatus = "active" | "disabled" | "pending";

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  email: string | null;
  role: "admin" | "user";
  quota_id: number | null;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  must_change_password: boolean | number;
}

export interface UserPublic {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user";
  quota_id: number | null;
  status: UserStatus;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

export function toPublic(row: UserRow): UserPublic {
  // Omit password_hash; normalize sqlite 0/1 to boolean.
  const { password_hash: _omit, must_change_password: raw, ...rest } = row;
  void _omit;
  return { ...rest, must_change_password: Number(raw) === 1 || raw === true };
}

export function createUserService(db: Database) {
  return {
    async getById(id: number): Promise<UserRow | null> {
      return db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    },

    async getByUsername(username: string): Promise<UserRow | null> {
      return db.get<UserRow>("SELECT * FROM users WHERE username = ?", username);
    },

    async list(
      opts: { limit?: number; offset?: number; search?: string; status?: UserStatus } = {},
    ): Promise<UserRow[]> {
      const limit = Math.min(opts.limit ?? 50, 200);
      const offset = opts.offset ?? 0;
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (opts.search) {
        where.push("(username LIKE ? OR email LIKE ?)");
        params.push(`%${opts.search}%`, `%${opts.search}%`);
      }
      if (opts.status) {
        where.push("status = ?");
        params.push(opts.status);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return db.all<UserRow>(
        `SELECT * FROM users ${clause} ORDER BY id LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
    },

    async count(search?: string, status?: UserStatus): Promise<number> {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (search) {
        where.push("(username LIKE ? OR email LIKE ?)");
        params.push(`%${search}%`, `%${search}%`);
      }
      if (status) {
        where.push("status = ?");
        params.push(status);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const row = await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM users ${clause}`, ...params);
      return Number(row?.c ?? 0);
    },

    async create(input: {
      username: string;
      password: string;
      email?: string;
      role?: "admin" | "user";
      quota_id?: number;
      /** R1: "pending" parks the account until an admin approves it. */
      status?: UserStatus;
      /** R9: force a password change on first login. */
      mustChangePassword?: boolean;
    }): Promise<UserRow> {
      const existing = await this.getByUsername(input.username);
      if (existing) throw new ConflictError(`Username '${input.username}' already exists`);
      const passwordHash = await hashPassword(input.password);
      const result = await db.run(
        `INSERT INTO users (username, password_hash, email, role, quota_id, status, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.username,
        passwordHash,
        input.email ?? null,
        input.role ?? "user",
        input.quota_id ?? null,
        input.status ?? "active",
        input.mustChangePassword ? 1 : 0,
      );
      const created = await this.getById(Number(result.lastInsertRowid));
      if (!created) throw new Error("User insert returned no row");
      return created;
    },

    /** R1: activate a pending account (admin approval). */
    async approve(id: number): Promise<UserRow> {
      const row = await this.getById(id);
      if (!row) throw new NotFoundError("User", id);
      if (row.status !== "pending") {
        throw new InvalidStateError(`Cannot approve a user in '${row.status}' state`);
      }
      await db.run(
        "UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        id,
      );
      return (await this.getById(id))!;
    },

    async update(
      id: number,
      patch: Partial<Pick<UserRow, "email" | "role" | "quota_id" | "status">>,
    ): Promise<UserRow> {
      const current = await this.getById(id);
      if (!current) throw new NotFoundError("User", id);
      const sets: string[] = [];
      const values: SqlValue[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        sets.push(`${key} = ?`);
        values.push(value as SqlValue);
      }
      if (sets.length === 0) return current;
      values.push(id);
      await db.run(`UPDATE users SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, ...values);
      const updated = await this.getById(id);
      return updated!;
    },

    /**
     * Set a new password hash. `clearMustChange` (R9) also clears the
     * must_change_password flag so the account stops being gated.
     */
    async setPassword(id: number, newPassword: string, clearMustChange = false): Promise<void> {
      const current = await this.getById(id);
      if (!current) throw new NotFoundError("User", id);
      const passwordHash = await hashPassword(newPassword);
      await db.run(
        clearMustChange
          ? "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          : "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        passwordHash,
        id,
      );
    },

    async touchLogin(id: number): Promise<void> {
      await db.run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", id);
    },

    async delete(id: number): Promise<void> {
      const current = await this.getById(id);
      if (!current) throw new NotFoundError("User", id);
      await db.run("DELETE FROM users WHERE id = ?", id);
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
