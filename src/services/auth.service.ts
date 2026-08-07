/**
 * Auth service: login, token refresh, logout, profile.
 *
 * Refresh tokens are stored hashed (sha256). On refresh, the old token is
 * revoked and a new pair issued (rotation). Logout revokes the supplied
 * refresh token.
 */
import type { Database } from "../db/driver.ts";
import { verifyPassword } from "../auth/password.ts";
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  hashToken,
  decodeExpiry,
  generateJti,
  type RefreshClaims,
} from "../auth/jwt.ts";
import { createUserService, type UserRow } from "./user.service.ts";
import { UnauthorizedError, ForbiddenError } from "../utils/errors.ts";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // access token lifetime in seconds
}

const ACCESS_LIFETIMES: Record<string, number> = {
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
};

export function createAuthService(db: Database) {
  const users = createUserService(db);

  function accessLifetimeSeconds(): number {
    // Parse "15m"/"2h"/"90s" generically.
    const ttl = process.env.JWT_ACCESS_TTL ?? "15m";
    const m = ttl.match(/^(\d+)([smh])$/);
    if (!m) return 900;
    const n = Number(m[1]);
    const unit = m[2];
    return n * (unit === "s" ? 1 : unit === "m" ? 60 : 3600);
  }

  async function issueTokenPair(user: UserRow, clientIp?: string, familyId?: string): Promise<TokenPair> {
    const jti = generateJti();
    const refreshToken = signRefreshToken(user.id, jti);
    const expiresAt = decodeExpiry(refreshToken);
    // Every login starts a NEW family; rotations during refresh keep the same
    // family so a detected replay can revoke everything at once (P1-3).
    const family = familyId ?? jti;
    await db.run(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, client_ip, family_id)
       VALUES (?, ?, ?, ?, ?)`,
      user.id,
      hashToken(refreshToken),
      expiresAt.toISOString(),
      clientIp ?? null,
      family,
    );
    return {
      accessToken: signAccessToken(user),
      refreshToken,
      expiresIn: ACCESS_LIFETIMES[process.env.JWT_ACCESS_TTL ?? "15m"] ?? accessLifetimeSeconds(),
    };
  }

  return {
    async login(username: string, password: string, clientIp?: string): Promise<TokenPair & { user: UserRow }> {
      const user = await users.getByUsername(username);
      if (!user) throw new UnauthorizedError("Invalid username or password");
      if (user.status === "disabled") throw new ForbiddenError("Account is disabled");
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) throw new UnauthorizedError("Invalid username or password");
      await users.touchLogin(user.id);
      const pair = await issueTokenPair(user, clientIp);
      return { ...pair, user };
    },

    async refresh(refreshToken: string, clientIp?: string): Promise<TokenPair> {
      let claims: RefreshClaims;
      try {
        claims = verifyToken<RefreshClaims>(refreshToken);
      } catch {
        throw new UnauthorizedError("Invalid refresh token");
      }
      if (claims.type !== "refresh") throw new UnauthorizedError("Wrong token type");

      const stored = await db.get<{ id: number; revoked_at: string | null; user_id: number; family_id: string }>(
        "SELECT id, revoked_at, user_id, family_id FROM refresh_tokens WHERE token_hash = ?",
        hashToken(refreshToken),
      );
      if (!stored) throw new UnauthorizedError("Refresh token not recognized");
      if (stored.revoked_at) {
        // Reuse detection: a revoked token being replayed is a theft signal.
        // Revoke the WHOLE family (all rotations from the same login), not just
        // this one row — otherwise the thief keeps rotating a sibling token.
        await db.run(
          "UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE family_id = ? AND revoked_at IS NULL",
          stored.family_id,
        );
        throw new UnauthorizedError("Refresh token already used");
      }

      const user = await users.getById(stored.user_id);
      if (!user) throw new UnauthorizedError("User no longer exists");
      if (user.status === "disabled") throw new ForbiddenError("Account is disabled");

      // Rotate: revoke old, issue new within the same family.
      await db.run("UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?", stored.id);
      return issueTokenPair(user, clientIp, stored.family_id);
    },

    async logout(refreshToken: string): Promise<void> {
      const stored = await db.get<{ id: number }>(
        "SELECT id FROM refresh_tokens WHERE token_hash = ?",
        hashToken(refreshToken),
      );
      if (stored) {
        await db.run("UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?", stored.id);
      }
    },

    async profile(userId: number): Promise<UserRow> {
      const user = await users.getById(userId);
      if (!user) throw new UnauthorizedError("User not found");
      return user;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
