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
import { uploadPartMaxBytes } from "../services/workspace-storage.ts";

/** Raw-body parser for chunked-upload parts (bounded per request body). */
const rawPart = Router().put(
  "/:id/uploads/:uid",
  (req, res, next) => {
    // A single part is capped at 8 MiB (the client is told partBytesMax by
    // POST /uploads). The session total is enforced in workspace-storage on
    // every part write, not only at completion.
    const max = uploadPartMaxBytes();
    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      chunks.push(chunk);
      received += chunk.byteLength;
      if (received > max) {
        rejected = true;
        chunks.length = 0;
        res.status(413).json({ code: "UPLOAD_TOO_LARGE", message: `part exceeds ${max} bytes` });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (rejected) return;
      req.body = Buffer.concat(chunks);
      next();
    });
    req.on("error", (err) => {
      if (rejected) return;
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
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      // Admin cross-user listing (pi-web admin panel); non-admins stay scoped
      // regardless of the flag.
      .list(a.isAdmin && query.all ? undefined : currentUserId(req), query)
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

  // Single-file upload. The body is streamed to disk (never buffered): a
  // 2 GiB upload must not allocate 2 GiB in the platform heap. The service
  // enforces the per-file cap while streaming and runs the aggregate-disk
  // quota check before the staging file is renamed into place.
  router.post("/:id/files", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const dirRel = normalizePath(req.query.path);
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) {
      res.status(400).json({ code: "BAD_REQUEST", message: "Missing 'name' query parameter" });
      return;
    }
    if (req.is("application/json")) {
      // express.json() already consumed the body; streaming it now would
      // silently write an empty file.
      res.status(400).json({
        code: "BAD_REQUEST",
        message: "Workspace uploads must use a raw body (application/octet-stream), not JSON",
      });
      return;
    }
    const rawLength = req.headers["content-length"];
    const contentLength = typeof rawLength === "string" ? Number.parseInt(rawLength, 10) : undefined;
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .uploadFileStream(
        id,
        a.id,
        dirRel === "/" ? "" : dirRel,
        name,
        req,
        Number.isFinite(contentLength) ? contentLength : undefined,
        a.isAdmin,
      )
      .then((result) => res.status(201).json(result))
      .catch(next);
  });

  router.get("/:id/files/content", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const validated = validate(workspacePathSchema, { path: normalizePath(req.query.path) });
    const a = actor(req);
    const svc = createWorkspaceService(getDb(req));
    svc
      .downloadFileInfo(id, a.id, validated.path, a.isAdmin)
      .then(({ absPath, size, filename }) => {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader("Content-Length", String(size));
        // sendFile streams from disk (and supports Range) instead of loading
        // the whole file into the request handler.
        res.sendFile(absPath, (err) => {
          if (!err) return;
          if (res.headersSent) {
            res.destroy(err);
            return;
          }
          next(err);
        });
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
      // 204 must carry no body (Node silently dropped the .json() payload, so
      // clients have always seen a bare 204 — keep that wire behavior).
      .then(() => res.status(204).end())
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
