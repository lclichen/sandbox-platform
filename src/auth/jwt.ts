/**
 * JWT access + refresh token helpers.
 *
 * Access tokens are short-lived (15m default) and carry the user identity and
 * role. Refresh tokens are long-lived (7d default); only their hash is stored
 * in refresh_tokens so a stolen database cannot be replayed directly. Tokens
 * are SHA-256 hashed before storage.
 *
 * Implemented with `jose` (zero-dependency, MIT) instead of jsonwebtoken:
 * jsonwebtoken pulls in seven legacy `lodash.*` micro-packages (including
 * lodash.includes@4.3.0), which some SCA scanners misreport as lodash 4.3.0.
 */
import { SignJWT, jwtVerify, decodeJwt } from "jose";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.ts";

export interface AccessClaims {
  sub: number; // user id
  username: string;
  role: "admin" | "user";
  type: "access";
  /** R9: set while the account owes a password change; gates most endpoints. */
  pwd_change_required?: boolean;
  /** C5: token_version of the owner at issue time. Bumping users.token_version
   *  (password change/reset, disable) rejects every outstanding token. */
  tv?: number;
}

export interface RefreshClaims {
  sub: number;
  type: "refresh";
  jti: string; // token id, whose hash is stored server-side
}

const encoder = new TextEncoder();

/** Read the secret per call so tests/config reloads see the current value. */
function secretKey(): Uint8Array {
  return encoder.encode(loadConfig().auth.jwtSecret);
}

/** JWT `sub` is a string in the spec; normalize it back to a numeric user id. */
function normalizeClaims(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.sub === "string" && /^\d+$/.test(payload.sub)) {
    payload.sub = Number(payload.sub);
  }
  return payload;
}

export async function signAccessToken(user: {
  id: number;
  username: string;
  role: "admin" | "user";
  mustChangePassword?: boolean;
  tokenVersion?: number;
}): Promise<string> {
  return new SignJWT({
    username: user.username,
    role: user.role,
    type: "access",
    tv: user.tokenVersion ?? 0,
    ...(user.mustChangePassword ? { pwd_change_required: true } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(loadConfig().auth.accessTtl)
    .sign(secretKey());
}

export async function signRefreshToken(userId: number, jti: string): Promise<string> {
  return new SignJWT({ type: "refresh" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(String(userId))
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(loadConfig().auth.refreshTtl)
    .sign(secretKey());
}

export async function verifyToken<T = unknown>(token: string): Promise<T> {
  // Pin the algorithm: an unpinned verify accepts any HS* variant and would
  // follow future library defaults.
  const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
  return normalizeClaims(payload as Record<string, unknown>) as T;
}

/** SHA-256 hash of a token for storage (refresh tokens only). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Decode a token's expiry without verifying (used for refresh storage). */
export function decodeExpiry(token: string): Date {
  try {
    const decoded = decodeJwt(token);
    if (typeof decoded.exp === "number") return new Date(decoded.exp * 1000);
  } catch {
    // Fall through to the refresh-TTL fallback for malformed input.
  }
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

export function generateJti(): string {
  return crypto.randomUUID();
}
