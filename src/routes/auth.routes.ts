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
import { changePasswordLimiter } from "../middleware/rate-limit.ts";
import { randomBytes } from "node:crypto";
import {
  oidcEnabled, discoverEndpoints, buildAuthorizeUrl, exchangeCodeForTokens,
  verifyIdToken, createPkcePair, createNonce, encodeFlowState, decodeFlowState,
} from "../auth/oidc.ts";
import { upsertOidcUser, oidcPublicUser } from "../services/oidc.service.ts";
import { BadRequestError } from "../utils/errors.ts";
import { loginSchema, refreshSchema, registerSchema, changePasswordSchema, idParamSchema } from "./schemas/common.ts";
import { validate } from "./validate.ts";

/**
 * OIDC return-URL allowlist check. Prefixes are compared by URL ORIGIN plus a
 * path-boundary-aware prefix — never by raw string `startsWith`, which would
 * accept `https://pi.example.com.evil.com` for an allowlist entry of
 * `https://pi.example.com` and hand the one-time login code to an attacker.
 * An empty list keeps the historical "any http(s) URL" behavior.
 */
export function isAllowedOidcRedirect(redirectUri: string, prefixes: string[]): boolean {
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (target.username || target.password) return false;
  if (prefixes.length === 0) return true;
  return prefixes.some((rawPrefix) => {
    let prefix: URL;
    try {
      prefix = new URL(rawPrefix);
    } catch {
      return false;
    }
    if (target.origin !== prefix.origin) return false;
    const basePath = prefix.pathname.replace(/\/+$/, "");
    // Origin-only prefix (path "" or "/") allows every path on that origin.
    if (basePath === "") return true;
    return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  });
}

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
    res.json({ registerMode: cfg.register.mode, oidc: { enabled: oidcEnabled(), label: cfg.oidc.label } });
  });

  // ------------------------------------------------------------------
  // OIDC（标准 OpenID Connect）：授权码流 + PKCE。回跳 pi-web 时用 60 秒
  // 一次性 handoff code 交接令牌（令牌不进 URL/日志），pi-web 服务端再经
  // /oidc/exchange 换取。register.mode 不 gate：IdP 已核验身份。
  // ------------------------------------------------------------------
  const oidcFlowCookieName = "oidc_flow";
  // 工程未引入 cookie-parser：这里只解析 oidc_flow 一个值，手写即可（零依赖）。
  const readFlowCookie = (req: { headers: { cookie?: string } }): string | undefined =>
    (req.headers.cookie ?? "").split("; ").find((part) => part.startsWith(oidcFlowCookieName + "="))?.slice(oidcFlowCookieName.length + 1);
  const oidcHandoffs = new Map<string, { accessToken: string; refreshToken: string; user: ReturnType<typeof oidcPublicUser> }>();
  const OIDC_HANDOFF_MAX = 500;

  router.get("/oidc/begin", (req, res, next) => {
    if (!oidcEnabled()) {
      res.status(404).json({ code: "NOT_FOUND", message: "OIDC is not enabled" });
      return;
    }
    (async () => {
      const cfg = loadConfig();
      const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
      if (!isAllowedOidcRedirect(redirectUri, cfg.oidc.allowedRedirectPrefixes)) {
        res.status(400).json({ code: "BAD_REQUEST", message: "redirect_uri is missing or not allowed" });
        return;
      }
      const endpoints = await discoverEndpoints();
      const { verifier, challenge } = createPkcePair();
      const nonce = createNonce();
      const platformCallback = `${req.protocol}://${req.get("host")}/api/v1/auth/oidc/callback`;
      const state = encodeFlowState({ verifier, nonce, redirectUri, exp: Date.now() + 10 * 60_000 });
      const authorizeUrl = buildAuthorizeUrl(endpoints, {
        clientId: cfg.oidc.clientId,
        scopes: cfg.oidc.scopes,
        redirectUri: platformCallback,
        state,
        nonce,
        challenge,
      });
      res.cookie(oidcFlowCookieName, state, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        maxAge: 10 * 60_000,
        path: "/api/v1/auth/oidc",
      });
      res.redirect(authorizeUrl);
    })().catch(next);
  });

  router.get("/oidc/callback", (req, res, next) => {
    if (!oidcEnabled()) {
      res.status(404).json({ code: "NOT_FOUND", message: "OIDC is not enabled" });
      return;
    }
    const fail = (message: string) => res.redirect(`/api/v1/auth/oidc/callback-error?message=${encodeURIComponent(message)}`);
    (async () => {
      const cfg = loadConfig();
      if (typeof req.query.error === "string") {
        fail(String(req.query.error_description ?? req.query.error));
        return;
      }
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const stateCookie = readFlowCookie(req);
      const flow = decodeFlowState(typeof req.query.state === "string" ? req.query.state : undefined);
      if (!code || !flow || flow.verifier !== decodeFlowState(stateCookie)?.verifier) {
        fail("授权状态校验失败（state 不符或已过期），请重新发起登录");
        return;
      }
      res.clearCookie(oidcFlowCookieName, { path: "/api/v1/auth/oidc" });
      const endpoints = await discoverEndpoints();
      const platformCallback = `${req.protocol}://${req.get("host")}/api/v1/auth/oidc/callback`;
      const { idToken } = await exchangeCodeForTokens(endpoints, {
        clientId: cfg.oidc.clientId,
        clientSecret: cfg.oidc.clientSecret,
        redirectUri: platformCallback,
        code,
        verifier: flow.verifier,
      });
      const claims = await verifyIdToken(idToken, flow.nonce);
      const db = getDb(req);
      const user = await upsertOidcUser(db, claims);
      const auth = createAuthService(db);
      const pair = await auth.loginDirect(user, req.ip);
      const handoff = randomBytes(24).toString("base64url");
      // Bound the map even while every entry is still within its 60s TTL: a
      // valid IdP account could otherwise open logins in a tight loop and grow
      // process memory without limit.
      if (oidcHandoffs.size >= OIDC_HANDOFF_MAX) {
        const oldest = oidcHandoffs.keys().next().value;
        if (oldest) oidcHandoffs.delete(oldest);
      }
      oidcHandoffs.set(handoff, {
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        user: oidcPublicUser(user),
      });
      setTimeout(() => oidcHandoffs.delete(handoff), 60_000).unref?.();
      const back = new URL(flow.redirectUri);
      back.searchParams.set("code", handoff);
      res.redirect(back.toString());
    })().catch((err) => fail(err instanceof Error ? err.message : String(err)));
  });

  // 一次性 handoff code → 平台令牌对（pi-web 服务端调用）。
  router.post("/oidc/exchange", (req, res) => {
    const body = req.body as { code?: unknown };
    const handoff = typeof body.code === "string" ? oidcHandoffs.get(body.code) : undefined;
    if (typeof body.code === "string") oidcHandoffs.delete(body.code);
    if (!handoff) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "handoff code 无效或已过期" });
      return;
    }
    res.json({
      accessToken: handoff.accessToken,
      refreshToken: handoff.refreshToken,
      user: handoff.user,
    });
  });

  // 无人值守的失败展示（浏览器 302 落点；pi-web 场景几乎不会到达）。
  router.get("/oidc/callback-error", (_req, res) => {
    res.status(401).json({ code: "OIDC_LOGIN_FAILED", message: "OIDC 登录失败" });
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
  // Limited: an attacker holding a live token can brute-force currentPassword
  // to recover the (often reused) plaintext.
  router.post("/change-password", requireAuth(), changePasswordLimiter(), (req, res, next) => {
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
