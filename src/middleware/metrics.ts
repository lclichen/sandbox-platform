/**
 * Prometheus metrics (P2-2).
 *
 * Exposes a shared registry with process defaults plus a few platform-relevant
 * gauges/counters:
 *   sandbox_http_requests_total        (method, path, status)
 *   sandbox_http_request_duration_seconds (method, path)
 *   sandbox_containers_running         (refreshed at scrape time)
 *
 * NOTE: the `path` label uses req.path (may contain ids) — acceptable for an
 * internal platform; normalize in front of Prometheus if cardinality hurts.
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

const containersRunning = new Gauge({
  name: "sandbox_containers_running",
  help: "Containers currently in the running state",
  registers: [registry],
});

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
export async function metricsHandler(db: { get<T = Record<string, unknown>>(sql: string): Promise<T | null> }): Promise<string> {
  const row = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM containers WHERE status = 'running'");
  containersRunning.set(Number(row?.c ?? 0));
  return registry.metrics();
}
