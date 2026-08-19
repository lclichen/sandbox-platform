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

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export type DbDialect = "sqlite" | "postgresql";
export type ExecutorKind = "mock" | "ssh" | "apptainer-cli";
export type RegisterMode = "off" | "open" | "approval";

function asRegisterMode(value: string): RegisterMode {
  if (value === "off" || value === "open" || value === "approval") return value;
  throw new Error(`Unsupported REGISTER_MODE: ${value}. Use "off", "open", or "approval".`);
}

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
  /** Number of reverse-proxy hops (0 = direct client). See rate-limit.ts. */
  trustProxy: number;
  /** Optional bearer token guarding /metrics. Unset = open (dev only). */
  metricsToken: string | undefined;
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
  /** R1: self-registration switch + defaults. */
  register: {
    mode: RegisterMode;
    /** resource_quotas.name assigned to self-registered accounts. */
    defaultQuotaName: string;
  };
  /** R9: password policy applied to register/admin-create/password-change. */
  passwordPolicy: {
    minLength: number;
    /** When true, require upper+lower+digit (special chars optional). */
    requireComplexity: boolean;
  };
  rateLimit: {
    enabled: boolean;
    loginPerMinute: number;
    refreshPerMinute: number;
    bashPerMinute: number;
    llmRevealPerMinute: number;
    registerPerMinute: number;
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
      workspaceBaseDir: string;
      /** Append --cpus/--memory to instance start. Requires cgroup support on
       *  the host (setuid install or cgroups v2); rootless + cgroup v1 fails
       *  with "rootless cgroups requires cgroups v2", so default OFF. */
      resourceLimits: boolean;
    };
  };
  reaper: {
    enabled: boolean;
    intervalMinutes: number;
    idleAutoStopHours: number;
    autoStopSnapshot: boolean;
    snapshotTier: string;
    auditRetentionDays: number;
  };
  /** R2: interactive PTY WebSocket limits. */
  pty: {
    /** Concurrent PTY sessions per container. */
    maxPerContainer: number;
    /** Kill PTY sessions with no client traffic for this many minutes. */
    idleTimeoutMinutes: number;
  };
  /** R5: workspace file limits + chunked-upload retention. */
  workspace: {
    /** Hard cap for a single uploaded file (bytes). */
    uploadMaxBytes: number;
    /** Directory names skipped by the tree endpoint (comma-separated env). */
    treeIgnore: string[];
    /** Incomplete chunked uploads older than this are swept (hours). */
    uploadTtlHours: number;
  };
  /** R6: one-click sandbox provisioning defaults for pi-web. */
  provision: {
    /** Default image id for "new user first session" provisioning (0 = unset). */
    defaultImageId: number;
    /** Template workspace id seeded into provisioned containers (0 = unset). */
    defaultWorkspaceId: number;
  };
  llm: {
    /** Master switch. When false, all /api/v1/*llm* routes return 503. */
    enabled: boolean;
    /** AES-256-GCM key (64 hex chars) for encrypting LiteLLM virtual-key plaintext. */
    encryptionKey: string | undefined;
    litellm: {
      /** Endpoint the platform uses to call LiteLLM management APIs. */
      baseUrl: string;
      /** Endpoint given to users/containers to drive LLM traffic directly. */
      publicBaseUrl: string;
      /** LiteLLM master key (sk-...), used to authenticate management calls. */
      masterKey: string | undefined;
      /** Per-request timeout for LiteLLM calls. */
      timeoutMs: number;
    };
  };
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const nodeEnv = required("NODE_ENV", "development");
  cached = {
    nodeEnv,
    port: int("PORT", 3000),
    host: required("HOST", "0.0.0.0"),
    trustProxy: int("TRUST_PROXY", 0),
    metricsToken: optional("METRICS_TOKEN"),
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
    register: {
      mode: asRegisterMode(required("REGISTER_MODE", "off")),
      defaultQuotaName: required("REGISTER_DEFAULT_QUOTA_NAME", "default"),
    },
    passwordPolicy: {
      minLength: int("PASSWORD_MIN_LENGTH", 8),
      requireComplexity: bool("PASSWORD_REQUIRE_COMPLEXITY", false),
    },
    // Brute-force / abuse protection is on by default in production.
    rateLimit: {
      enabled: bool("RATE_LIMIT_ENABLED", nodeEnv === "production"),
      loginPerMinute: int("RATE_LIMIT_LOGIN_PER_MINUTE", 10),
      refreshPerMinute: int("RATE_LIMIT_REFRESH_PER_MINUTE", 30),
      bashPerMinute: int("RATE_LIMIT_BASH_PER_MINUTE", 60),
      llmRevealPerMinute: int("RATE_LIMIT_LLM_REVEAL_PER_MINUTE", 5),
      registerPerMinute: int("RATE_LIMIT_REGISTER_PER_MINUTE", 5),
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
        workspaceBaseDir: required("WORKSPACE_BASE_DIR", "./data/workspaces"),
        resourceLimits: bool("APPTAINER_RESOURCE_LIMITS", false),
      },
    },
    reaper: {
      enabled: bool("REAPER_ENABLED", false),
      intervalMinutes: int("REAPER_INTERVAL_MINUTES", 30),
      idleAutoStopHours: int("IDLE_AUTO_STOP_HOURS", 168),
      autoStopSnapshot: bool("IDLE_AUTO_STOP_SNAPSHOT", true),
      snapshotTier: required("IDLE_AUTO_STOP_SNAPSHOT_TIER", "auto"),
      auditRetentionDays: int("AUDIT_RETENTION_DAYS", 90),
    },
    pty: {
      maxPerContainer: int("PTY_MAX_PER_CONTAINER", 3),
      idleTimeoutMinutes: int("PTY_IDLE_TIMEOUT_MINUTES", 30),
    },
    workspace: {
      uploadMaxBytes: int("WORKSPACE_UPLOAD_MAX_BYTES", 200 * 1024 * 1024),
      treeIgnore: required("WORKSPACE_TREE_IGNORE", "node_modules,.git,dist,build")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      uploadTtlHours: int("WORKSPACE_UPLOAD_TTL_HOURS", 24),
    },
    provision: {
      defaultImageId: int("PROVISION_DEFAULT_IMAGE_ID", 0),
      defaultWorkspaceId: int("PROVISION_DEFAULT_WORKSPACE_ID", 0),
    },
    llm: {
      enabled: bool("LLM_ENABLED", false),
      encryptionKey: optional("LLM_ENCRYPTION_KEY"),
      litellm: {
        baseUrl: required("LITELLM_BASE_URL", "http://localhost:4000"),
        publicBaseUrl: required("LITELLM_PUBLIC_BASE_URL", "http://localhost:4000"),
        masterKey: optional("LITELLM_MASTER_KEY"),
        timeoutMs: int("LITELLM_TIMEOUT_MS", 30000),
      },
    },
  };
  return cached;
}

/** Test-only: force a fresh config read (e.g. after mutating process.env). */
export function resetConfigForTesting(): void {
  cached = undefined;
}

/** Secrets that must never be used in production (code default + .env.example value). */
const KNOWN_WEAK_JWT_SECRETS = new Set([
  "dev-insecure-secret-change-me",
  "change-me-in-production-please-use-a-long-random-string",
]);
const INSECURE_DEFAULT_ADMIN_PASSWORD = "changeme123";
/** LiteLLM master-key placeholders that must not survive into production. */
const KNOWN_WEAK_LITELLM_KEYS = new Set(["sk-1234", "sk-123456"]);

/**
 * Fail fast in production when secrets are left at their known-insecure
 * defaults. Returns the list of problems (empty when all is well) so callers
 * can print remediation guidance before exiting.
 */
export function assertSecureProductionConfig(config: AppConfig): string[] {
  if (config.nodeEnv !== "production") return [];
  const problems: string[] = [];
  if (!config.auth.jwtSecret || KNOWN_WEAK_JWT_SECRETS.has(config.auth.jwtSecret)) {
    problems.push(
      "JWT_SECRET is set to a known insecure value. Generate one with: openssl rand -hex 32",
    );
  } else if (config.auth.jwtSecret.length < 32) {
    problems.push("JWT_SECRET is shorter than 32 characters; use: openssl rand -hex 32");
  }
  if (config.seed.adminPassword === INSECURE_DEFAULT_ADMIN_PASSWORD) {
    problems.push(
      "SEED_ADMIN_PASSWORD is set to the insecure default 'changeme123'. Set a strong password in .env.",
    );
  }
  // LLM integration (optional). When enabled in production, both the LiteLLM
  // master key and the local encryption key must be real secrets.
  if (config.llm.enabled) {
    const mk = config.llm.litellm.masterKey;
    if (!mk || KNOWN_WEAK_LITELLM_KEYS.has(mk)) {
      problems.push(
        "LITELLM_MASTER_KEY is missing or a known placeholder. Generate one with: openssl rand -hex 24 (must start with 'sk-').",
      );
    }
    const ek = config.llm.encryptionKey;
    if (!ek || ek.length !== 64 || !/^[0-9a-fA-F]+$/.test(ek)) {
      problems.push(
        "LLM_ENCRYPTION_KEY must be 64 hex chars (32 bytes) when LLM_ENABLED=true. Generate with: openssl rand -hex 32",
      );
    }
  }
  return problems;
}
