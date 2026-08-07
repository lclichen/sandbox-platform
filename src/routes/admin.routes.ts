/**
 * Admin routes: /api/v1/admin (admin only)
 *
 *   GET /logs            query operation_logs (filters: userId, action,
 *                        resourceType, resourceId, status, limit, offset)
 *   GET /dashboard       platform summary counts (users, containers by status,
 *                        images, recent failures)
 */
import { Router } from "express";
import { getDb, getExecutorFromReq } from "../app.ts";
import { createLogService } from "../services/log.service.ts";
import { createContainerService } from "../services/container.service.ts";
import { requireAdmin } from "../auth/middleware.ts";
import { paginationSchema } from "./schemas/common.ts";
import { validate } from "./validate.ts";
import { z } from "zod";

const logsQuerySchema = paginationSchema.extend({
  userId: z.coerce.number().int().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.coerce.number().int().optional(),
  status: z.enum(["success", "failure"]).optional(),
});

export function adminRouter(): Router {
  const router = Router();
  router.use(requireAdmin());

  router.get("/logs", (req, res, next) => {
    const query = validate(logsQuerySchema, req.query);
    createLogService(getDb(req))
      .list(query)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.get("/dashboard", async (req, res, next) => {
    try {
      const db = getDb(req);
      // Recent-failures threshold: compute in JS so it works on both dialects.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [users, containersByStatus, images, recentFailures, runningContainers] = await Promise.all([
        db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users"),
        db.all<{ status: string; c: number }>("SELECT status, COUNT(*) AS c FROM containers GROUP BY status"),
        db.get<{ c: number }>("SELECT COUNT(*) AS c FROM images"),
        db.get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM operation_logs WHERE status = 'failure' AND created_at > ?",
          since,
        ),
        db.get<{ c: number }>("SELECT COUNT(*) AS c FROM containers WHERE status = 'running'"),
      ]);
      res.json({
        users: Number(users?.c ?? 0),
        images: Number(images?.c ?? 0),
        runningContainers: Number(runningContainers?.c ?? 0),
        recentFailures24h: Number(recentFailures?.c ?? 0),
        containersByStatus: Object.fromEntries(containersByStatus.map((r) => [r.status, Number(r.c)])),
        executor: getExecutorFromReq(req).kind,
        dialect: db.dialect,
      });
    } catch (err) {
      next(err);
    }
  });

  // Admin view of all containers (not scoped to a user).
  router.get("/containers", (req, res, next) => {
    const query = validate(paginationSchema, req.query);
    createContainerService(getDb(req), getExecutorFromReq(req))
      .list(undefined, query)
      .then((rows) => {
        const svc = createContainerService(getDb(req), getExecutorFromReq(req));
        res.json({ containers: rows.map((r) => svc._toPublic(r, true)) });
      })
      .catch(next);
  });

  return router;
}
