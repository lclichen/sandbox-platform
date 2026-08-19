/**
 * Workspace routes: /api/v1/workspaces (any authenticated user, scoped to own).
 *
 *   POST   /                         create a workspace
 *   GET    /                         list my workspaces
 *   GET    /:id                      get my workspace
 *   PATCH  /:id                      update metadata (name/description/isTemplate)
 *   DELETE /:id                      delete a workspace (and its files)
 *   GET    /:id/files?path=          list files in a directory
 *   POST   /:id/files?path=&name=    upload a file (octet-stream body)
 *   GET    /:id/files/content?path=  download a file
 *   DELETE /:id/files?path=          delete a file or directory
 *   POST   /:id/dirs?path=           create a directory
 *   GET    /:id/tree?path=&depth=&cursor=  recursive tree in one request (R5)
 *   POST   /:id/files/move           move/rename a file or directory (R5)
 *   POST   /:id/uploads              start a chunked upload (R5)
 *   PUT    /:id/uploads/:uid?part=N  send one raw part (R5)
 *   POST   /:id/uploads/:uid/complete  finalize into a workspace file (R5)
 *   DELETE /:id/uploads/:uid         abort + discard parts (R5)
 *
 * File uploads use a single raw octet-stream body (no multipart) to avoid
 * pulling in multer; the filename is provided via the `name` query parameter.
 */
import { Router, type Request } from "express";
import { getDb } from "../app.ts";
import { loadConfig } from "../config.ts";
import { createWorkspaceService } from "../services/workspace.service.ts";
import { requireAuth, currentUserId, type AuthedRequest } from "../auth/middleware.ts";
import { UnauthorizedError } from "../utils/errors.ts";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  listWorkspacesSchema,
  idParamSchema,
  workspacePathSchema,
  moveFileSchema,
  initUploadSchema,
} from "./schemas/common.ts";
import { validate } from "./validate.ts";

/**
 * Raw-body parser for single-file uploads. The global express.json() middleware
 * only parses application/json, so octet-stream requests arrive with an empty
 * body; this handler populates req.body with the raw Buffer. Capped at the
 * configured per-file limit (WORKSPACE_UPLOAD_MAX_BYTES, default 200 MiB).
 */
const rawUpload = Router().post(
  "/:id/files",
  (req, _res, next) => {
    // Collect the raw body manually; works regardless of Content-Type.
    const max = loadConfig().workspace.uploadMaxBytes;
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.byteLength;
      if (received > max) {
        req.destroy(new Error("upload too large"));
      }
    });
    req.on("end", () => {
      req.body = Buffer.concat(chunks);
      next();
    });
    req.on("error", (err) => {
      next(err);
    });
  },
);

/** Raw-body parser for chunked-upload parts (bounded per request body). */
const rawPart = Router().put(
  "/:id/uploads/:uid",
  (req, _res, next) => {
    // A part can reasonably be as large as the whole per-file cap; the total
    // across parts is enforced again at completion.
    const max = loadConfig().workspace.uploadMaxBytes;
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.byteLength;
      if (received > max) {
        req.destroy(new Error("part too large"));
      }
    });
    req.on("end", () => {
      req.body = Buffer.concat(chunks);
      next();
    });
    req.on("error", (err) => {
      next(err);
    });
  },
);

/** Current user as an actor: id plus whether they hold the admin role. */
function actor(req: Request): { id: number; isAdmin: boolean } {
  const user = (req as AuthedRequest).user;
  if (!user) throw new UnauthorizedError("Not authenticated");
  return { id: user.sub, isAdmin: user.role === "admin" };
}

/** Normalize a `path` query param: missing/empty means the workspace root. */
function normalizePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  return value;
}

export function workspacesRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  // ---- metadata CRUD ----

  router.post("/", (req, res, next) => {
    const body = validate(createWorkspaceSchema, req.body);
    const svc = createWorkspaceService(getDb(req));
    svc
      .create(currentUserId(req), body)
      .then((row) => res.status(201).json(row))
      .catch(next);
  });

  router.get("/", (req, res, next) => {
    const query = validate(listWorkspacesSchema, req.query);
    const svc = createWorkspaceService(getDb(req));
    svc
      .list(currentUserId(req), query)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.get("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .requireOwned(id, a.id, a.isAdmin)
      .then((row) => res.json(row))
      .catch(next);
  });

  router.patch("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(updateWorkspaceSchema, req.body);
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .update(id, a.id, body, a.isAdmin)
      .then((row) => res.json(row))
      .catch(next);
  });

  router.delete("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .delete(id, a.id, a.isAdmin)
      .then(() => res.status(204).end())
      .catch(next);
  });

  // ---- file operations ----

  router.get("/:id/files", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const path = normalizePath(req.query.path);
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .listFiles(id, a.id, path, a.isAdmin)
      .then((entries) => res.json({ path, entries }))
      .catch(next);
  });

  // Raw-body upload: the rawUpload middleware collects the octet-stream body
  // before this handler runs. Mount it on the same path so it intercepts.
  router.post("/:id/files", rawUpload, (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const dirRel = normalizePath(req.query.path);
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) {
      res.status(400).json({ code: "BAD_REQUEST", message: "Missing 'name' query parameter" });
      return;
    }
    const content = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .uploadFile(id, a.id, dirRel === "/" ? "" : dirRel, name, content, a.isAdmin)
      .then((result) => res.status(201).json(result))
      .catch(next);
  });

  router.get("/:id/files/content", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const validated = validate(workspacePathSchema, { path: normalizePath(req.query.path) });
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .downloadFile(id, a.id, validated.path, a.isAdmin)
      .then(({ buffer, filename }) => {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader("Content-Length", String(buffer.byteLength));
        res.send(buffer);
      })
      .catch(next);
  });

  router.delete("/:id/files", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const validated = validate(workspacePathSchema, { path: normalizePath(req.query.path) });
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .deleteFile(id, a.id, validated.path, a.isAdmin)
      .then(() => res.status(204).end())
      .catch(next);
  });

  router.post("/:id/dirs", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const validated = validate(workspacePathSchema, { path: normalizePath(req.query.path) });
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .makeDir(id, a.id, validated.path, a.isAdmin)
      .then((result) => res.status(201).json(result))
      .catch(next);
  });

  // ---- R5: tree / move / chunked uploads ----

  router.get("/:id/tree", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const a = actor(req);
    const depthRaw = Number.parseInt(String(req.query.depth ?? ""), 10);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const svc = createWorkspaceService(getDb(req));
    svc
      .tree(
        id,
        a.id,
        normalizePath(req.query.path),
        {
          ...(Number.isFinite(depthRaw) ? { depth: depthRaw } : {}),
          ...(cursor ? { cursor } : {}),
        },
        a.isAdmin,
      )
      .then((result) => res.json(result))
      .catch(next);
  });

  router.post("/:id/files/move", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(moveFileSchema, req.body);
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .moveFile(id, a.id, body.path, body.to, a.isAdmin)
      .then((result) => res.json(result))
      .catch(next);
  });

  router.post("/:id/uploads", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(initUploadSchema, req.body);
    const dirRel = normalizePath(req.query.path);
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .startUpload(
        id,
        a.id,
        {
          name: body.name,
          dirRel: dirRel === "/" ? "" : dirRel,
          ...(body.size !== undefined ? { size: body.size } : {}),
        },
        a.isAdmin,
      )
      .then((result) => res.status(201).json(result))
      .catch(next);
  });

  router.put("/:id/uploads/:uid", rawPart, (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const uid = String(req.params.uid ?? "");
    const part = Number.parseInt(String(req.query.part ?? ""), 10);
    if (!Number.isInteger(part) || part < 1) {
      res.status(400).json({ code: "BAD_REQUEST", message: "part query parameter (integer >= 1) is required" });
      return;
    }
    const content = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .uploadPart(id, a.id, uid, part, content, a.isAdmin)
      .then((result) => res.status(204).json(result))
      .catch(next);
  });

  router.post("/:id/uploads/:uid/complete", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const uid = String(req.params.uid ?? "");
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .completeUpload(id, a.id, uid, a.isAdmin)
      .then((result) => res.status(201).json(result))
      .catch(next);
  });

  router.delete("/:id/uploads/:uid", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const uid = String(req.params.uid ?? "");
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .abortUpload(id, a.id, uid, a.isAdmin)
      .then(() => res.status(204).end())
      .catch(next);
  });

  return router;
}
