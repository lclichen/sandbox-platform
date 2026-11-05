/**
 * Centralized configuration loaded from environment variables.
 *
 * All env access goes through this module so the rest of the codebase can stay
 * testable and free of scattered `process.env` reads.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import type { ExecutorKind as ConcreteExecutorKind } from "./executors/types.ts";

/**
 * Package root (the directory containing src/): data-dir DEFAULTS and any
 * RELATIVE env-provided paths resolve against this, NOT process.cwd() — the
 * deployment tree must be relocatable (launchable from any cwd / systemd /
 * packaged) without silently scattering data.
 */
export const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Resolve a possibly-relative path against the package root. */
export function resolveAppPath(value: string): string {
  return isAbsolute(value) ? value : pathResolve(APP_ROOT, value);
}

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
  // "on" is the repo's documented style (e.g. METRICS_PUBLIC=on,
  // SEED_DEMO_IMAGES=on) — accept it alongside true/1.
  return raw === "true" || raw === "1" || raw === "on";
}

export type DbDialect = "sqlite" | "postgresql";
/**
 * EXECUTOR_KIND additionally accepts "auto" (probe at startup). The concrete
 * kinds come from the executor layer so the two unions cannot drift apart.
 */
export type ExecutorKind = ConcreteExecutorKind | "auto";
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
  if (value === "mock" || value === "ssh" || value === "apptainer-cli" || value === "auto") return value;
  throw new Error(`Unsupported EXECUTOR_KIND: ${value}. Use "mock", "ssh", "apptainer-cli", or "auto".`);
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  host: string;
  /** Number of reverse-proxy hops (0 = direct client). See rate-limit.ts. */
  trustProxy: number;
  /** Optional bearer token guarding /metrics. Unset = 503 unless metricsPublic. */
  metricsToken: string | undefined;
  /** Explicitly expose /metrics without a token (METRICS_PUBLIC=on). */
  metricsPublic: boolean;
  db: {
    dialect: DbDialect;
    sqlitePath: string;
    postgresUrl: string | undefined;
  };
  auth: {
    jwtSecret: string;
    /** True when JWT_SECRET was unset and an ephemeral random was generated
     *  (dev convenience): tokens do not survive a restart in that mode. */
    jwtSecretEphemeral: boolean;
    accessTtl: string;
    refreshTtl: string;
  };
  seed: {
    adminUsername: string;
    adminPassword: string;
  };
  /** R1: self-registration switch + defaults. */
  /** OIDC（标准 OpenID Connect）登录：授权码流 + PKCE，自动建户。
   * 独立于 register.mode——IdP 已完成身份核验，不受本地自助注册开关约束；
   * admin 本地账号不受影响，OIDC 用户恒为 user 角色。 */
  oidc: {
    enabled: boolean;
    /** IdP issuer（发现文档取 <issuer>/.well-known/openid-configuration）。 */
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    /** 登录页按钮文案（如“统一身份登录”）。 */
    label: string;
    scopes: string;
    /** 无发现文档的 IdP 可显式覆盖三个端点。 */
    authorizationEndpoint: string | undefined;
    tokenEndpoint: string | undefined;
    jwksUri: string | undefined;
    /** 允许回跳的 pi-web 地址前缀（OIDC_ALLOWED_REDIRECTS，逗号分隔）。 */
    allowedRedirectPrefixes: string[];
    /** 显式允许明文 HTTP OIDC 端点（默认拒绝；仅限隔离内网测试）。 */
    allowInsecureHttp: boolean;
  };
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
    oidcPerMinute: number;
    changePasswordPerMinute: number;
  };
  http: {
    /** express.json body limit (e.g. "16mb"); applies to JSON requests only. */
    jsonBodyLimit: string;
  };
  /** Per-request caps for the tools relay (read/grep/find/bash). */
  tools: {
    readMaxBytes: number;
    grepMaxPatternChars: number;
    grepMaxLineChars: number;
    walkMaxFiles: number;
    walkMaxDepth: number;
    /** Wall-clock budget for one grep/find walk (default 60s). */
    walkTimeoutMs: number;
    /** Executor-side buffer cap for one bash call (stdout+stderr). */
    bashOutputMaxBytes: number;
    /** Upper bound accepted for a client-requested bash timeout. */
    bashMaxTimeoutSeconds: number;
  };
  executor: {
    kind: ExecutorKind;
    ssh: {
      host: string | undefined;
      port: number;
      username: string | undefined;
      privateKeyPath: string | undefined;
      password: string | undefined;
      /** Remote-node base dirs (paths on the COMPUTE node, not local). */
      overlayBaseDir: string;
      seedBaseDir: string;
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
    /** WebSocket frame cap (bytes). */
    maxFrameBytes: number;
    /** Per-session input budget, sliding one-second window. */
    inputBytesPerSecond: number;
    /** Per-session lifetime input budget. */
    inputBytesTotal: number;
  };
  /** R5: workspace file limits + chunked-upload retention. */
  workspace: {
    /** Hard cap for a single uploaded file (bytes). Default 2 GiB. */
    uploadMaxBytes: number;
    /** Cap for one chunked-upload part (bytes). */
    uploadPartMaxBytes: number;
    /** Directory names skipped by the tree endpoint (comma-separated env). */
    treeIgnore: string[];
    /** Maximum depth accepted by GET /workspaces/:id/tree. */
    treeMaxDepth: number;
    /** Maximum entries returned by one tree request. */
    treeMaxEntries: number;
    /** Cap for buffering a container /workspace export tar (bytes). */
    exportMaxBytes: number;
    /** Incomplete chunked uploads older than this are swept (hours). */
    uploadTtlHours: number;
  };
  /** Per-container input/output mount caps. */
  mounts: {
    maxInputs: number;
    maxInputBytes: number;
  };
  /** R6: one-click sandbox provisioning defaults for pi-web. */
  provision: {
    /** Default image id for "new user first session" provisioning (0 = unset). */
    defaultImageId: number;
    /** Template workspace id seeded into provisioned containers (0 = unset). */
    defaultWorkspaceId: number;
  };
  llm: {
    /** Master switch. When false, all /api/v1/*llm* routes return 501. */
    enabled: boolean;
    /** AES-256-GCM key (64 hex chars) for encrypting gateway-key plaintext. */
    encryptionKey: string | undefined;
    gateway: {
      /** agentgateway admin API (config resources + request logs). */
      adminUrl: string;
      /** Optional bearer token for the admin API (AGENTGATEWAY_ADMIN_TOKEN). */
      adminToken: string | undefined;
      /** OpenAI-compatible data-plane endpoint handed to users/containers. */
      publicBaseUrl: string;
      /** Per-request timeout for admin-API calls. */
      timeoutMs: number;
    };
  };
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const nodeEnv = required("NODE_ENV", "development");

  // JWT secret: fail-closed. A KNOWN placeholder is refused in EVERY env —
  // "development" is not evidence that a deployment is unreachable. Unset →
  // generate an ephemeral random (tokens die on restart; fine for dev, and
  // never a world-guessable key).
  const jwtSecretRaw = optional("JWT_SECRET");
  if (jwtSecretRaw && KNOWN_WEAK_JWT_SECRETS.has(jwtSecretRaw)) {
    throw new Error(
      "JWT_SECRET is set to a known insecure placeholder — refusing to start in any environment. " +
      "Replace it in .env with: openssl rand -hex 32",
    );
  }
  const jwtSecret = jwtSecretRaw ?? randomBytes(32).toString("hex");

  cached = {
    nodeEnv,
    port: int("PORT", 3000),
    host: required("HOST", "0.0.0.0"),
    trustProxy: int("TRUST_PROXY", 0),
    metricsToken: optional("METRICS_TOKEN"),
    metricsPublic: bool("METRICS_PUBLIC", false),
    db: {
      dialect: asDialect(required("DB_DIALECT", "sqlite")),
      sqlitePath: resolveAppPath(required("DB_SQLITE_PATH", "./data/sandbox.db")),
      postgresUrl: optional("DATABASE_URL"),
    },
    auth: {
      jwtSecret,
      jwtSecretEphemeral: !jwtSecretRaw,
      accessTtl: required("JWT_ACCESS_TTL", "15m"),
      refreshTtl: required("JWT_REFRESH_TTL", "7d"),
    },
    seed: {
      adminUsername: required("SEED_ADMIN_USERNAME", "admin"),
      adminPassword: required("SEED_ADMIN_PASSWORD", "changeme123"),
    },
    oidc: {
      enabled: bool("OIDC_ENABLED", false),
      issuerUrl: required("OIDC_ISSUER_URL", ""),
      clientId: required("OIDC_CLIENT_ID", ""),
      clientSecret: required("OIDC_CLIENT_SECRET", ""),
      label: required("OIDC_LABEL", "OIDC"),
      scopes: required("OIDC_SCOPES", "openid profile email"),
      authorizationEndpoint: optional("OIDC_AUTHORIZATION_ENDPOINT"),
      tokenEndpoint: optional("OIDC_TOKEN_ENDPOINT"),
      jwksUri: optional("OIDC_JWKS_URI"),
      allowedRedirectPrefixes: (required("OIDC_ALLOWED_REDIRECTS", ""))
        .split(",").map((x) => x.trim()).filter(Boolean),
      allowInsecureHttp: bool("OIDC_ALLOW_INSECURE_HTTP", false),
    },
    register: {
      mode: asRegisterMode(required("REGISTER_MODE", "off")),
      defaultQuotaName: required("REGISTER_DEFAULT_QUOTA_NAME", "default"),
    },
    passwordPolicy: {
      minLength: int("PASSWORD_MIN_LENGTH", 8),
      requireComplexity: bool("PASSWORD_REQUIRE_COMPLEXITY", false),
    },
    // Brute-force / abuse protection defaults ON in every environment.
    rateLimit: {
      enabled: bool("RATE_LIMIT_ENABLED", true),
      loginPerMinute: int("RATE_LIMIT_LOGIN_PER_MINUTE", 10),
      refreshPerMinute: int("RATE_LIMIT_REFRESH_PER_MINUTE", 30),
      bashPerMinute: int("RATE_LIMIT_BASH_PER_MINUTE", 60),
      llmRevealPerMinute: int("RATE_LIMIT_LLM_REVEAL_PER_MINUTE", 5),
      registerPerMinute: int("RATE_LIMIT_REGISTER_PER_MINUTE", 5),
      oidcPerMinute: int("RATE_LIMIT_OIDC_PER_MINUTE", 300),
      changePasswordPerMinute: int("RATE_LIMIT_CHANGE_PASSWORD_PER_MINUTE", 5),
    },
    http: {
      jsonBodyLimit: required("HTTP_JSON_BODY_LIMIT", "16mb"),
    },
    tools: {
      readMaxBytes: int("TOOLS_READ_MAX_BYTES", 2 * 1024 * 1024),
      grepMaxPatternChars: int("TOOLS_GREP_MAX_PATTERN_CHARS", 1_000),
      grepMaxLineChars: int("TOOLS_GREP_MAX_LINE_CHARS", 10_000),
      walkMaxFiles: int("TOOLS_WALK_MAX_FILES", 20_000),
      walkMaxDepth: int("TOOLS_WALK_MAX_DEPTH", 32),
      // User-requested default: one minute per grep/find walk.
      walkTimeoutMs: int("TOOLS_WALK_TIMEOUT_MS", 60_000),
      bashOutputMaxBytes: int("TOOLS_BASH_OUTPUT_MAX_BYTES", 8 * 1024 * 1024),
      bashMaxTimeoutSeconds: int("TOOLS_BASH_MAX_TIMEOUT_SECONDS", 3_600),
    },
    executor: {
      // "auto" (the default) probes ssh → apptainer-cli and hard-fails when
      // neither is configured; mock must be chosen EXPLICITLY. It used to be
      // the silent default, which made a host-shell "container" the
      // fail-open path for every misconfigured deployment.
      kind: asExecutorKind(required("EXECUTOR_KIND", "auto")),
      ssh: {
        host: optional("SSH_HOST"),
        port: int("SSH_PORT", 22),
        username: optional("SSH_USERNAME"),
        privateKeyPath: optional("SSH_PRIVATE_KEY_PATH"),
        password: optional("SSH_PASSWORD"),
        /** Remote-node base dirs (paths on the COMPUTE node, not local). */
        overlayBaseDir: required("SSH_OVERLAY_BASE_DIR", "/srv/apptainer/overlays"),
        seedBaseDir: required("SSH_SEED_BASE_DIR", "/srv/apptainer/workspace-seeds"),
      },
      apptainer: {
        bin: required("APPTAINER_BIN", "apptainer"),
        overlayBaseDir: resolveAppPath(required("OVERLAY_BASE_DIR", "./data/overlays")),
        imageBaseDir: resolveAppPath(required("IMAGE_BASE_DIR", "./data/images")),
        workspaceBaseDir: resolveAppPath(required("WORKSPACE_BASE_DIR", "./data/workspaces")),
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
      maxFrameBytes: int("PTY_MAX_FRAME_BYTES", 1024 * 1024),
      inputBytesPerSecond: int("PTY_INPUT_BYTES_PER_SECOND", 256 * 1024),
      inputBytesTotal: int("PTY_INPUT_BYTES_TOTAL", 100 * 1024 * 1024),
    },
    workspace: {
      // 2 GiB default (was 200 MiB). Uploads/downloads are streamed, so this
      // is a policy cap rather than an in-memory buffer size.
      uploadMaxBytes: int("WORKSPACE_UPLOAD_MAX_BYTES", 2 * 1024 * 1024 * 1024),
      uploadPartMaxBytes: int("WORKSPACE_UPLOAD_PART_MAX_BYTES", 8 * 1024 * 1024),
      treeIgnore: required("WORKSPACE_TREE_IGNORE", "node_modules,.git,dist,build")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      treeMaxDepth: int("WORKSPACE_TREE_MAX_DEPTH", 32),
      treeMaxEntries: int("WORKSPACE_TREE_MAX_ENTRIES", 5_000),
      exportMaxBytes: int("WORKSPACE_EXPORT_MAX_BYTES", 512 * 1024 * 1024),
      uploadTtlHours: int("WORKSPACE_UPLOAD_TTL_HOURS", 24),
    },
    mounts: {
      maxInputs: int("CONTAINER_MAX_INPUT_MOUNTS", 32),
      maxInputBytes: int("CONTAINER_MAX_INPUT_BYTES", 1024 * 1024 * 1024),
    },
    provision: {
      defaultImageId: int("PROVISION_DEFAULT_IMAGE_ID", 0),
      defaultWorkspaceId: int("PROVISION_DEFAULT_WORKSPACE_ID", 0),
    },
    llm: {
      enabled: bool("LLM_ENABLED", false),
      encryptionKey: optional("LLM_ENCRYPTION_KEY"),
      gateway: {
        // agentgateway admin API (config/resources + logs), NOT the data plane.
        adminUrl: required("AGENTGATEWAY_ADMIN_URL", "http://localhost:15000"),
        adminToken: optional("AGENTGATEWAY_ADMIN_TOKEN"),
        // Data-plane OpenAI-compatible endpoint handed to clients/containers.
        publicBaseUrl: required("AGENTGATEWAY_LLM_PUBLIC_URL", "http://localhost:4000"),
        timeoutMs: int("AGENTGATEWAY_TIMEOUT_MS", 30000),
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

/**
 * Fail fast in production when secrets are left at their known-insecure
 * defaults. Returns the list of problems (empty when all is well) so callers
 * can print remediation guidance before exiting.
 */
/**
 * Fail fast when a writable data dir sits on a read-only filesystem — e.g. the
 * default ./data/* inside an AppImage squashfs mount or any package dir that
 * gets replaced on upgrade. Without this the platform boots healthy and only
 * fails much later (first workspace upload / image import) with EROFS.
 */
export function assertWritableDataDirs(config: AppConfig): void {
  const dirs: Array<[string, string]> = [
    ["DB_SQLITE_PATH", dirname(config.db.sqlitePath)],
  ];
  if (config.executor.kind === "apptainer-cli") {
    dirs.push(
      ["OVERLAY_BASE_DIR", config.executor.apptainer.overlayBaseDir],
      ["IMAGE_BASE_DIR", config.executor.apptainer.imageBaseDir],
      ["WORKSPACE_BASE_DIR", config.executor.apptainer.workspaceBaseDir],
    );
  }
  // SSH executor dirs are paths on the remote compute node — never probed here.
  for (const [envName, dir] of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      const probeFile = join(dir, `.write-probe-${process.pid}`);
      writeFileSync(probeFile, "ok");
      rmSync(probeFile);
    } catch (err) {
      throw new Error(
        `可写数据目录不可用: ${dir} (${envName})——只读文件系统或无权限。` +
        `平台会在首次写入（如工作区上传/镜像导入）时失败，请把 ${envName} 指向可写目录后重启。` +
        `原始错误: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function assertSecureProductionConfig(config: AppConfig): string[] {
  if (config.nodeEnv !== "production") return [];
  const problems: string[] = [];
  if (!config.auth.jwtSecret || KNOWN_WEAK_JWT_SECRETS.has(config.auth.jwtSecret)) {
    problems.push(
      "JWT_SECRET is set to a known insecure value. Generate one with: openssl rand -hex 32",
    );
  } else if (config.auth.jwtSecretEphemeral) {
    problems.push(
      "JWT_SECRET is unset — an ephemeral random was generated, which logs everyone out on every restart. Set a persistent secret: openssl rand -hex 32",
    );
  } else if (config.auth.jwtSecret.length < 32) {
    problems.push("JWT_SECRET is shorter than 32 characters; use: openssl rand -hex 32");
  }
  if (config.seed.adminPassword === INSECURE_DEFAULT_ADMIN_PASSWORD) {
    problems.push(
      "SEED_ADMIN_PASSWORD is set to the insecure default 'changeme123'. Set a strong password in .env.",
    );
  }
  if (config.executor.kind === "mock" && process.env.ALLOW_MOCK_EXECUTOR_IN_PRODUCTION !== "1") {
    problems.push(
      "EXECUTOR_KIND=mock executes user shells ON THE PLATFORM HOST (no isolation). Set EXECUTOR_KIND=ssh or apptainer-cli in production.",
    );
  }
  if (!config.rateLimit.enabled) {
    problems.push(
      "RATE_LIMIT_ENABLED=false disables brute-force protection in production. Set it to true.",
    );
  }
  if (config.oidc.enabled) {
    if (!config.oidc.issuerUrl || !config.oidc.clientId) {
      problems.push("OIDC_ENABLED=true requires OIDC_ISSUER_URL and OIDC_CLIENT_ID.");
    }
    if (config.oidc.allowedRedirectPrefixes.length === 0) {
      problems.push(
        "OIDC_ALLOWED_REDIRECTS is empty: any http(s) URL would receive the one-time login handoff. Set at least one https origin.",
      );
    }
    if (!config.oidc.allowInsecureHttp && config.oidc.issuerUrl && !/^https:\/\//i.test(config.oidc.issuerUrl)) {
      problems.push(
        "OIDC_ISSUER_URL must use HTTPS in production (or set OIDC_ALLOW_INSECURE_HTTP=true for an isolated test network).",
      );
    }
  }
  // LLM integration (optional). When enabled in production, both the LiteLLM
  // master key and the local encryption key must be real secrets.
  if (config.llm.enabled) {
    const admin = config.llm.gateway.adminUrl;
    if (!admin) {
      problems.push("AGENTGATEWAY_ADMIN_URL is required when LLM_ENABLED=true.");
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
