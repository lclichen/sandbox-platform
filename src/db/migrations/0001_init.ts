/**
 * Initial schema for the sandbox platform.
 *
 * Dialect-aware: where sqlite and postgresql differ (JSON columns, timestamp
 * defaults, boolean storage), we branch on db.dialect.
 *
 * Tables:
 *   resource_quotas  per-user resource limits
 *   users            accounts (admin/user roles)
 *   images           base SIF image catalogue managed by admins
 *   containers       user sandboxes (Apptainer instances)
 *   overlays         persistent overlay layers (writable diff)
 *   snapshots        named copies of an overlay (field-recovery)
 *   sessions         connection session records (relay accounting)
 *   operation_logs   audit trail
 *   refresh_tokens   JWT refresh token rotation tracking
 */
import type { Migration } from "../migrate.ts";

function isSqlite(db: { dialect: string }): boolean {
  return db.dialect === "sqlite";
}

export const up: Migration["up"] = async ({ db }) => {
  const sqlite = isSqlite(db);

  // resource_quotas
  await db.exec(`
    CREATE TABLE resource_quotas (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      name VARCHAR(64) NOT NULL UNIQUE,
      description TEXT,
      max_containers INTEGER NOT NULL DEFAULT 2,
      max_cpu_cores INTEGER NOT NULL DEFAULT 2,
      max_memory_mb INTEGER NOT NULL DEFAULT 2048,
      max_disk_gb INTEGER NOT NULL DEFAULT 10,
      max_snapshots_per_container INTEGER NOT NULL DEFAULT 5,
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      updated_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"}
    );
  `);

  // users
  await db.exec(`
    CREATE TABLE users (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      role VARCHAR(16) NOT NULL DEFAULT 'user',
      quota_id INTEGER ${sqlite ? "" : ""} REFERENCES resource_quotas(id),
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      updated_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      last_login_at ${sqlite ? "TEXT" : "TIMESTAMPTZ"}
    );
  `);

  // images
  await db.exec(`
    CREATE TABLE images (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      name VARCHAR(128) NOT NULL UNIQUE,
      display_name VARCHAR(128) NOT NULL,
      sif_path TEXT NOT NULL,
      description TEXT,
      is_public ${sqlite ? "INTEGER NOT NULL DEFAULT 1" : "BOOLEAN NOT NULL DEFAULT TRUE"},
      tags ${sqlite ? "TEXT" : "JSONB"},
      default_resources ${sqlite ? "TEXT" : "JSONB"},
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      updated_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"}
    );
  `);

  // containers
  await db.exec(`
    CREATE TABLE containers (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
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
      env ${sqlite ? "TEXT" : "JSONB"},
      error_message TEXT,
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      updated_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      last_started_at ${sqlite ? "TEXT" : "TIMESTAMPTZ"},
      last_stopped_at ${sqlite ? "TEXT" : "TIMESTAMPTZ"}
    );
    CREATE INDEX idx_containers_user ON containers(user_id);
    CREATE INDEX idx_containers_status ON containers(status);
  `);

  // overlays
  await db.exec(`
    CREATE TABLE overlays (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      is_current ${sqlite ? "INTEGER NOT NULL DEFAULT 0" : "BOOLEAN NOT NULL DEFAULT FALSE"},
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"}
    );
    CREATE INDEX idx_overlays_container ON overlays(container_id);
  `);

  // snapshots
  await db.exec(`
    CREATE TABLE snapshots (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      overlay_id INTEGER REFERENCES overlays(id) ON DELETE SET NULL,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      overlay_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      UNIQUE (container_id, name)
    );
    CREATE INDEX idx_snapshots_container ON snapshots(container_id);
  `);

  // sessions
  await db.exec(`
    CREATE TABLE sessions (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_ip VARCHAR(64),
      bytes_in BIGINT NOT NULL DEFAULT 0,
      bytes_out BIGINT NOT NULL DEFAULT 0,
      started_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"},
      ended_at ${sqlite ? "TEXT" : "TIMESTAMPTZ"}
    );
    CREATE INDEX idx_sessions_container ON sessions(container_id);
  `);

  // operation_logs
  await db.exec(`
    CREATE TABLE operation_logs (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(64) NOT NULL,
      resource_type VARCHAR(32) NOT NULL,
      resource_id INTEGER,
      detail ${sqlite ? "TEXT" : "JSONB"},
      ip VARCHAR(64),
      status VARCHAR(16) NOT NULL DEFAULT 'success',
      error_message TEXT,
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"}
    );
    CREATE INDEX idx_logs_user ON operation_logs(user_id);
    CREATE INDEX idx_logs_action ON operation_logs(action);
    CREATE INDEX idx_logs_resource ON operation_logs(resource_type, resource_id);
    CREATE INDEX idx_logs_created ON operation_logs(created_at);
  `);

  // refresh_tokens
  await db.exec(`
    CREATE TABLE refresh_tokens (
      id ${sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY"},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL,
      expires_at ${sqlite ? "TEXT NOT NULL" : "TIMESTAMPTZ NOT NULL"},
      revoked_at ${sqlite ? "TEXT" : "TIMESTAMPTZ"},
      client_ip VARCHAR(64),
      created_at ${sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()"}
    );
    CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
    CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
  `);
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec(`
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

const migration: Migration = { id: "0001_init", up, down };
export default migration;
