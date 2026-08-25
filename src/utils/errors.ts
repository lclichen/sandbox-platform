/**
 * Application error hierarchy mapped to HTTP responses.
 *
 * Throw these from services; the Express error handler in routes translates
 * each class to a status code and JSON body. Keep the set small and specific.
 *
 * R7 (pi-web integration): `code` values are STABLE, UPPER_SNAKE machine codes
 * (e.g. QUOTA_EXCEEDED). Frontends localize / build retry strategies on them;
 * never rename a published code — deprecate and add a new one instead. The full
 * table lives in docs/API-REFERENCE.md.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, "BAD_REQUEST", message, details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, "FORBIDDEN", message);
  }
}

export class NotFoundError extends HttpError {
  constructor(resource: string, id?: string | number) {
    super(404, "NOT_FOUND", id ? `${resource} ${id} not found` : `${resource} not found`);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

/** Quota or resource-limit violation (e.g. too many containers). */
export class QuotaExceededError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(422, "QUOTA_EXCEEDED", message, details);
  }
}

/** Container not in an operable state for the requested action. */
export class InvalidStateError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, "INVALID_STATE", message, details);
  }
}

/**
 * The container exists and is owned but is not running (tools/PTY need a live
 * instance). Distinct from INVALID_STATE so clients can offer a "start" action.
 */
export class ContainerNotRunningError extends HttpError {
  constructor(message = "Container is not running") {
    super(409, "CONTAINER_NOT_RUNNING", message);
  }
}

/** R1: account exists but is awaiting admin approval (approval register mode). */
export class AccountPendingError extends HttpError {
  constructor(message = "Account is pending approval by an administrator") {
    super(403, "ACCOUNT_PENDING", message);
  }
}

/** R9: login succeeded but the flagged account must change its password first. */
export class PasswordChangeRequiredError extends HttpError {
  constructor(message = "Password change required before using this account") {
    super(403, "PASSWORD_CHANGE_REQUIRED", message);
  }
}

/** R9: the supplied password violates the configured password policy. */
export class WeakPasswordError extends HttpError {
  constructor(message: string) {
    super(400, "WEAK_PASSWORD", message);
  }
}

/** R6: the image is not in the owner's quota whitelist. */
export class ImageNotAllowedError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(403, "IMAGE_NOT_ALLOWED", message, details);
  }
}

/** Translate any unknown error into a generic 500. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  // P2-1: in production, never leak internal details (DB connection strings,
  // file paths, stack traces) to clients. The full error is logged by app.ts
  // (`logger.error({ err, ... })`); clients get a generic message.
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : error instanceof Error
        ? error.message
        : String(error);
  return new HttpError(500, "INTERNAL_ERROR", message);
}
