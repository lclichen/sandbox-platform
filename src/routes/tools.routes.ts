/**
 * Tools routes: /api/v1/containers/:id/tools/*
 *
 * Relay point for the pi extension's built-in tool routing. All routes are
 * authenticated and scoped to the calling user's own running container.
 *
 *   POST /read        { path }                      -> { contentBase64, size }
 *   POST /write       { path, content(base64) }     -> { size }
 *   POST /edit        { path, oldText, newText }    -> { applied, size }
 *   GET  /access?path=                              -> { exists }
 *   GET  /stat?path=                                -> { isDirectory, isFile, size, mtimeMs }
 *   GET  /ls?path=                                   -> { entries: [{name,...}] }
 *   POST /bash       { command, cwd?, timeout?, env? } -> { stdout, stderr, exitCode, timedOut, truncated }
 *   POST /bash/stream  { command, cwd?, timeout? }    -> SSE event stream of bash output
 *   POST /grep       { pattern, path?, ... }        -> { output }
 *   POST /find       { pattern, path?, limit? }     -> { results: string[] }
 */
import { Router, type Response } from "express";
import { getDb, getExecutorFromReq } from "../app.ts";
import { createToolsService } from "../services/tools.service.ts";
import { requireAuth, currentUserId, type AuthedRequest } from "../auth/middleware.ts";
import {
  readToolSchema,
  writeToolSchema,
  editToolSchema,
  bashToolSchema,
  grepToolSchema,
  findToolSchema,
  idParamSchema,
} from "./schemas/common.ts";
import { validate } from "./validate.ts";

export function toolsRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  router.post("/:id/tools/read", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const { path } = validate(readToolSchema, req.body);
    createToolsService(getDb(req), getExecutorFromReq(req))
      .read(id, currentUserId(req), path)
      .then((r) => res.json(r))
      .catch(next);
  });

  router.post("/:id/tools/write", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const { path, content } = validate(writeToolSchema, req.body);
    createToolsService(getDb(req), getExecutorFromReq(req))
      .write(id, currentUserId(req), path, content)
      .then((r) => res.json(r))
      .catch(next);
  });

  router.post("/:id/tools/edit", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(editToolSchema, req.body);
    createToolsService(getDb(req), getExecutorFromReq(req))
      .edit(id, currentUserId(req), body.path, body.oldText, body.newText)
      .then((r) => res.json(r))
      .catch(next);
  });

  router.get("/:id/tools/access", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const path = String(req.query.path ?? "");
    if (!path) {
      res.status(400).json({ code: "bad_request", message: "path is required" });
      return;
    }
    createToolsService(getDb(req), getExecutorFromReq(req))
      .access(id, currentUserId(req), path)
      .then((r) => res.json(r))
      .catch(next);
  });

  router.get("/:id/tools/stat", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const path = String(req.query.path ?? "");
    if (!path) {
      res.status(400).json({ code: "bad_request", message: "path is required" });
      return;
    }
    createToolsService(getDb(req), getExecutorFromReq(req))
      .stat(id, currentUserId(req), path)
      .then((r) => res.json(r))
      .catch(next);
  });

  router.get("/:id/tools/ls", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const path = String(req.query.path ?? ".");
    createToolsService(getDb(req), getExecutorFromReq(req))
      .ls(id, currentUserId(req), path)
      .then((entries) => res.json({ entries }))
      .catch(next);
  });

  router.post("/:id/tools/bash", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(bashToolSchema, req.body);
    createToolsService(getDb(req), getExecutorFromReq(req))
      .bash(id, currentUserId(req), body.command, { cwd: body.cwd, timeout: body.timeout, env: body.env })
      .then((r) => res.json(r))
      .catch(next);
  });

  // SSE streaming bash. Client posts the command and reads the event stream;
  // POST (not GET) so the audit middleware captures the command and the body
  // stays out of URLs/server logs.
  router.post("/:id/tools/bash/stream", (req, res: Response, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(bashToolSchema, req.body);
    const { command, cwd, timeout } = body;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    (async () => {
      const tools = createToolsService(getDb(req), getExecutorFromReq(req));
      try {
        const { handle } = await tools.containers.resolveRunningHandle(id, currentUserId(req));
        const executor = getExecutorFromReq(req);
        const result = await executor.exec(handle, command, {
          cwd,
          timeout,
          onData: (chunk: Buffer) => {
            res.write(`event: data\ndata: ${JSON.stringify({ chunk: chunk.toString("base64") })}\n\n`);
          },
        });
        res.write(
          `event: end\ndata: ${JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut })}\n\n`,
        );
      } catch (err) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`,
        );
      } finally {
        res.end();
      }
    })().catch(next);
  });

  router.post("/:id/tools/grep", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(grepToolSchema, req.body);
    createToolsService(getDb(req), getExecutorFromReq(req))
      .grep(id, currentUserId(req), body)
      .then((output) => res.json({ output }))
      .catch(next);
  });

  router.post("/:id/tools/find", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(findToolSchema, req.body);
    createToolsService(getDb(req), getExecutorFromReq(req))
      .find(id, currentUserId(req), body)
      .then((results) => res.json({ results }))
      .catch(next);
  });

  return router;
}

export type { AuthedRequest };
