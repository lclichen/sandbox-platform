/**
 * API keys: long-lived personal credentials.
 *
 * The plaintext key is shown only at creation time; the DB stores a SHA-256
 * hash plus a short prefix for identification in listings. Keys do not expire;
 * they are revoked by setting revoked_at.
 */
import type { Migration } from "../migrate.ts";

function isSqlite(db: { dialect: string }): boolean {
  return db.dialect === "sqlite";
}

export const up: Migration["up"] = async ({ db }) => {
  const sqlite = isSqlite(db);
  await db.exec(`
    CREATE TABLE api_keys (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(128) NOT NULL,
      key_prefix VARCHAR(16) NOT NULL,
      key_hash VARCHAR(255) NOT NULL UNIQUE,
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      last_used_at ${sqlite ? "TEXT" : "TIMESTAMPTZ"},
      revoked_at ${sqlite ? "TEXT" : "TIMESTAMPTZ"}
    );
    CREATE INDEX idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
  `);
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec(`DROP TABLE IF EXISTS api_keys;`);
};

const migration: Migration = { id: "0003_api_keys", up, down };
export default migration;
