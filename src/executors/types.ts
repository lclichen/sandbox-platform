/**
 * Sandbox executor contract.
 *
 * The executor is the platform's abstraction over the actual container runtime
 * (Apptainer instance + overlay, or a stand-in for local development). It owns
 * all interaction with the container: lifecycle (create/start/stop/destroy),
 * field-recovery (snapshot/restore), and the file/command operations the
 * `tools` routes relay from pi clients.
 *
 * Three implementations exist behind one interface, selectable via config:
 *   - MockExecutor:       local filesystem + child_process; works everywhere,
 *                          default for development on win32.
 *   - SshExecutor:        SSH into the host node and run `apptainer exec
 *                          <instance> <cmd>`; preferred in production.
 *   - ApptainerCliExecutor: the platform process spawns `apptainer` directly;
 *                          fallback when SSH is unavailable.
 *
 * Handles are opaque to the caller (just carry an id + metadata the executor
 * produced). The executor keeps any internal mapping it needs.
 */
import type { Database, SqlValue } from "../db/driver.ts";

export type ExecutorKind = "mock" | "ssh" | "apptainer-cli";

export interface ContainerHandle {
  /** Stable id, stored as containers.instance_name (executor-scoped). */
  readonly id: string;
  /** Execution node identifier (host) for diagnostics. */
  readonly node: string;
  /** Overlay path the executor manages (overlay_path column). */
  readonly overlayPath: string;
  /** Whether the instance is currently running. */
  running: boolean;
  /** Base image SIF path (needed to rebuild `instance start` from a handle). */
  imagePath?: string;
  /**
   * Environment overrides captured at create time, so the MockExecutor (which
   * runs a local process per exec) can re-apply them on each command without a
   * separate store. SSH/CLI executors inject env into the apptainer instance at
   * start and do not read this field.
   */
  env?: Record<string, string>;
}

export interface SnapshotHandle {
  readonly id: string;
  readonly overlayPath: string;
  sizeBytes: number;
}

export interface CreateRequest {
  /** Executor-scoped stable id (caller-generated, e.g. `sb-<nanoid>`). */
  id: string;
  /** Base image SIF path. */
  imagePath: string;
  /** CPU cores requested. */
  cpu: number;
  /** Memory in MB. */
  memoryMb: number;
  /** Disk ceiling in GB (overlay size). */
  diskGb: number;
  /** Environment overrides. */
  env?: Record<string, string>;
  /** Per-container node override (SSH executor); falls back to config default. */
  node?: string;
  /**
   * Caller-supplied overlay path. When omitted the executor derives a default
   * (e.g. `<overlayBaseDir>/<id>`). Documented here because the SSH/CLI
   * executors already read it; previously undeclared.
   */
  overlayPath?: string;
  /**
   * Host-side source directory whose contents seed the container's /workspace
   * at create time. Each executor decides how to apply it:
   *   - MockExecutor / ApptainerCliExecutor: cp -r into the container root.
   *   - SshExecutor: putDirectory to the remote, then --bind <path>:/workspace.
   * When omitted, the container starts with an empty /workspace (image default).
   */
  seedFromPath?: string;
}

export interface FileStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number; // seconds
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Streaming callback for stdout+stderr chunks (Buffer). */
  onData?: (chunk: Buffer) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecStream {
  /** Cancel the running process. */
  kill(): void;
}

// ---- interactive PTY (R2: container terminal WebSocket) ----

export interface PtyOptions {
  cols: number;
  rows: number;
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * A live interactive shell inside the container. Callbacks are set once via
 * onData/onExit before any write; kill() tears the process down. The platform
 * bridges this onto the /containers/:id/pty WebSocket.
 */
export interface PtySession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface SandboxExecutor {
  readonly kind: ExecutorKind;
  /** Probe whether the executor can operate (binary present, ssh reachable, ...). */
  isAvailable(): Promise<boolean>;
  /** Create + start an instance with a fresh overlay. */
  create(req: CreateRequest): Promise<ContainerHandle>;
  /** Start a stopped instance (re-attach overlay). */
  /**
   * Start an existing (stopped) container. Optionally pass `env` to (re)apply
   * environment overrides stored out-of-band (e.g. in containers.env); when
   * omitted, executors that persist env on the handle reuse it. Implementations
   * that create instances (rather than resuming a live one) MUST honor env.
   */
  start(handle: ContainerHandle, env?: Record<string, string>): Promise<void>;
  /** Stop a running instance gracefully (overlay retained). */
  stop(handle: ContainerHandle): Promise<void>;
  /** Destroy the instance AND its overlay (irreversible). */
  destroy(handle: ContainerHandle): Promise<void>;
  /** Copy the current overlay into a named snapshot (field-recovery mechanism). */
  snapshot(handle: ContainerHandle, name: string): Promise<SnapshotHandle>;
  /** Re-create an instance from a snapshot's overlay. */
  restore(snapshot: SnapshotHandle, req: CreateRequest): Promise<ContainerHandle>;

  // ---- file/command operations (relayed by the tools routes) ----
  readFile(handle: ContainerHandle, path: string): Promise<Buffer>;
  writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void>;
  access(handle: ContainerHandle, path: string): Promise<void>;
  readdir(handle: ContainerHandle, path: string): Promise<string[]>;
  stat(handle: ContainerHandle, path: string): Promise<FileStat>;
  exec(handle: ContainerHandle, command: string, opts?: ExecOptions): Promise<ExecResult>;

  // ---- interactive terminal (R2). Optional so an executor can decline
  // (callers must treat "absent" as "terminal unsupported"); MockExecutor
  // provides an echo shell so the WS layer is testable on win32. ----
  openPty?(handle: ContainerHandle, opts: PtyOptions): Promise<PtySession>;
}

/**
 * Persistence helper: read a container row and reconstruct the handle. The
 * executor itself is stateless across process restarts; everything needed is
 * in the DB (instance_name, node, overlay_path, status).
 */
export interface ContainerRowForExecutor {
  id: number;
  instance_name: string | null;
  node: string | null;
  overlay_path: string | null;
  status: string;
  /** Owner id (reaper uses it to snapshot on the owner's behalf). */
  user_id: number;
  /** Last start timestamp (reaper's idle anchor). */
  last_started_at?: string | null;
  last_stopped_at?: string | null;
}

export function handleFromRow(row: ContainerRowForExecutor): ContainerHandle {
  if (!row.instance_name) throw new Error(`Container ${row.id} has no instance_name`);
  return {
    id: row.instance_name,
    node: row.node ?? "local",
    overlayPath: row.overlay_path ?? "",
    running: row.status === "running",
  };
}

/** Mirror a handle's running state back into the containers row. */
export async function persistRunningState(
  db: Database,
  containerId: number,
  running: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  if (running) {
    await db.run(
      "UPDATE containers SET status = 'running', last_started_at = ?, updated_at = ? WHERE id = ?",
      now as SqlValue,
      now as SqlValue,
      containerId,
    );
  } else {
    await db.run(
      "UPDATE containers SET status = 'stopped', last_stopped_at = ?, updated_at = ? WHERE id = ?",
      now as SqlValue,
      now as SqlValue,
      containerId,
    );
  }
}
