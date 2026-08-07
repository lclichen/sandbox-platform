/**
 * Auth routes: /api/v1/auth
 *
 *   POST /login        { username, password } -> { accessToken, refreshToken, expiresIn, user }
 *   POST /refresh      { refreshToken }        -> { accessToken, refreshToken, expiresIn }
 *   POST /logout       { refreshToken }        -> 204
 *   GET  /me                                  -> { user }                       (requires auth)
 *   GET  /dashboard                            -> current user's own summary     (requires auth)
 */
import { Router } from "express";
import { z } from "zod";
import { getDb } from "../app.ts";
import { createAuthService } from "../services/auth.service.ts";
import { createUserService, toPublic } from "../services/user.service.ts";
import { createApiKeyService } from "../services/apikey.service.ts";
import { requireAuth, currentUserId, type AuthedRequest } from "../auth/middleware.ts";
import { loginSchema, refreshSchema, idParamSchema } from "./schemas/common.ts";
import { validate } from "./validate.ts";

export function authRouter(): Router {
  const router = Router();

  router.post("/login", (req, res, next) => {
    const body = validate(loginSchema, req.body);
    const auth = createAuthService(getDb(req));
    auth
      .login(body.username, body.password, req.ip)
      .then(({ user, ...pair }) => res.json({ ...pair, user: toPublic(user) }))
      .catch(next);
  });

  router.post("/refresh", (req, res, next) => {
    const body = validate(refreshSchema, req.body);
    const auth = createAuthService(getDb(req));
    auth
      .refresh(body.refreshToken, req.ip)
      .then((pair) => res.json(pair))
      .catch(next);
  });

  router.post("/logout", (req, res, next) => {
    const body = validate(refreshSchema, req.body);
    const auth = createAuthService(getDb(req));
    auth
      .logout(body.refreshToken)
      .then(() => res.status(204).end())
      .catch(next);
  });

  router.get("/me", requireAuth(), (req, res, next) => {
    const users = createUserService(getDb(req));
    users
      .getById(currentUserId(req))
      .then((user) => {
        if (!user) {
          res.status(404).json({ code: "not_found", message: "User not found" });
          return;
        }
        res.json({ user: toPublic(user) });
      })
      .catch(next);
  });

  // Per-user dashboard: aggregates scoped to the current user. Admins use
  // /admin/dashboard for the global view; this endpoint is for regular users.
  router.get("/dashboard", requireAuth(), async (req, res, next) => {
    try {
      const db = getDb(req);
      const uid = currentUserId(req);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [total, running, byStatus, failures] = await Promise.all([
        db.get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM containers WHERE user_id = ? AND status != 'destroyed'",
          uid,
        ),
        db.get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM containers WHERE user_id = ? AND status = 'running'",
          uid,
        ),
        db.all<{ status: string; c: number }>(
          "SELECT status, COUNT(*) AS c FROM containers WHERE user_id = ? GROUP BY status",
          uid,
        ),
        db.get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM operation_logs WHERE user_id = ? AND status = 'failure' AND created_at > ?",
          uid,
          since,
        ),
      ]);
      res.json({
        myContainers: Number(total?.c ?? 0),
        runningContainers: Number(running?.c ?? 0),
        recentFailures24h: Number(failures?.c ?? 0),
        containersByStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.c)])),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- API keys (personal long-lived credentials) ----
  const createKeySchema = z.object({ name: z.string().min(1).max(128) });

  router.post("/api-keys", requireAuth(), (req, res, next) => {
    const { name } = validate(createKeySchema, req.body);
    createApiKeyService(getDb(req))
      .create(currentUserId(req), name)
      .then((created) => {
        // The plaintext key is returned only here.
        res.status(201).json(created);
      })
      .catch(next);
  });

  router.get("/api-keys", requireAuth(), (req, res, next) => {
    createApiKeyService(getDb(req))
      .list(currentUserId(req))
      .then((keys) => res.json({ apiKeys: keys }))
      .catch(next);
  });

  router.delete("/api-keys/:id", requireAuth(), (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    createApiKeyService(getDb(req))
      .revoke(id, currentUserId(req))
      .then(() => res.status(204).end())
      .catch(next);
  });

  return router;
}
