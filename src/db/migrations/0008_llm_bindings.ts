/**
 * LLM integration tables: map platform users to LiteLLM proxy users and store
 * the virtual keys the platform issues on their behalf.
 *
 * Design notes (see plan):
 * - We do NOT add an external_id column to `users`; a separate binding table
 *   keeps the LiteLLM concern decoupled and cascades cleanly on user delete.
 * - LiteLLM returns virtual-key plaintext only once. The platform must hand it
 *   back to users/containers later, so it is stored reversibly encrypted
 *   (AES-256-GCM) — unlike platform API keys, which are one-way hashed.
 * - Budget enforcement lives in LiteLLM (max_budget + budget_duration); the
 *   mirrored columns here are for display and re-issue, not for enforcement.
 */
import type { Migration } from "../migrate.ts";

function isSqlite(db: { dialect: string }): boolean {
  return db.dialect === "sqlite";
}

export const up: Migration["up"] = async ({ db }) => {
  const sqlite = isSqlite(db);
  const jsonType = sqlite ? "TEXT" : "JSONB";
  const ts = sqlite ? "TEXT" : "TIMESTAMPTZ";
  const tsNow = sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()";

  // llm_user_bindings: one row per platform user granted LLM access.
  await db.exec(`
    CREATE TABLE llm_user_bindings (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      platform_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      litellm_user_id VARCHAR(128) NOT NULL UNIQUE,
      litellm_alias VARCHAR(128),
      max_budget NUMERIC(12,6) NOT NULL DEFAULT 0,
      budget_duration VARCHAR(16),
      models ${jsonType},
      granted_at ${tsNow},
      granted_by INTEGER NOT NULL REFERENCES users(id),
      revoked_at ${ts},
      UNIQUE(platform_user_id)
    );
    CREATE INDEX idx_llm_bindings_user ON llm_user_bindings(platform_user_id);
  `);

  // llm_virtual_keys: LiteLLM virtual keys the platform manages on behalf of users.
  await db.exec(`
    CREATE TABLE llm_virtual_keys (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      litellm_key_hash VARCHAR(128) NOT NULL,
      litellm_key_id VARCHAR(128),
      key_prefix VARCHAR(32) NOT NULL,
      encrypted_key TEXT NOT NULL,
      name VARCHAR(128) NOT NULL,
      models ${jsonType},
      max_budget NUMERIC(12,6),
      budget_duration VARCHAR(16),
      created_at ${tsNow},
      last_used_at ${ts},
      revoked_at ${ts}
    );
    CREATE INDEX idx_llm_keys_user ON llm_virtual_keys(user_id);
    CREATE INDEX idx_llm_keys_hash ON llm_virtual_keys(litellm_key_hash);
  `);
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec(`
    DROP TABLE IF EXISTS llm_virtual_keys;
    DROP TABLE IF EXISTS llm_user_bindings;
  `);
};

const migration: Migration = { id: "0008_llm_bindings", up, down };
export default migration;
