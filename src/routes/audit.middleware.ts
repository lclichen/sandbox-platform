/**
 * Audit middleware: record mutating requests to operation_logs.
 *
 * Mounts after auth so req.user is populated. It derives the action name from
 * the HTTP method + route path and records the outcome after the response
 * finishes. Read-only requests (GET) are not logged to avoid noise; the
 * dedicated tools/bash calls are logged because they execute commands.
 *
 * Logging is best-effort: failures are swallowed by the log service.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getDb } from "../app.ts";
import { createLogService } from "../services/log.service.ts";
import type { AuthedRequest } from "../auth/middleware.ts";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Map a request to an audit descriptor. Returns null if the request should not
 * be audited (e.g. GET, or auth itself).
 *
 * Operates on req.path which, because this middleware is mounted at the app
 * level on /api/v1, looks like "/auth/login", "/containers/3/tools/bash",
 * "/admin/users/5", etc.
 */
function describe(req: Request): { action: string; resourceType: string; resourceId: number | null } | null {
  const path = req.path;
  if (path === "/auth/login" || path === "/auth/refresh" || path === "/auth/logout") {
    return { action: `auth.${path.split("/").pop()}`, resourceType: "auth", resourceId: null };
  }
  // tools/* under containers/:id/tools/:op
  if (path.includes("/tools/")) {
    const op = path.split("/tools/")[1]?.split("/")[0] ?? "unknown";
    const containerId = parseId(path.split("/containers/")[1]?.split("/")[0]);
    return { action: `container.tool.${op}`, resourceType: "container", resourceId: containerId };
  }
  const segments = path.split("/").filter(Boolean);
  // Drop the "admin" prefix segment if present (admin/users, admin/quotas...).
  const cleaned = segments[0] === "admin" ? segments.slice(1) : segments;
  const resourceMap: Record<string, string> = {
    users: "user",
    quotas: "quota",
    images: "image",
    containers: "container",
  };
  const head = cleaned[0] ?? "";
  const resourceType = resourceMap[head] ?? head.replace(/s$/, "");
  const id = parseId(cleaned[1]);
  const sub = cleaned.slice(2).join(".");
  const verb = methodVerb(req.method);
  const action = sub ? `${resourceType}.${sub}.${verb}` : `${resourceType}.${verb}`;
  return { action, resourceType, resourceId: id };
}

function methodVerb(method: string): string {
  switch (method) {
    case "POST": return "create";
    case "PUT":
    case "PATCH": return "update";
    case "DELETE": return "delete";
    default: return method.toLowerCase();
  }
}

function parseId(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

export function auditMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only audit mutating methods. (Tools/bash are POST, so they qualify.)
    if (!WRITE_METHODS.has(req.method)) {
      return next();
    }
    // The path here is relative to the router mount (e.g. "/", "/:id").
    const descriptor = describe(req);
    if (!descriptor) return next();

    // Defer logging until the response finishes so we know the status code.
    res.on("finish", () => {
      const user = (req as AuthedRequest).user;
      const status = res.statusCode < 400 ? "success" : "failure";
      const errorMessage = res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null;
      const log = createLogService(getDb(req));
      void log.record({
        userId: user?.sub ?? null,
        action: descriptor.action,
        resourceType: descriptor.resourceType,
        resourceId: descriptor.resourceId,
        detail: { method: req.method, path: req.path, status: res.statusCode },
        ip: req.ip ?? null,
        status,
        errorMessage,
      });
    });
    next();
  };
}
