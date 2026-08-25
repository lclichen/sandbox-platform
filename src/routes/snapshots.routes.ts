/**
 * User-scoped snapshot routes: /api/v1/snapshots (any authenticated user).
 *
 *   GET    /                       list MY snapshots (incl. orphaned save
 *                                  points whose container was recycled)
 *   POST   /:sid/restore-container restore a snapshot into a BRAND-NEW
 *                                  container (image from the snapshot row)
 *   DELETE /:sid                   delete one of my snapshots
 *
 * The per-container variants (POST /containers/:id/snapshots/...) remain the
 * creation/in-place-restore path; these routes exist because snapshots now
 * OUTLIVE their containers (game save points, migration 0005).
 */
import { Router, type Request as ExpressRequest } from "express";
import { getDb, getExecutorFromReq } from "../app.ts";
import { createContainerService } from "../services/container.service.ts";
import { requireAuth, currentUserId, type AuthedRequest } from "../auth/middleware.ts";
import { UnauthorizedError } from "../utils/errors.ts";
import { idParamSchema } from "./schemas/common.ts";
import { validate } from "./validate.ts";

function actor(req: ExpressRequest): { id: number; isAdmin: boolean } {
  const user = (req as AuthedRequest).user;
  if (!user) throw new UnauthorizedError("Not authenticated");
  return { id: user.sub, isAdmin: user.role === "admin" };
}

export function snapshotsRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  router.get("/", (req, res, next) => {
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .listMySnapshots(currentUserId(req))
      .then((snapshots) => res.json({ snapshots }))
      .catch(next);
  });

  router.post("/:sid/restore-container", (req, res, next) => {
    const { id: sid } = validate(idParamSchema, { id: req.params.sid });
    const name =
      typeof req.body?.name === "string" && req.body.name.trim()
        ? req.body.name.trim()
        : `restore-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .restoreSnapshotToNewContainer(sid, a.id, name, a.isAdmin)
      .then((row) => {
        const pub = svc._toPublic(row, a.isAdmin);
        res.status(201).json(pub);
      })
      .catch(next);
  });

  router.delete("/:sid", (req, res, next) => {
    const { id: sid } = validate(idParamSchema, { id: req.params.sid });
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .deleteMySnapshot(sid, a.id, a.isAdmin)
      .then(() => res.status(204).end())
      .catch(next);
  });

  return router;
}
