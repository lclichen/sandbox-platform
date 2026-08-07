/**
 * Container routes: /api/v1/containers (any authenticated user, scoped to own).
 *
 *   POST   /                    create + start a container
 *   GET    /                    list my containers
 *   GET    /:id                 get my container
 *   POST   /:id/start           start a stopped container
 *   POST   /:id/stop            stop a running container
 *   DELETE /:id                 destroy a container
 *   POST   /:id/snapshots       create a snapshot
 *   GET    /:id/snapshots       list snapshots
 *   POST   /:id/snapshots/:sid/restore   restore from snapshot
 *   DELETE /:id/snapshots/:sid  delete a snapshot
 *   GET    /:id/connect         return connection info (instance + node)
 */
import { Router, type Request } from "express";
import { getDb, getExecutorFromReq } from "../app.ts";
import { createContainerService } from "../services/container.service.ts";
import { requireAuth, currentUserId, type AuthedRequest } from "../auth/middleware.ts";
import { UnauthorizedError } from "../utils/errors.ts";
import {
  createContainerSchema,
  listContainersSchema,
  createSnapshotSchema,
  idParamSchema,
} from "./schemas/common.ts";
import { validate } from "./validate.ts";

/** Current user as an actor: id plus whether they hold the admin role. */
function actor(req: Request): { id: number; isAdmin: boolean } {
  const user = (req as AuthedRequest).user;
  if (!user) throw new UnauthorizedError("Not authenticated");
  return { id: user.sub, isAdmin: user.role === "admin" };
}

export function containersRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  router.post("/", (req, res, next) => {
    const body = validate(createContainerSchema, req.body);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .create(currentUserId(req), body)
      .then((row) => res.status(201).json(svc._toPublic(row, a.isAdmin)))
      .catch(next);
  });

  router.get("/", (req, res, next) => {
    const query = validate(listContainersSchema, req.query);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .list(currentUserId(req), query)
      .then((rows) => res.json({ containers: rows.map((r) => svc._toPublic(r, a.isAdmin)) }))
      .catch(next);
  });

  router.get("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .requireOwned(id, a.id, a.isAdmin)
      .then((row) => res.json(svc._toPublic(row, a.isAdmin)))
      .catch(next);
  });

  router.post("/:id/start", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .start(id, a.id, a.isAdmin)
      .then((row) => res.json(svc._toPublic(row, a.isAdmin)))
      .catch(next);
  });

  router.post("/:id/stop", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .stop(id, a.id, a.isAdmin)
      .then((row) => res.json(svc._toPublic(row, a.isAdmin)))
      .catch(next);
  });

  router.delete("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .destroy(id, a.id, a.isAdmin)
      .then(() => res.status(204).end())
      .catch(next);
  });

  router.post("/:id/snapshots", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(createSnapshotSchema, req.body);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .snapshot(id, a.id, body.name, body.description, a.isAdmin)
      .then((snap) => res.status(201).json(snap))
      .catch(next);
  });

  router.get("/:id/snapshots", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .listSnapshots(id, a.id, a.isAdmin)
      .then((rows) => res.json({ snapshots: rows }))
      .catch(next);
  });

  router.post("/:id/snapshots/:sid/restore", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const sid = Number.parseInt(req.params.sid, 10);
    if (Number.isNaN(sid)) {
      res.status(400).json({ code: "bad_request", message: "Invalid snapshot id" });
      return;
    }
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .restoreSnapshot(id, sid, actor(req).id, actor(req).isAdmin)
      .then((row) => res.json(svc._toPublic(row, actor(req).isAdmin)))
      .catch(next);
  });

  router.delete("/:id/snapshots/:sid", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const sid = Number.parseInt(req.params.sid, 10);
    if (Number.isNaN(sid)) {
      res.status(400).json({ code: "bad_request", message: "Invalid snapshot id" });
      return;
    }
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .deleteSnapshot(id, sid, actor(req).id, actor(req).isAdmin)
      .then(() => res.status(204).end())
      .catch(next);
  });

  router.get("/:id/connect", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const svc = createContainerService(getDb(req), getExecutorFromReq(req));
    svc
      .resolveRunningHandle(id, a.id, a.isAdmin)
      .then(async ({ row, handle }) => {
        const sessionId = await svc.openSession(id, a.id, req.ip);
        res.json({
          sessionId,
          containerId: row.id,
          instanceName: row.instance_name,
          node: handle.node,
          executor: handle.id,
          // Hint to clients: tool operations go via /api/v1/containers/:id/tools/*.
          toolsBase: `/api/v1/containers/${row.id}/tools`,
        });
        // The connect handshake is instantaneous; settle the session record so
        // accounting does not accumulate open rows (P2-3). Long-lived relay
        // traffic is accounted by the tools bash/stream session.
        void svc.closeSession(sessionId, 0, 0).catch(() => {
          /* best-effort */
        });
      })
      .catch(next);
  });

  return router;
}
