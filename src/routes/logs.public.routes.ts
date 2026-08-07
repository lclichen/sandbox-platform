/**
 * Per-user operation log routes: /api/v1/logs (any authenticated user)
 *
 *   GET /   list the current user's own operation logs (filters: action,
 *           resourceType, resourceId, status, limit, offset)
 *
 * The userId is ALWAYS forced to the current user, so a user can only ever see
 * their own trail. Admins use /api/v1/admin/logs for cross-user queries.
 */
import { Router } from "express";
import { getDb } from "../app.ts";
import { createLogService } from "../services/log.service.ts";
import { requireAuth, currentUserId } from "../auth/middleware.ts";
import { paginationSchema } from "./schemas/common.ts";
import { validate } from "./validate.ts";
import { z } from "zod";

const myLogsQuerySchema = paginationSchema.extend({
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.coerce.number().int().optional(),
  status: z.enum(["success", "failure"]).optional(),
});

export function publicLogsRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  router.get("/", (req, res, next) => {
    const query = validate(myLogsQuerySchema, req.query);
    createLogService(getDb(req))
      .list({ ...query, userId: currentUserId(req) }) // force-scoped to self
      .then((result) => res.json(result))
      .catch(next);
  });

  return router;
}
