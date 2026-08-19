/**
 * Auth routes: /api/v1/auth
 *
 *   POST  /login            { username, password } -> { accessToken, refreshToken, expiresIn, user }
 *   POST  /refresh          { refreshToken }        -> { accessToken, refreshToken, expiresIn }
 *   POST  /logout           { refreshToken }        -> 204
 *   POST  /register         { username, password, email? } -> 201 (R1, REGISTER_MODE-gated)
 *   GET   /config           public auth capabilities (register mode) for the login page
 *   POST  /change-password  { currentPassword, newPassword } -> 204 (R9)
 *   GET   /me                                      -> { user }                       (requires auth)
 *   GET   /dashboard                                -> current user's own summary     (requires auth)
 */
import { Router } from "express";
import { z } from "zod";
import { getDb } from "../app.ts";
import { loadConfig } from "../config.ts";
import { createAuthService } from "../services/auth.service.ts";
import { createUserService, toPublic } from "../services/user.service.ts";
import { createApiKeyService } from "../services/apikey.service.ts";
import { validatePasswordPolicy } from "../auth/password.ts";
import { requireAuth, currentUserId, type AuthedRequest } from "../auth/middleware.ts";
import { BadRequestError } from "../utils/errors.ts";
import { loginSchema, refreshSchema, registerSchema, changePasswordSchema, idParamSchema } from "./schemas/common.ts";
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

  // R1: public capability discovery — lets the login page render a register
  // form only when the deployment actually allows self-registration.
  router.get("/config", (_req, res) => {
    const cfg = loadConfig();
    res.json({ registerMode: cfg.register.mode });
  });

  // R1: self-registration. Behavior is driven by REGISTER_MODE:
  //   off      -> 404 (identical to an unknown route; the endpoint "does not exist")
  //   open     -> account created active with the default quota
  //   approval -> account created pending; an admin approves via /admin/users
  router.post("/register", (req, res, next) => {
    const cfg = loadConfig();
    if (cfg.register.mode === "off") {
      // Deliberately indistinguishable from any other unknown route.
      res.status(404).json({ code: "NOT_FOUND", message: "Resource not found" });
      return;
    }
    let body: z.infer<typeof registerSchema>;
    try {
      body = validate(registerSchema, req.body);
    } catch (err) {
      next(err);
      return;
    }
    const violation = validatePasswordPolicy(body.password);
    if (violation) {
      next(new BadRequestError(violation));
      return;
    }
    (async () => {
      const db = getDb(req);
      // Resolve the quota template by name; a missing template degrades to the
      // lowest-id quota row rather than failing the signup.
      const quota = await db.get<{ id: number }>(
        "SELECT id FROM resource_quotas WHERE name = ? ORDER BY id LIMIT 1",
        cfg.register.defaultQuotaName,
      );
      const fallback = quota
        ? undefined
        : await db.get<{ id: number }>("SELECT id FROM resource_quotas ORDER BY id LIMIT 1");
      const users = createUserService(db);
      const created = await users.create({
        username: body.username,
        password: body.password,
        email: body.email,
        quota_id: quota?.id ?? fallback?.id,
        status: cfg.register.mode === "approval" ? "pending" : "active",
      });
      res.status(201).json({
        user: toPublic(created),
        ...(cfg.register.mode === "approval"
          ? { message: "Registration received. An administrator must approve the account before login." }
          : {}),
      });
    })().catch(next);
  });

  // R9: self-service password change; also the exit path for accounts flagged
  // must_change_password (the flag gates all other endpoints via requireAuth).
  router.post("/change-password", requireAuth(), (req, res, next) => {
    const body = validate(changePasswordSchema, req.body);
    createAuthService(getDb(req))
      .changePassword(currentUserId(req), body.currentPassword, body.newPassword)
      .then(() => res.status(204).end())
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
          res.status(404).json({ code: "NOT_FOUND", message: "User not found" });
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
