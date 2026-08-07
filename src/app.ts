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
import { resolve, extname, posix as posixPath } from "node:path";
import { fileURLToPath } from "node:url";
import { toHttpError, HttpError } from "./utils/errors.ts";
import { logger } from "./utils/logger.ts";
import { loadConfig } from "./config.ts";
import { createDatabase, type Database } from "./db/driver.ts";
import { getExecutor, type SandboxExecutorRef } from "./executors/index.ts";
import { loginLimiter, refreshLimiter, bashLimiter } from "./middleware/rate-limit.ts";
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

export interface AppDeps {
  db: Database;
  executor?: SandboxExecutorRef;
}

export async function createApp(deps?: AppDeps): Promise<{ app: Express; db: Database }> {
  const db = deps?.db ?? (await createDatabase());
  const executor = deps?.executor ?? (await getExecutor());

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

  // Attach db + executor on every request.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.app.locals.db = db;
    req.app.locals.executor = executor;
    next();
  });

  // Health check (no auth).
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", dialect: db.dialect, executor: executor.kind });
  });

  // Audit mutating requests. Mounted under /api/v1 so req.path is relative,
  // BEFORE the routers so res.on('finish') captures their outcome.
  app.use("/api/v1", auditMiddleware());

  // Rate limiting (P1-1): brute-force / abuse surfaces, IP dimension.
  // No-op middleware when disabled (default outside production).
  app.use("/api/v1/auth/login", loginLimiter());
  app.use("/api/v1/auth/refresh", refreshLimiter());
  app.use("/api/v1/containers/:id/tools/bash", bashLimiter());

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

export type { HttpError };
