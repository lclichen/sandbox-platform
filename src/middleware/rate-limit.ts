/**
 * Rate limiting middleware (P1-1).
 *
 * IP-dimension limits for the brute-force / abuse surfaces:
 *   - POST /auth/login            -> loginPerMinute  (default 10/min)
 *   - POST /auth/refresh          -> refreshPerMinute (default 30/min)
 *   - tools/bash + stream         -> bashPerMinute    (default 60/min)
 *   - POST /llm/me/keys/:id/reveal -> llmRevealPerMinute (default 5/min)
 *
 * The reveal limiter caps a sensitive plaintext-returning endpoint so a stolen
 * token cannot hammer it to extract LLM virtual keys.
 *
 * Enabled by default in production (NODE_ENV=production); development can opt
 * in with RATE_LIMIT_ENABLED=true. When disabled, the middleware is a no-op so
 * tests and local development are unaffected.
 *
 * NOTE: behind a reverse proxy, set TRUST_PROXY to the number of proxy hops so
 * req.ip reflects the real client (see config.server.trustProxy, applied in
 * app.ts).
 */
import { rateLimit } from "express-rate-limit";
import type { RequestHandler } from "express";
import { loadConfig } from "../config.ts";

function limiter(windowMs: number, max: number): RequestHandler {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // RateLimit-* headers per the IETF draft
    legacyHeaders: false,
    message: { code: "RATE_LIMITED", message: "Too many requests, please try again later" },
  });
}

function noop(): RequestHandler {
  return (_req, _res, next) => next();
}

export function loginLimiter(): RequestHandler {
  const c = loadConfig();
  return c.rateLimit.enabled ? limiter(60_000, c.rateLimit.loginPerMinute) : noop();
}

export function refreshLimiter(): RequestHandler {
  const c = loadConfig();
  return c.rateLimit.enabled ? limiter(60_000, c.rateLimit.refreshPerMinute) : noop();
}

export function bashLimiter(): RequestHandler {
  const c = loadConfig();
  return c.rateLimit.enabled ? limiter(60_000, c.rateLimit.bashPerMinute) : noop();
}

export function llmRevealLimiter(): RequestHandler {
  const c = loadConfig();
  return c.rateLimit.enabled ? limiter(60_000, c.rateLimit.llmRevealPerMinute) : noop();
}

/**
 * R1: self-registration abuse guard. Tighter than login — a public write
 * endpoint that mints accounts must not be hammerable. The captcha hook is
 * deliberately left as a future extension point (see requirements doc R9).
 */
export function registerLimiter(): RequestHandler {
  const c = loadConfig();
  return c.rateLimit.enabled ? limiter(60_000, c.rateLimit.registerPerMinute) : noop();
}
