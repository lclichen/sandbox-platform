/**
 * Application error hierarchy mapped to HTTP responses.
 *
 * Throw these from services; the Express error handler in routes translates
 * each class to a status code and JSON body. Keep the set small and specific.
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
    super(400, "bad_request", message, details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends HttpError {
  constructor(resource: string, id?: string | number) {
    super(404, "not_found", id ? `${resource} ${id} not found` : `${resource} not found`);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, "conflict", message, details);
  }
}

/** Quota or resource-limit violation (e.g. too many containers). */
export class QuotaExceededError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(422, "quota_exceeded", message, details);
  }
}

/** Container not in an operable state for the requested action. */
export class InvalidStateError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, "invalid_state", message, details);
  }
}

/** Translate any unknown error into a generic 500. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new HttpError(500, "internal_error", message);
}
