/**
 * API key service.
 *
 * Personal long-lived credentials. The plaintext `sk_<32hex>` is returned to
 * the caller exactly once at creation; only its SHA-256 hash and a short
 * identification prefix are persisted. Keys never expire; revocation sets
 * revoked_at. Lookup for auth is by hash.
 */
import { randomBytes, createHash } from "node:crypto";
import type { Database } from "../db/driver.ts";
import { NotFoundError } from "../utils/errors.ts";

const PREFIX = "sk_";

export interface ApiKeyRow {
  id: number;
  user_id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** A key as returned at creation time (includes the secret once). */
export interface CreatedApiKey extends ApiKeyRow {
  /** Plaintext secret; shown only here. Persisted as key_hash only. */
  key: string;
}

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateKey(): { plaintext: string; prefix: string; hash: string } {
  const secret = randomBytes(16).toString("hex"); // 32 hex chars
  const plaintext = `${PREFIX}${secret}`;
  return {
    plaintext,
    prefix: `${PREFIX}${secret.slice(0, 8)}`,
    hash: hashKey(plaintext),
  };
}

export function hashApiKey(plaintext: string): string {
  return hashKey(plaintext);
}

export function isApiKeyFormat(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function createApiKeyService(db: Database) {
  return {
    /** Create a key for a user. Returns the plaintext once. */
    async create(userId: number, name: string): Promise<CreatedApiKey> {
      const { plaintext, prefix, hash } = generateKey();
      const result = await db.run(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)`,
        userId,
        name,
        prefix,
        hash,
      );
      const row = await this.getById(Number(result.lastInsertRowid), userId);
      return { ...row!, key: plaintext };
    },

    async getById(id: number, userId: number): Promise<ApiKeyRow | null> {
      return db.get<ApiKeyRow>(
        "SELECT id, user_id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE id = ? AND user_id = ?",
        id,
        userId,
      );
    },

    /** List keys for a user (never returns the hash or plaintext). */
    async list(userId: number): Promise<ApiKeyRow[]> {
      return db.all<ApiKeyRow>(
        "SELECT id, user_id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY id DESC",
        userId,
      );
    },

    /** Revoke (soft delete) a key. */
    async revoke(id: number, userId: number): Promise<void> {
      const row = await this.getById(id, userId);
      if (!row) throw new NotFoundError("API key", id);
      await db.run("UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", id, userId);
    },

    /**
     * Look up a key by its plaintext and return the owning user id if the key
     * is valid and not revoked. Also updates last_used_at.
     */
    async authenticate(plaintext: string): Promise<{ userId: number } | null> {
      const hash = hashKey(plaintext);
      const row = await db.get<{ id: number; user_id: number; revoked_at: string | null }>(
        "SELECT id, user_id, revoked_at FROM api_keys WHERE key_hash = ?",
        hash,
      );
      if (!row || row.revoked_at) return null;
      await db.run("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", row.id);
      return { userId: row.user_id };
    },
  };
}

export type ApiKeyService = ReturnType<typeof createApiKeyService>;
