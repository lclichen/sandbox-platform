/**
 * Baseline schema — the consolidated "current state" of the database.
 *
 * This is a fold of the original incremental migrations (0001_init + every
 * ALTER TABLE / CREATE TABLE added later) into one file. A fresh database gets
 * the complete, final schema in a single migration; existing deployments that
 * already ran the incrementals must be rebuilt (drop the DB, re-run migrate).
 *
 * Tables are created in foreign-key dependency order. Dialect-conditional DDL
 * uses the same conventions as the original migrations:
 *   PK:    INTEGER PRIMARY KEY AUTOINCREMENT (sqlite) | SERIAL PRIMARY KEY (pg)
 *   time:  TEXT DEFAULT (datetime('now'))            | TIMESTAMPTZ DEFAULT NOW()
 *   bool:  INTEGER 0/1                               | BOOLEAN FALSE/TRUE
 *   json:  TEXT                                       | JSONB
 */
import type { Migration } from "../migrate.ts";

function isSqlite(db: { dialect: string }): boolean {
  return db.dialect === "sqlite";
}

export const up: Migration["up"] = async ({ db }) => {
  const sqlite = isSqlite(db);
  // Dialect-conditional type fragments (kept short to keep the DDL readable).
  const PK = sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY";
  const TS = sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()";
  const TS_NULL = sqlite ? "TEXT" : "TIMESTAMPTZ";
  const JSON = sqlite ? "TEXT" : "JSONB";
  const BOOL_DEFAULT = (on: boolean) =>
    sqlite ? `INTEGER NOT NULL DEFAULT ${on ? 1 : 0}` : `BOOLEAN NOT NULL DEFAULT ${on ? "TRUE" : "FALSE"}`;

  // resource_quotas (+ max_workspaces_per_user from the workspaces migration)
  await db.exec(`
    CREATE TABLE resource_quotas (
      id ${PK},
      name VARCHAR(64) NOT NULL UNIQUE,
      description TEXT,
      max_containers INTEGER NOT NULL DEFAULT 2,
      max_cpu_cores INTEGER NOT NULL DEFAULT 2,
      max_memory_mb INTEGER NOT NULL DEFAULT 2048,
      max_disk_gb INTEGER NOT NULL DEFAULT 10,
      max_snapshots_per_container INTEGER NOT NULL DEFAULT 5,
      max_workspaces_per_user INTEGER NOT NULL DEFAULT 10,
      created_at ${TS},
      updated_at ${TS}
    );
  `);

  // users
  await db.exec(`
    CREATE TABLE users (
      id ${PK},
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      role VARCHAR(16) NOT NULL DEFAULT 'user',
      quota_id INTEGER REFERENCES resource_quotas(id),
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at ${TS},
      updated_at ${TS},
      last_login_at ${TS_NULL}
    );
  `);

  // images
  await db.exec(`
    CREATE TABLE images (
      id ${PK},
      name VARCHAR(128) NOT NULL UNIQUE,
      display_name VARCHAR(128) NOT NULL,
      sif_path TEXT NOT NULL,
      description TEXT,
      is_public ${BOOL_DEFAULT(true)},
      tags ${JSON},
      default_resources ${JSON},
      created_at ${TS},
      updated_at ${TS}
    );
  `);

  // containers (+ auto_stopped / auto_stopped_at from the reaper migration)
  await db.exec(`
    CREATE TABLE containers (
      id ${PK},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      image_id INTEGER NOT NULL REFERENCES images(id),
      name VARCHAR(128) NOT NULL,
      instance_name VARCHAR(128),
      status VARCHAR(24) NOT NULL DEFAULT 'creating',
      overlay_path TEXT,
      node VARCHAR(255),
      cpu INTEGER NOT NULL DEFAULT 1,
      memory_mb INTEGER NOT NULL DEFAULT 1024,
      disk_gb INTEGER NOT NULL DEFAULT 5,
      env ${JSON},
      error_message TEXT,
      auto_stopped ${BOOL_DEFAULT(false)},
      auto_stopped_at ${TS_NULL},
      created_at ${TS},
      updated_at ${TS},
      last_started_at ${TS_NULL},
      last_stopped_at ${TS_NULL}
    );
    CREATE INDEX idx_containers_user ON containers(user_id);
    CREATE INDEX idx_containers_status ON containers(status);
    CREATE INDEX idx_containers_reaper ON containers(status, last_started_at);
  `);

  // overlays
  await db.exec(`
    CREATE TABLE overlays (
      id ${PK},
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      is_current ${BOOL_DEFAULT(false)},
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at ${TS}
    );
    CREATE INDEX idx_overlays_container ON overlays(container_id);
  `);

  // snapshots
  await db.exec(`
    CREATE TABLE snapshots (
      id ${PK},
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      overlay_id INTEGER REFERENCES overlays(id) ON DELETE SET NULL,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      overlay_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at ${TS},
      UNIQUE (container_id, name)
    );
    CREATE INDEX idx_snapshots_container ON snapshots(container_id);
  `);

  // sessions
  await db.exec(`
    CREATE TABLE sessions (
      id ${PK},
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_ip VARCHAR(64),
      bytes_in BIGINT NOT NULL DEFAULT 0,
      bytes_out BIGINT NOT NULL DEFAULT 0,
      started_at ${TS},
      ended_at ${TS_NULL}
    );
    CREATE INDEX idx_sessions_container ON sessions(container_id);
  `);

  // operation_logs (+ prev_hash/hash audit chain + purged_at soft-delete)
  await db.exec(`
    CREATE TABLE operation_logs (
      id ${PK},
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(64) NOT NULL,
      resource_type VARCHAR(32) NOT NULL,
      resource_id INTEGER,
      detail ${JSON},
      ip VARCHAR(64),
      status VARCHAR(16) NOT NULL DEFAULT 'success',
      error_message TEXT,
      prev_hash TEXT,
      hash TEXT,
      purged_at ${TS_NULL},
      created_at ${TS}
    );
    CREATE INDEX idx_logs_user ON operation_logs(user_id);
    CREATE INDEX idx_logs_action ON operation_logs(action);
    CREATE INDEX idx_logs_resource ON operation_logs(resource_type, resource_id);
    CREATE INDEX idx_logs_created ON operation_logs(created_at);
    CREATE INDEX idx_logs_hash ON operation_logs(hash);
    CREATE INDEX idx_logs_purged ON operation_logs(purged_at);
  `);

  // refresh_tokens (+ family_id for refresh-rotation family cascade)
  await db.exec(`
    CREATE TABLE refresh_tokens (
      id ${PK},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL,
      family_id VARCHAR(64) NOT NULL DEFAULT '',
      expires_at ${TS} NOT NULL,
      revoked_at ${TS_NULL},
      client_ip VARCHAR(64),
      created_at ${TS}
    );
    CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
    CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
    CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
  `);

  // api_keys
  await db.exec(`
    CREATE TABLE api_keys (
      id ${PK},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(128) NOT NULL,
      key_prefix VARCHAR(16) NOT NULL,
      key_hash VARCHAR(255) NOT NULL UNIQUE,
      created_at ${TS},
      last_used_at ${TS_NULL},
      revoked_at ${TS_NULL}
    );
    CREATE INDEX idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
  `);

  // workspaces
  await db.exec(`
    CREATE TABLE workspaces (
      id ${PK},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      storage_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      source_container_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
      is_template ${BOOL_DEFAULT(false)},
      created_at ${TS},
      updated_at ${TS},
      UNIQUE(user_id, name)
    );
    CREATE INDEX idx_workspaces_user ON workspaces(user_id);
  `);

  // llm_user_bindings (LiteLLM integration)
  await db.exec(`
    CREATE TABLE llm_user_bindings (
      id ${PK},
      platform_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      litellm_user_id VARCHAR(128) NOT NULL UNIQUE,
      litellm_alias VARCHAR(128),
      max_budget NUMERIC(12,6) NOT NULL DEFAULT 0,
      budget_duration VARCHAR(16),
      models ${JSON},
      granted_at ${TS},
      granted_by INTEGER NOT NULL REFERENCES users(id),
      revoked_at ${TS_NULL},
      UNIQUE(platform_user_id)
    );
    CREATE INDEX idx_llm_bindings_user ON llm_user_bindings(platform_user_id);
  `);

  // llm_virtual_keys (LiteLLM integration)
  await db.exec(`
    CREATE TABLE llm_virtual_keys (
      id ${PK},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      litellm_key_hash VARCHAR(128) NOT NULL,
      litellm_key_id VARCHAR(128),
      key_prefix VARCHAR(32) NOT NULL,
      encrypted_key TEXT NOT NULL,
      name VARCHAR(128) NOT NULL,
      models ${JSON},
      max_budget NUMERIC(12,6),
      budget_duration VARCHAR(16),
      created_at ${TS},
      last_used_at ${TS_NULL},
      revoked_at ${TS_NULL}
    );
    CREATE INDEX idx_llm_keys_user ON llm_virtual_keys(user_id);
    CREATE INDEX idx_llm_keys_hash ON llm_virtual_keys(litellm_key_hash);
  `);
};

export const down: Migration["down"] = async ({ db }) => {
  // Drop in reverse dependency order. IF EXISTS so this is safe on partial state.
  await db.exec(`
    DROP TABLE IF EXISTS llm_virtual_keys;
    DROP TABLE IF EXISTS llm_user_bindings;
    DROP TABLE IF EXISTS workspaces;
    DROP TABLE IF EXISTS api_keys;
    DROP TABLE IF EXISTS refresh_tokens;
    DROP TABLE IF EXISTS operation_logs;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS snapshots;
    DROP TABLE IF EXISTS overlays;
    DROP TABLE IF EXISTS containers;
    DROP TABLE IF EXISTS images;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS resource_quotas;
  `);
};

const migration: Migration = { id: "0001_schema", up, down };
export default migration;
