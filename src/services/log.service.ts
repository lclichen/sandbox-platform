/**
 * Operation log service: audit trail for mutating actions.
 *
 * The audit middleware writes here on every write-method request; admin
 * routes query with filters. Logs are fire-and-forget: a logging failure must
 * not break the user's request.
 */
import type { Database, SqlValue } from "../db/driver.ts";
import { encodeJson } from "../db/driver.ts";

export interface LogRow {
  id: number;
  user_id: number | null;
  action: string;
  resource_type: string;
  resource_id: number | null;
  detail: unknown;
  ip: string | null;
  status: "success" | "failure";
  error_message: string | null;
  created_at: string;
}

export interface LogQuery {
  userId?: number;
  action?: string;
  resourceType?: string;
  resourceId?: number;
  status?: "success" | "failure";
  limit?: number;
  offset?: number;
}

export function createLogService(db: Database) {
  return {
    async record(entry: {
      userId?: number | null;
      action: string;
      resourceType: string;
      resourceId?: number | null;
      detail?: unknown;
      ip?: string | null;
      status?: "success" | "failure";
      errorMessage?: string | null;
    }): Promise<void> {
      try {
        await db.run(
          `INSERT INTO operation_logs
            (user_id, action, resource_type, resource_id, detail, ip, status, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          (entry.userId ?? null) as SqlValue,
          entry.action,
          entry.resourceType,
          (entry.resourceId ?? null) as SqlValue,
          encodeJson(entry.detail ?? null, db.dialect) as SqlValue,
          (entry.ip ?? null) as SqlValue,
          entry.status ?? "success",
          (entry.errorMessage ?? null) as SqlValue,
        );
      } catch (err) {
        // Never let audit failure break the request.
        // eslint-disable-next-line no-console
        console.warn("operation_logs write failed:", err);
      }
    },

    async list(query: LogQuery): Promise<{ logs: LogRow[]; total: number }> {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (query.userId !== undefined) {
        where.push("user_id = ?");
        params.push(query.userId);
      }
      if (query.action) {
        where.push("action LIKE ?");
        params.push(`%${query.action}%`);
      }
      if (query.resourceType) {
        where.push("resource_type = ?");
        params.push(query.resourceType);
      }
      if (query.resourceId !== undefined) {
        where.push("resource_id = ?");
        params.push(query.resourceId);
      }
      if (query.status) {
        where.push("status = ?");
        params.push(query.status);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM operation_logs ${clause}`, ...params);
      const limit = Math.min(query.limit ?? 50, 500);
      const offset = query.offset ?? 0;
      const rows = await db.all<Omit<LogRow, "detail"> & Record<string, unknown>>(
        `SELECT * FROM operation_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
      // detail: pg returns parsed object, sqlite returns JSON string -> best-effort parse.
      const logs: LogRow[] = rows.map((r) => {
        let detail: unknown = r.detail;
        if (db.dialect === "sqlite" && typeof detail === "string") {
          try {
            detail = JSON.parse(detail);
          } catch {
            // keep raw
          }
        }
        return { ...(r as Omit<LogRow, "detail">), detail };
      });
      return { logs, total: Number(total?.c ?? 0) };
    },
  };
}

export type LogService = ReturnType<typeof createLogService>;
