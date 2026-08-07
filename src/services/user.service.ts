/**
 * User service: CRUD + password + status operations.
 *
 * Admin-only mutating operations; any authenticated user can read its own
 * profile (handled in auth routes /me).
 */
import type { Database, SqlValue } from "../db/driver.ts";
import { hashPassword } from "../auth/password.ts";
import { ConflictError, NotFoundError } from "../utils/errors.ts";

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  email: string | null;
  role: "admin" | "user";
  quota_id: number | null;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface UserPublic {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user";
  quota_id: number | null;
  status: "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
}

export function toPublic(row: UserRow): UserPublic {
  // Omit password_hash.
  const { password_hash: _omit, ...rest } = row;
  void _omit;
  return rest;
}

export function createUserService(db: Database) {
  return {
    async getById(id: number): Promise<UserRow | null> {
      return db.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    },

    async getByUsername(username: string): Promise<UserRow | null> {
      return db.get<UserRow>("SELECT * FROM users WHERE username = ?", username);
    },

    async list(opts: { limit?: number; offset?: number; search?: string } = {}): Promise<UserRow[]> {
      const limit = Math.min(opts.limit ?? 50, 200);
      const offset = opts.offset ?? 0;
      if (opts.search) {
        return db.all<UserRow>(
          "SELECT * FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY id LIMIT ? OFFSET ?",
          `%${opts.search}%`,
          `%${opts.search}%`,
          limit,
          offset,
        );
      }
      return db.all<UserRow>("SELECT * FROM users ORDER BY id LIMIT ? OFFSET ?", limit, offset);
    },

    async count(search?: string): Promise<number> {
      const row = search
        ? await db.get<{ c: number }>(
            "SELECT COUNT(*) AS c FROM users WHERE username LIKE ? OR email LIKE ?",
            `%${search}%`,
            `%${search}%`,
          )
        : await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users");
      return Number(row?.c ?? 0);
    },

    async create(input: {
      username: string;
      password: string;
      email?: string;
      role?: "admin" | "user";
      quota_id?: number;
    }): Promise<UserRow> {
      const existing = await this.getByUsername(input.username);
      if (existing) throw new ConflictError(`Username '${input.username}' already exists`);
      const passwordHash = await hashPassword(input.password);
      const result = await db.run(
        `INSERT INTO users (username, password_hash, email, role, quota_id, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        input.username,
        passwordHash,
        input.email ?? null,
        input.role ?? "user",
        input.quota_id ?? null,
      );
      const created = await this.getById(Number(result.lastInsertRowid));
      if (!created) throw new Error("User insert returned no row");
      return created;
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

    async setPassword(id: number, newPassword: string): Promise<void> {
      const current = await this.getById(id);
      if (!current) throw new NotFoundError("User", id);
      const passwordHash = await hashPassword(newPassword);
      await db.run("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", passwordHash, id);
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
