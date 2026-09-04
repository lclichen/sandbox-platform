/**
 * Baseline migration — the consolidated current state of the database.
 *
 * Fold of the former chain (0001_schema + 0002_seed + 0003_pi_web_integration
 * + 0004_remove_demo_images + 0005_snapshot_decouple + 0006_image_max_per_user)
 * into a single migration. Fresh databases get the complete schema and seed in
 * one step; databases that already ran the former chain are recognized by the
 * runner (see migrate.ts LEGACY_MIGRATION_IDS) and simply marked as being at
 * the baseline — the end state is identical.
 *
 * Net schema deltas folded in beyond the original 0001:
 *   users.must_change_password           (pi-web R9)
 *   resource_quotas.allowed_image_ids    (pi-web R6)
 *   images.overlay_kind / max_per_user   (dir-overlay opt-in; per-image cap)
 *   snapshots: container-owned → user-owned save points (nullable container,
 *          owner user_id NOT NULL, image_id, UNIQUE(user_id, name))
 *
 * Seed: quota tiers + bootstrap admin (SEED_ADMIN_*). The image catalogue
 * starts EMPTY — the former demo rows (sif paths that never exist on real
 * hosts) are not seeded; demo/mock stacks may opt in via SEED_DEMO_IMAGES=on.
 *
 * Dialect conventions:
 *   PK:    INTEGER PRIMARY KEY AUTOINCREMENT (sqlite) | SERIAL PRIMARY KEY (pg)
 *   time:  TEXT DEFAULT (datetime('now'))            | TIMESTAMPTZ DEFAULT NOW()
 *   bool:  INTEGER 0/1                               | BOOLEAN FALSE/TRUE
 *   json:  TEXT                                       | JSONB
 */
import bcrypt from "bcrypt";
import { loadConfig } from "../../config.ts";
import { encodeJson, type SqlValue } from "../driver.ts";
import type { Migration } from "../migrate.ts";

const QUOTA_TIERS = [
  {
    name: "default",
    description: "Standard user quota",
    max_containers: 2,
    max_cpu_cores: 2,
    max_memory_mb: 2048,
    max_disk_gb: 10,
    max_snapshots_per_container: 5,
    max_workspaces_per_user: 10,
  },
  {
    name: "admin",
    description: "Elevated quota for administrators",
    max_containers: 10,
    max_cpu_cores: 8,
    max_memory_mb: 16384,
    max_disk_gb: 50,
    max_snapshots_per_container: 20,
    max_workspaces_per_user: 50,
  },
  {
    name: "enterprise",
    description: "High-capacity tier for power users",
    max_containers: 20,
    max_cpu_cores: 16,
    max_memory_mb: 32768,
    max_disk_gb: 100,
    max_snapshots_per_container: 50,
    max_workspaces_per_user: 100,
  },
];

/** Demo catalogue rows — only seeded when SEED_DEMO_IMAGES=on (mock stacks). */
const DEMO_IMAGES = [
  {
    name: "ubuntu-22.04",
    display_name: "Ubuntu 22.04 LTS",
    sif_path: "/srv/apptainer/images/ubuntu-22.04.sif",
    description: "Minimal Ubuntu 22.04 LTS base image",
    tags: ["linux", "ubuntu", "base"],
    default_resources: { cpu: 1, memoryMb: 1024, diskGb: 5 },
  },
  {
    name: "node-20",
    display_name: "Node.js 20 (Bookworm)",
    sif_path: "/srv/apptainer/images/node-20.sif",
    description: "Node.js 20 runtime on Debian Bookworm",
    tags: ["linux", "node", "javascript"],
    default_resources: { cpu: 1, memoryMb: 2048, diskGb: 5 },
  },
  {
    name: "python-3.12",
    display_name: "Python 3.12 (Slim)",
    sif_path: "/srv/apptainer/images/python-3.12.sif",
    description: "Python 3.12 slim image for data and scripting work",
    tags: ["linux", "python", "data"],
    default_resources: { cpu: 1, memoryMb: 2048, diskGb: 5 },
  },
];

export const up: Migration["up"] = async ({ db }) => {
  const sqlite = db.dialect === "sqlite";
  const PK = sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "SERIAL PRIMARY KEY";
  const TS = sqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT NOW()";
  const TS_NULL = sqlite ? "TEXT" : "TIMESTAMPTZ";
  const JSON = sqlite ? "TEXT" : "JSONB";
  const BOOL_DEFAULT = (on: boolean) =>
    sqlite ? `INTEGER NOT NULL DEFAULT ${on ? 1 : 0}` : `BOOLEAN NOT NULL DEFAULT ${on ? "TRUE" : "FALSE"}`;

  // resource_quotas
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
      allowed_image_ids ${JSON},
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
      must_change_password ${BOOL_DEFAULT(false)},
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
      overlay_kind TEXT NOT NULL DEFAULT 'ext3',
      max_per_user INTEGER,
      created_at ${TS},
      updated_at ${TS}
    );
  `);

  // containers
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

  // snapshots — user-owned save points (survive container recycling)
  await db.exec(`
    CREATE TABLE snapshots (
      id ${PK},
      container_id INTEGER REFERENCES containers(id) ON DELETE SET NULL,
      overlay_id INTEGER REFERENCES overlays(id) ON DELETE SET NULL,
      user_id INTEGER NOT NULL,
      image_id INTEGER,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      overlay_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at ${TS},
      UNIQUE (user_id, name)
    );
    CREATE INDEX idx_snapshots_user ON snapshots(user_id);
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

  // operation_logs (hash-chained audit + purged_at soft delete)
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

  // refresh_tokens (rotation families)
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

  // llm_user_bindings (LiteLLM)
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

  // llm_virtual_keys (LiteLLM)
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

  // ---- seed: quota tiers + bootstrap admin ----
  for (const tier of QUOTA_TIERS) {
    await db.run(
      `INSERT INTO resource_quotas
        (name, description, max_containers, max_cpu_cores, max_memory_mb, max_disk_gb, max_snapshots_per_container, max_workspaces_per_user)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      tier.name,
      tier.description,
      tier.max_containers,
      tier.max_cpu_cores,
      tier.max_memory_mb,
      tier.max_disk_gb,
      tier.max_snapshots_per_container,
      tier.max_workspaces_per_user,
    );
  }

  const config = loadConfig();
  const quota = await db.get<{ id: number }>("SELECT id FROM resource_quotas WHERE name = 'admin'");
  if (!quota) throw new Error("admin quota tier missing; cannot seed admin user");
  const passwordHash = await bcrypt.hash(config.seed.adminPassword, 12);
  await db.run(
    `INSERT INTO users (username, password_hash, email, role, quota_id, status)
     VALUES (?, ?, ?, 'admin', ?, 'active')`,
    config.seed.adminUsername,
    passwordHash,
    "admin@localhost",
    quota.id,
  );

  // Demo images are opt-in (mock/demo stacks only): the sif paths point at
  // placeholder locations that never exist on real hosts — the real catalogue
  // starts empty and admins register images that actually exist.
  if (process.env.SEED_DEMO_IMAGES === "on" || process.env.SEED_DEMO_IMAGES === "1") {
    for (const image of DEMO_IMAGES) {
      await db.run(
        `INSERT INTO images (name, display_name, sif_path, description, is_public, tags, default_resources)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        image.name,
        image.display_name,
        image.sif_path,
        image.description,
        true,
        encodeJson(image.tags, db.dialect) as SqlValue,
        encodeJson(image.default_resources, db.dialect) as SqlValue,
      );
    }
  }
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
