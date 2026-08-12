/**
 * Prometheus metrics (P2-2).
 *
 * Exposes a shared registry with process defaults plus platform-relevant
 * gauges/counters:
 *   sandbox_http_requests_total          (method, path, status)
 *   sandbox_http_request_duration_seconds (method, path)
 *   sandbox_containers_by_status         (status)  — refreshed at scrape
 *   sandbox_users_total                              — refreshed at scrape
 *   sandbox_workspaces_total                         — refreshed at scrape
 *   sandbox_reaper_reclaimed_total       — incremented by the reaper sweep
 *   sandbox_litellm_health               — 1 healthy / 0 down / -1 disabled
 *
 * The reaper and LLM gauges are updated by their respective callers; the DB
 * gauges are refreshed on each scrape inside {@link metricsHandler}.
 *
 * NOTE: the `path` label uses req.route?.path when available (the registered
 * pattern, e.g. "/:id") falling back to req.path. Behind routers req.route is
 * often undefined, so ids may still leak; normalize in front of Prometheus if
 * cardinality hurts.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";
import type { RequestHandler, Request, Response } from "express";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpRequests = new Counter({
  name: "sandbox_http_requests_total",
  help: "Total HTTP requests handled by the platform",
  labelNames: ["method", "path", "status"] as const,
  registers: [registry],
});

const httpDuration = new Histogram({
  name: "sandbox_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "path"] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const containersByStatus = new Gauge({
  name: "sandbox_containers_by_status",
  help: "Container count grouped by status",
  labelNames: ["status"] as const,
  registers: [registry],
});

const usersTotal = new Gauge({
  name: "sandbox_users_total",
  help: "Total platform users",
  registers: [registry],
});

const workspacesTotal = new Gauge({
  name: "sandbox_workspaces_total",
  help: "Total workspaces",
  registers: [registry],
});

const reaperReclaimed = new Counter({
  name: "sandbox_reaper_reclaimed_total",
  help: "Containers reclaimed by the idle reaper",
  registers: [registry],
});

const litellmHealth = new Gauge({
  name: "sandbox_litellm_health",
  help: "LiteLLM proxy health: 1 up, 0 down, -1 disabled",
  registers: [registry],
});

/** Record a reaper reclaim (called from scheduler/reaper.ts). */
export function recordReaperReclaim(count = 1): void {
  reaperReclaimed.inc(count);
}

/** Record the LiteLLM health probe result (called from app.ts /ready + scrape). */
export function recordLitellmHealth(state: "up" | "down" | "disabled"): void {
  litellmHealth.set(state === "up" ? 1 : state === "down" ? 0 : -1);
}

/** Middleware: time + count every request (labels resolved on finish). */
export function metricsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const path = req.route?.path ?? req.path;
      httpRequests.inc({ method: req.method, path, status: String(res.statusCode) });
      httpDuration.observe({ method: req.method, path }, seconds);
    });
    next();
  };
}

/** Scrape handler: refresh DB-derived gauges, then dump the registry. */
export async function metricsHandler(db: {
  get<T = Record<string, unknown>>(sql: string): Promise<T | null>;
  all<T = Record<string, unknown>>(sql: string): Promise<T[]>;
}): Promise<string> {
  const statusRows = await db.all<{ status: string; c: number }>(
    "SELECT status, COUNT(*) AS c FROM containers GROUP BY status",
  );
  // Reset then set so a status that drops to zero is still emitted as 0.
  containersByStatus.reset();
  for (const r of statusRows) {
    containersByStatus.set({ status: r.status }, Number(r.c));
  }
  const users = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users");
  usersTotal.set(Number(users?.c ?? 0));
  const workspaces = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM workspaces");
  workspacesTotal.set(Number(workspaces?.c ?? 0));
  return registry.metrics();
}
