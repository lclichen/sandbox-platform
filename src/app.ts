/**
 * Express application factory.
 *
 * Wires middleware, attaches routers under /api/v1, and registers the unified
 * error handler. Kept separate from index.ts (which starts the HTTP server)
 * so tests can create() the app without binding a port.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { mkdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve, extname, posix as posixPath } from "node:path";
import { fileURLToPath } from "node:url";
import { toHttpError, HttpError } from "./utils/errors.ts";
import { logger } from "./utils/logger.ts";
import { loadConfig } from "./config.ts";
import { createDatabase, type Database } from "./db/driver.ts";
import { getExecutor, type SandboxExecutorRef } from "./executors/index.ts";
import { loginLimiter, refreshLimiter, bashLimiter, llmRevealLimiter } from "./middleware/rate-limit.ts";
import { metricsMiddleware, metricsHandler, registry, recordLitellmHealth } from "./middleware/metrics.ts";
import { authRouter } from "./routes/auth.routes.ts";
import { usersRouter } from "./routes/users.routes.ts";
import { quotasRouter } from "./routes/quotas.routes.ts";
import { imagesRouter } from "./routes/images.routes.ts";
import { containersRouter } from "./routes/containers.routes.ts";
import { toolsRouter } from "./routes/tools.routes.ts";
import { workspacesRouter } from "./routes/workspaces.routes.ts";
import { auditMiddleware } from "./routes/audit.middleware.ts";
import { adminRouter } from "./routes/admin.routes.ts";
import { publicImagesRouter } from "./routes/images.public.routes.ts";
import { publicLogsRouter } from "./routes/logs.public.routes.ts";
import { llmAdminRouter } from "./routes/llm.admin.routes.ts";
import { llmRouter } from "./routes/llm.routes.ts";
import { createLitellmClient, isLitellmConfigured, type LitellmClient } from "./services/litellm.client.ts";
import { createLlmService } from "./services/llm.service.ts";
import { type LlmEnvProvider } from "./services/container.service.ts";
import { isValidKeyHex, type EncryptionKey } from "./utils/crypto.ts";

export interface AppDeps {
  db: Database;
  executor?: SandboxExecutorRef;
}

export async function createApp(deps?: AppDeps): Promise<{ app: Express; db: Database }> {
  const db = deps?.db ?? (await createDatabase());
  const executor = deps?.executor ?? (await getExecutor());

  // LiteLLM integration is optional. Wire it only when the admin has enabled it
  // AND supplied both the master key and a valid encryption key; otherwise the
  // /api/v1/*llm* routes return 503 via the accessors below.
  const cfg = loadConfig();
  let litellmClient: LitellmClient | undefined;
  let llmEncryptionKey: EncryptionKey | undefined;
  const llmReady =
    isLitellmConfigured({ enabled: cfg.llm.enabled, litellm: { masterKey: cfg.llm.litellm.masterKey } }) &&
    isValidKeyHex(cfg.llm.encryptionKey);
  if (llmReady) {
    litellmClient = createLitellmClient({
      baseUrl: cfg.llm.litellm.baseUrl,
      masterKey: cfg.llm.litellm.masterKey!,
      timeoutMs: cfg.llm.litellm.timeoutMs,
    });
    llmEncryptionKey = cfg.llm.encryptionKey;
  }

  // LLM env-injection hook for container create: when the owner has an active
  // binding + key, surface SANDBOX_LLM_BASE_URL / SANDBOX_LLM_API_KEY into the
  // container env so in-container processes can drive LiteLLM directly.
  const llmEnvProvider: LlmEnvProvider | undefined = llmReady
    ? async (userId: number) => {
        const svc = createLlmService(db, litellmClient!, llmEncryptionKey!, {
          publicBaseUrl: cfg.llm.litellm.publicBaseUrl,
        });
        const status = await svc.getMyStatus(userId);
        if (!status.binding || status.binding.revoked_at) return undefined;
        const keys = await svc.listMyKeys(userId);
        const active = keys.find((k) => !k.revoked_at);
        if (!active) return undefined;
        const revealed = await svc.revealMyKey(active.id, userId);
        const base = cfg.llm.litellm.publicBaseUrl.replace(/\/+$/, "");
        return {
          SANDBOX_LLM_BASE_URL: base.endsWith("/v1") ? base : `${base}/v1`,
          SANDBOX_LLM_API_KEY: revealed.plaintext,
        };
      }
    : undefined;

  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.disable("x-powered-by");

  // Security headers (P1-1). CSP tuned for the SPA: same-origin scripts, inline
  // styles allowed (React style attributes), images may be inline data: URIs.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  // Behind a reverse proxy, trust N hops so rate-limit keys use the real client IP.
  const trustProxy = loadConfig().trustProxy;
  if (trustProxy > 0) app.set("trust proxy", trustProxy);

  // Attach db + executor (+ optional LiteLLM client) on every request.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.app.locals.db = db;
    req.app.locals.executor = executor;
    req.app.locals.litellmClient = litellmClient;
    req.app.locals.llmReady = llmReady;
    req.app.locals.llmEncryptionKey = llmEncryptionKey;
    req.app.locals.llmPublicBaseUrl = cfg.llm.litellm.publicBaseUrl;
    req.app.locals.llmEnvProvider = llmEnvProvider;
    next();
  });

  // Health check (no auth). Liveness only: the process is up.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", dialect: db.dialect, executor: executor.kind });
  });

  // Readiness probe (P2-2): DB reachable + overlay base dir writable.
  // When LLM integration is enabled, also probe LiteLLM liveness.
  app.get("/ready", async (_req: Request, res: Response) => {
    try {
      await db.get("SELECT 1");
      const overlayBase = loadConfig().executor.apptainer.overlayBaseDir;
      await mkdir(overlayBase, { recursive: true });
      await access(overlayBase, fsConstants.W_OK);
      let litellm: "disabled" | "ok" | "down" = "disabled";
      if (litellmClient) {
        litellm = (await litellmClient.health()) ? "ok" : "down";
        recordLitellmHealth(litellm === "ok" ? "up" : "down");
        if (litellm === "down") throw new Error("LiteLLM unreachable");
      } else {
        recordLitellmHealth("disabled");
      }
      res.json({ status: "ready", dialect: db.dialect, executor: executor.kind, litellm });
    } catch {
      res.status(503).json({ status: "not_ready" });
    }
  });

  // Prometheus metrics (P2-2). Guarded by METRICS_TOKEN when set (bearer auth);
  // left open in development otherwise. Promote closing this in production.
  app.get("/metrics", async (req: Request, res: Response) => {
    const token = loadConfig().metricsToken;
    if (token) {
      const sent = req.headers.authorization;
      if (sent !== `Bearer ${token}`) {
        res.status(401).json({ code: "unauthorized", message: "Metrics require a bearer token (METRICS_TOKEN)." });
        return;
      }
    }
    try {
      const body = await metricsHandler(db);
      res.setHeader("Content-Type", registry.contentType);
      res.end(body);
    } catch (err) {
      logger.error({ err }, "metrics scrape failed");
      res.status(500).json({ code: "internal_error", message: "Metrics unavailable" });
    }
  });

  // Request instrumentation (before routers so it wraps everything).
  app.use(metricsMiddleware());

  // Audit mutating requests. Mounted under /api/v1 so req.path is relative,
  // BEFORE the routers so res.on('finish') captures their outcome.
  app.use("/api/v1", auditMiddleware());

  // Rate limiting (P1-1): brute-force / abuse surfaces, IP dimension.
  // No-op middleware when disabled (default outside production).
  app.use("/api/v1/auth/login", loginLimiter());
  app.use("/api/v1/auth/refresh", refreshLimiter());
  app.use("/api/v1/containers/:id/tools/bash", bashLimiter());
  // The reveal endpoint returns decrypted plaintext; cap it tightly.
  app.use("/api/v1/llm/me/keys/:id/reveal", llmRevealLimiter());

  // API routers. Each receives the db + executor via req.app.locals.
  app.use("/api/v1/auth", authRouter());
  app.use("/api/v1/admin/users", usersRouter());
  app.use("/api/v1/admin/quotas", quotasRouter());
  app.use("/api/v1/admin/images", imagesRouter());
  app.use("/api/v1/containers", containersRouter());
  app.use("/api/v1/containers", toolsRouter());
  app.use("/api/v1/workspaces", workspacesRouter());
  app.use("/api/v1/images", publicImagesRouter());
  app.use("/api/v1/logs", publicLogsRouter());
  app.use("/api/v1/admin/llm", llmAdminRouter());
  app.use("/api/v1/llm", llmRouter());
  app.use("/api/v1/admin", adminRouter());

  // Serve the admin SPA (web/dist) if it has been built. API routes above take
  // precedence; anything else under a non-/api GET falls through to static
  // files, with a catch-all to index.html for client-side routing.
  const webDist = resolve(fileURLToPath(import.meta.url), "..", "..", "web", "dist");
  if (existsSync(webDist)) {
    const indexHtml = posixPath.join(webDist, "index.html");
    app.use(
      express.static(webDist, {
        index: false, // handled by the catch-all below
        setHeaders: (res, filePath) => {
          // SPA assets are immutable-hashed; index.html must not be cached.
          if (filePath === indexHtml) {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );
    // SPA fallback: any non-API GET that did not match a static file -> index.html.
    app.get(/^\/(?!api\/|health).*/, (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET") return next();
      // Avoid hijacking file extensions that simply don't exist (let them 404).
      if (extname(req.path).length > 0) return next();
      res.sendFile(indexHtml, (err) => {
        if (err) next(err);
      });
    });
    logger.info({ webDist }, "Admin SPA static serving enabled.");
  }

  // 404 for unknown API routes.
  app.use((req: Request, res: Response) => {
    // For non-API requests without a static build, hint at running the web build.
    if (!req.path.startsWith("/api/")) {
      res.status(404).json({
        code: "not_found",
        message: "Admin UI not built. Run `npm run build` in the web/ directory.",
      });
      return;
    }
    res.status(404).json({ code: "not_found", message: "Resource not found" });
  });

  // Unified error handler: convert thrown errors to JSON.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const httpErr = toHttpError(err);
    if (httpErr.status >= 500) {
      logger.error({ err, status: httpErr.status }, "Request failed.");
    } else {
      logger.warn({ code: httpErr.code, message: httpErr.message, status: httpErr.status }, "Request error.");
    }
    res.status(httpErr.status).json({
      code: httpErr.code,
      message: httpErr.message,
      ...(httpErr.details ? { details: httpErr.details } : {}),
    });
  });

  return { app, db };
}

/** Typed accessor for the database attached to a request. */
export function getDb(req: Request): Database {
  const db = req.app.locals.db as Database | undefined;
  if (!db) throw new HttpError(500, "internal_error", "Database not attached to request");
  return db;
}

/** Typed accessor for the executor attached to a request. */
export function getExecutorFromReq(req: Request): SandboxExecutorRef {
  const exec = req.app.locals.executor as SandboxExecutorRef | undefined;
  if (!exec) throw new HttpError(500, "internal_error", "Executor not attached to request");
  return exec;
}

/**
 * Typed accessor for the optional LiteLLM client. Throws 503 (llm_not_enabled)
 * when integration is off, so LLM routes fail loudly and uniformly instead of
 * each one re-checking config.
 */
export function getLitellmClient(req: Request): LitellmClient {
  const ready = req.app.locals.llmReady as boolean | undefined;
  const client = req.app.locals.litellmClient as LitellmClient | undefined;
  if (!ready || !client) {
    throw new HttpError(503, "llm_not_enabled", "LLM integration is not enabled. Set LLM_ENABLED=true and configure LITELLM_MASTER_KEY / LLM_ENCRYPTION_KEY.");
  }
  return client;
}

/**
 * Build an LlmService bound to this request's db + LiteLLM client. Constructed
 * per-request to match the existing service-factory convention.
 */
export function getLlmService(req: Request) {
  const db = getDb(req);
  const client = getLitellmClient(req);
  const key = req.app.locals.llmEncryptionKey as EncryptionKey | undefined;
  if (!key) throw new HttpError(500, "internal_error", "LLM encryption key not attached to request");
  const publicBaseUrl = (req.app.locals.llmPublicBaseUrl as string | undefined) ?? "http://localhost:4000";
  return createLlmService(db, client, key, { publicBaseUrl });
}

/** Read the optional LLM env-injection provider from request locals (undefined when LLM is off). */
export function getLlmEnvProvider(req: Request): LlmEnvProvider | undefined {
  return req.app.locals.llmEnvProvider as LlmEnvProvider | undefined;
}

export type { HttpError };
