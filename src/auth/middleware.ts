/**
 * Auth middleware: JWT and API-key verification + RBAC.
 *
 * `requireAuth` accepts either a JWT access token or a long-lived API key
 * (`sk_...`) in the Authorization: Bearer header, or an API key in the
 * X-API-Key header. Both paths populate `req.user` with the same AccessClaims
 * shape, so downstream services are agnostic to the credential type.
 *
 * `requireAdmin` builds on requireAuth and rejects non-admin roles.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyToken, type AccessClaims } from "./jwt.ts";
import { UnauthorizedError, ForbiddenError } from "../utils/errors.ts";
import { isApiKeyFormat, createApiKeyService } from "../services/apikey.service.ts";
import { createUserService } from "../services/user.service.ts";
import type { Database } from "../db/driver.ts";

export interface AuthedRequest extends Request {
  user?: AccessClaims;
  /** How the request was authenticated: "jwt" | "api-key". */
  authMethod?: "jwt" | "api-key";
}

function extractCredential(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey.length > 0) return xKey.trim();
  return undefined;
}

function getDb(req: Request): Database {
  const db = req.app.locals.db as Database | undefined;
  if (!db) throw new UnauthorizedError("Database not attached to request");
  return db;
}

/** Resolve an API key to AccessClaims (looks up the owning user). */
async function claimsFromApiKey(db: Database, plaintext: string): Promise<AccessClaims | null> {
  const keys = createApiKeyService(db);
  const auth = await keys.authenticate(plaintext);
  if (!auth) return null;
  const users = createUserService(db);
  const user = await users.getById(auth.userId);
  if (!user || user.status !== "active") return null;
  return { sub: user.id, username: user.username, role: user.role, type: "access" };
}

export function requireAuth(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const credential = extractCredential(req);
    if (!credential) return next(new UnauthorizedError("Missing or malformed Authorization header"));

    try {
      let claims: AccessClaims | null = null;
      let method: "jwt" | "api-key" = "jwt";
      if (isApiKeyFormat(credential)) {
        method = "api-key";
        claims = await claimsFromApiKey(getDb(req), credential);
        if (!claims) return next(new UnauthorizedError("Invalid or revoked API key"));
      } else {
        try {
          claims = verifyToken<AccessClaims>(credential);
        } catch {
          return next(new UnauthorizedError("Invalid or expired token"));
        }
        if (claims.type !== "access") return next(new UnauthorizedError("Wrong token type"));
      }

      (req as AuthedRequest).user = claims;
      (req as AuthedRequest).authMethod = method;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Require the authenticated user to have the admin role. */
export function requireAdmin(): RequestHandler[] {
  return [
    requireAuth(),
    (req: Request, _res: Response, next: NextFunction) => {
      const user = (req as AuthedRequest).user;
      if (!user || user.role !== "admin") {
        return next(new ForbiddenError("Admin privileges required"));
      }
      next();
    },
  ];
}

/** Convenience: the current user id, available after requireAuth. */
export function currentUserId(req: Request): number {
  const claims = (req as AuthedRequest).user;
  if (!claims) throw new UnauthorizedError("Not authenticated");
  return claims.sub;
}
