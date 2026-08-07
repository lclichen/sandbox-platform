/**
 * Centralized configuration loaded from environment variables.
 *
 * All env access goes through this module so the rest of the codebase can stay
 * testable and free of scattered `process.env` reads.
 */
import "dotenv/config";

function required(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export type DbDialect = "sqlite" | "postgresql";
export type ExecutorKind = "mock" | "ssh" | "apptainer-cli";

function asDialect(value: string): DbDialect {
  if (value === "postgresql" || value === "sqlite") return value;
  throw new Error(`Unsupported DB_DIALECT: ${value}. Use "sqlite" or "postgresql".`);
}

function asExecutorKind(value: string): ExecutorKind {
  if (value === "mock" || value === "ssh" || value === "apptainer-cli") return value;
  throw new Error(`Unsupported EXECUTOR_KIND: ${value}. Use "mock", "ssh", or "apptainer-cli".`);
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  host: string;
  db: {
    dialect: DbDialect;
    sqlitePath: string;
    postgresUrl: string | undefined;
  };
  auth: {
    jwtSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  seed: {
    adminUsername: string;
    adminPassword: string;
  };
  executor: {
    kind: ExecutorKind;
    ssh: {
      host: string | undefined;
      port: number;
      username: string | undefined;
      privateKeyPath: string | undefined;
      password: string | undefined;
    };
    apptainer: {
      bin: string;
      overlayBaseDir: string;
      imageBaseDir: string;
    };
  };
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  cached = {
    nodeEnv: required("NODE_ENV", "development"),
    port: int("PORT", 3000),
    host: required("HOST", "0.0.0.0"),
    db: {
      dialect: asDialect(required("DB_DIALECT", "sqlite")),
      sqlitePath: required("DB_SQLITE_PATH", "./data/sandbox.db"),
      postgresUrl: optional("DATABASE_URL"),
    },
    auth: {
      jwtSecret: required("JWT_SECRET", "dev-insecure-secret-change-me"),
      accessTtl: required("JWT_ACCESS_TTL", "15m"),
      refreshTtl: required("JWT_REFRESH_TTL", "7d"),
    },
    seed: {
      adminUsername: required("SEED_ADMIN_USERNAME", "admin"),
      adminPassword: required("SEED_ADMIN_PASSWORD", "changeme123"),
    },
    executor: {
      kind: asExecutorKind(required("EXECUTOR_KIND", "mock")),
      ssh: {
        host: optional("SSH_HOST"),
        port: int("SSH_PORT", 22),
        username: optional("SSH_USERNAME"),
        privateKeyPath: optional("SSH_PRIVATE_KEY_PATH"),
        password: optional("SSH_PASSWORD"),
      },
      apptainer: {
        bin: required("APPTAINER_BIN", "apptainer"),
        overlayBaseDir: required("OVERLAY_BASE_DIR", "./data/overlays"),
        imageBaseDir: required("IMAGE_BASE_DIR", "./data/images"),
      },
    },
  };
  return cached;
}

/** Test-only: force a fresh config read (e.g. after mutating process.env). */
export function resetConfigForTesting(): void {
  cached = undefined;
}
