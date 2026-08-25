/**
 * JWT access + refresh token helpers.
 *
 * Access tokens are short-lived (15m default) and carry the user identity and
 * role. Refresh tokens are long-lived (7d default); only their hash is stored
 * in refresh_tokens so a stolen database cannot be replayed directly. Tokens
 * are SHA-256 hashed before storage.
 */
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.ts";

export interface AccessClaims {
  sub: number; // user id
  username: string;
  role: "admin" | "user";
  type: "access";
  /** R9: set while the account owes a password change; gates most endpoints. */
  pwd_change_required?: boolean;
}

export interface RefreshClaims {
  sub: number;
  type: "refresh";
  jti: string; // token id, whose hash is stored server-side
}

const config = loadConfig();

export function signAccessToken(user: {
  id: number;
  username: string;
  role: "admin" | "user";
  mustChangePassword?: boolean;
}): string {
  const claims: AccessClaims = {
    sub: user.id,
    username: user.username,
    role: user.role,
    type: "access",
    ...(user.mustChangePassword ? { pwd_change_required: true } : {}),
  };
  return jwt.sign(claims, config.auth.jwtSecret, { expiresIn: config.auth.accessTtl });
}

export function signRefreshToken(userId: number, jti: string): string {
  const claims: RefreshClaims = { sub: userId, type: "refresh", jti };
  return jwt.sign(claims, config.auth.jwtSecret, { expiresIn: config.auth.refreshTtl });
}

export function verifyToken<T = unknown>(token: string): T {
  return jwt.verify(token, config.auth.jwtSecret) as T;
}

/** SHA-256 hash of a token for storage (refresh tokens only). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Decode a token's expiry without verifying (used for refresh storage). */
export function decodeExpiry(token: string): Date {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  if (!decoded?.exp) {
    // Fall back to now + refreshTtl if malformed.
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }
  return new Date(decoded.exp * 1000);
}

export function generateJti(): string {
  return crypto.randomUUID();
}
