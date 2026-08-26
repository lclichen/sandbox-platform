/**
 * ApptainerCliExecutor: fallback executor that spawns the `apptainer` binary
 * directly from the platform process (same-host deployment).
 *
 * Used when SSH is not available but the platform runs on a host with
 * Apptainer installed. Same overlay/instance model as the SSH executor, but
 * commands run locally via child_process.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, cp, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  SandboxExecutor,
  ExecutorKind,
  ContainerHandle,
  SnapshotHandle,
  CreateRequest,
  FileStat,
  ExecOptions,
  ExecResult,
  PtyOptions,
  PtySession,
} from "./types.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { isValidEnvName } from "./shell-quote.ts";

/**
 * Host-isolation flags for `apptainer instance start`, mirroring the SSH
 * executor. `--contain` drops the default bind mounts (home, /tmp, ...);
 * `--no-mount hostfs,cwd` prevents the host filesystem and the platform's
 * working directory from leaking into the container. Without these, `pwd`
 * inside the container returns the host path and the guest can read host files.
 */
const ISOLATION_FLAGS = ["--contain", "--no-mount", "hostfs,cwd"];

// ---- host-side PTY for openPty ----
// Lazy dynamic import: a missing/broken native module degrades to an
// openPty error (the WS layer replies 501/1011) instead of crashing the
// executor at import time.
interface HostPtyTerm {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}
let hostPtyPromise: Promise<{ spawn: (file: string, args: string[], opts: Record<string, unknown>) => HostPtyTerm }> | null = null;
function loadHostPty(): ReturnType<typeof loadHostPtyOnce> {
  hostPtyPromise ??= loadHostPtyOnce();
  return hostPtyPromise;
}
async function loadHostPtyOnce() {
  const mod = (await import("@homebridge/node-pty-prebuilt-multiarch")) as unknown as {
    spawn?: unknown;
    default?: { spawn?: unknown };
  };
  // CJS package: pick spawn off the namespace or the default interop wrapper,
  // whichever the runtime synthesized.
  const spawn = (mod.spawn ?? mod.default?.spawn) as
    | ((file: string, args: string[], opts: Record<string, unknown>) => HostPtyTerm)
    | undefined;
  if (typeof spawn !== "function") throw new Error("PTY 模块缺少 spawn 导出");
  return { spawn };
}

export class ApptainerCliExecutor implements SandboxExecutor {
  readonly kind: ExecutorKind = "apptainer-cli";
  private readonly bin: string;
  private readonly overlayBase: string;
  private readonly snapshotBase: string;
  private readonly resourceLimits: boolean;

  constructor() {
    const config = loadConfig();
    this.bin = config.executor.apptainer.bin;
    // Resolve to ABSOLUTE paths: the config defaults are relative
    // ("./data/overlays") and `--overlay ./data/...` silently depends on the
    // platform process's cwd — breakage looks like a missing instance later.
    this.overlayBase = resolve(config.executor.apptainer.overlayBaseDir);
    this.snapshotBase = resolve(config.executor.apptainer.overlayBaseDir, "snapshots");
    this.resourceLimits = config.executor.apptainer.resourceLimits;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolveFn) => {
      const child = spawn(this.bin, ["--version"], { windowsHide: true });
      child.on("error", () => resolveFn(false));
      child.on("close", (code) => resolveFn(code === 0));
    });
  }

  private overlayPathFor(id: string): string {
    return `${this.overlayBase}/${id}`;
  }

  async create(req: CreateRequest): Promise<ContainerHandle> {
    // Fail fast on a misconfigured image: sif_path comes straight from the DB
    // (the seed migration ships demo rows with placeholder /srv/apptainer
    // paths). Starting from a non-existent image fails AFTER the container row
    // is already marked running, surfacing later as a baffling
    // "instance not found" on every tool call.
    if (!existsSync(req.imagePath)) {
      throw new Error(
        `镜像文件不存在: ${req.imagePath}（该镜像记录的 sif_path 无效——请在管理台修正后重试；种子数据自带的是示例路径）`,
      );
    }
    const overlayPath = this.overlayPathFor(req.id);
    // P1-6: bounded ext3 overlay when possible (manual §2.2); fall back to a
    // directory overlay if `apptainer overlay create` is unavailable.
    await this.ensureOverlay(overlayPath, req.diskGb, req.overlayKind);
    // Seed the overlay's /workspace from a host-side workspace directory. The
    // overlay is a directory this executor manages locally, so a plain cp lands
    // the files where the container will see them mounted.
    if (req.seedFromPath) {
      try {
        const seedTarget = `${overlayPath}/workspace`;
        await mkdir(seedTarget, { recursive: true });
        await cp(req.seedFromPath, seedTarget, { recursive: true });
      } catch (err) {
        logger.warn({ id: req.id, seedFromPath: req.seedFromPath, err: (err as Error).message }, "ApptainerCliExecutor: workspace seed copy failed");
      }
    }
    await this.runLifecycle([
      "instance", "start",
      ...ISOLATION_FLAGS,
      // Resource limits need cgroup support; only apply when enabled (default
      // OFF: rootless + cgroup-v1 hosts fail instance start with "rootless
      // cgroups requires cgroups v2").
      ...(this.resourceLimits && req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(this.resourceLimits && req.memoryMb ? ["--memory", `${req.memoryMb}M`] : []),
      ...envArgs(req.env),
      "--overlay", overlayPath,
      req.imagePath,
      req.id,
    ]);
    // --contain drops all default bind mounts, so the image starts with only
    // its baked-in directories. The extension runs every bash command with
    // cwd=/workspace; ensure it exists inside the container (mkdir -p is
    // idempotent and works on both ext3 and directory overlays).
    await this.ensureWorkspaceDir(req.id);
    return { id: req.id, node: "local", overlayPath, running: true, imagePath: req.imagePath, env: req.env };
  }

  /** Ensure /workspace exists inside a running instance (bash cwd target). */
  private async ensureWorkspaceDir(id: string): Promise<void> {
    try {
      await this.runCli(["exec", `instance://${id}`, "mkdir", "-p", "/workspace"]);
    } catch {
      // Best-effort: the container still starts; a missing /workspace surfaces
      // as a cd error in bash rather than a create failure.
    }
  }

  /** Create a sparse ext3 overlay sized to diskGb (MiB); fall back to a dir.
   *  overlayKind 'dir' skips the ext3 image entirely: a directory overlay is
   *  thin by nature (no hard cap) — admin opt-in per image. */
  private async ensureOverlay(overlayPath: string, diskGb: number, overlayKind?: "ext3" | "dir"): Promise<void> {
    try {
      await stat(overlayPath);
      return; // exists
    } catch {
      // missing — create below
    }
    await mkdir(dirname(overlayPath), { recursive: true });
    if (overlayKind !== "dir" && diskGb > 0) {
      // apptainer overlay create writes a .ext3 file via dd but does NOT create
      // the parent directory; ensure it exists first or dd fails with
      // "No such file or directory" and we silently fall back to an unbounded dir.
      const sizeMiB = Math.max(1, Math.round(diskGb * 1024));
      const created = await this.runCli(["overlay", "create", "--size", String(sizeMiB), overlayPath]);
      if (created.exitCode === 0) return;
      logger.warn(
        { overlayPath, err: created.stderr.trim() || "overlay create failed" },
        "ApptainerCliExecutor: ext3 overlay create failed; falling back to directory overlay (unbounded)",
      );
    }
    await mkdir(overlayPath, { recursive: true });
  }

  async stop(handle: ContainerHandle): Promise<void> {
    try {
      await this.runCli(["instance", "stop", handle.id]);
    } catch {
      // instance may already be stopped
    }
    handle.running = false;
  }

  async removePath(path: string, _node?: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    try {
      await this.runCli(["instance", "stop", handle.id]);
    } catch {
      // ignore
    }
    await rm(handle.overlayPath, { recursive: true, force: true });
  }

  /** Spawn a HOST-side utility (cp etc.). runCli prefixes the apptainer
   *  binary — system commands must bypass it. */
  private async runHostUtil(argv: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { windowsHide: true });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${argv[0]} failed (exit ${code}): ${stderr.trim().slice(0, 300)}`));
      });
    });
  }

  async snapshot(handle: ContainerHandle, name: string): Promise<SnapshotHandle> {
    const dst = `${this.snapshotBase}/${handle.id}-${name}`;
    await mkdir(dirname(dst), { recursive: true });
    await rm(dst, { recursive: true, force: true });
    // `cp -a --sparse=always`: Node's copyfile fills sparse holes, ballooning
    // an ext3-in-file overlay to its full logical size; --sparse=always keeps
    // the snapshot as thin as the source. -a covers directory overlays too.
    // HOST cp — not runCli (which prefixes the apptainer binary).
    await this.runHostUtil(["cp", "-a", "--sparse=always", handle.overlayPath, dst]);
    // P3-2: report the real copied size (mirrors ssh-executor.ts). du must run
    // on the HOST — `apptainer du` is an image-usage command with no -sb flags
    // and cannot measure a plain directory.
    const sizeBytes = await this.hostDirSize(dst);
    return { id: `${handle.id}:${name}`, overlayPath: dst, sizeBytes };
  }

  async restore(snapshot: SnapshotHandle, req: CreateRequest): Promise<ContainerHandle> {
    const overlayPath = this.overlayPathFor(req.id);
    await rm(overlayPath, { recursive: true, force: true });
    await this.runHostUtil(["cp", "-a", "--sparse=always", snapshot.overlayPath, overlayPath]);
    // env overrides must survive restore (LLM keys ride here). NOTE: no --pwd
    // here — this apptainer build rejects it on `instance start` (it is an
    // exec-level flag); every exec/PTY invocation sets cwd itself.
    await this.runLifecycle([
      "instance", "start",
      ...ISOLATION_FLAGS,
      ...(this.resourceLimits && req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(this.resourceLimits && req.memoryMb ? ["--memory", `${req.memoryMb}M`] : []),
      ...envArgs(req.env),
      "--overlay", overlayPath,
      req.imagePath,
      req.id,
    ]);
    await this.ensureWorkspaceDir(req.id);
    return { id: req.id, node: "local", overlayPath, running: true, imagePath: req.imagePath, env: req.env };
  }

  async readFile(handle: ContainerHandle, path: string): Promise<Buffer> {
    // base64 (not cat): a UTF-8 string round-trip mangles any non-UTF-8 file.
    // GNU base64 wraps at 76 cols — strip all whitespace before decoding
    // (mirrors ssh-executor).
    const r = await this.runCli(["exec", `instance://${handle.id}`, "base64", path]);
    if (r.exitCode !== 0) throw new Error(`readFile failed (exit ${r.exitCode}): ${path}`);
    return Buffer.from(r.stdout.replace(/\s/g, ""), "base64");
  }

  async writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void> {
    // Stream the base64 through stdin: embedding it in one argv element hits
    // Linux MAX_ARG_STRLEN (128 KiB) and fails with E2BIG for larger files.
    // P3-2: shell-quote the path so spaces/quotes in filenames cannot inject.
    const quoted = shellQuote(path);
    const inner = `mkdir -p "$(dirname -- ${quoted})" && base64 -d > ${quoted}`;
    await new Promise<void>((resolveFn, reject) => {
      const child = spawn(this.bin, ["exec", `instance://${handle.id}`, "sh", "-c", inner], { windowsHide: true });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolveFn();
        else reject(new Error(`writeFile failed (exit ${code}): ${path}`));
      });
      child.stdin.on("error", () => { /* EPIPE if the child dies early; close reports */ });
      child.stdin.end(content.toString("base64"));
    });
  }

  async access(handle: ContainerHandle, path: string): Promise<void> {
    // tools.service maps THROW => not-exists; a resolved non-zero exit used
    // to report every path as existing.
    const r = await this.runCli(["exec", `instance://${handle.id}`, "test", "-e", path]);
    if (r.exitCode !== 0) throw new Error(`not found: ${path}`);
  }

  async readdir(handle: ContainerHandle, path: string): Promise<string[]> {
    const r = await this.runCli(["exec", `instance://${handle.id}`, "ls", "-1", path]);
    return r.stdout.split("\n").filter(Boolean);
  }

  async stat(handle: ContainerHandle, path: string): Promise<FileStat> {
    const r = await this.runCli(["exec", `instance://${handle.id}`, "stat", "-c", "%F %s %Y", path]);
    const [type, size, mtime] = r.stdout.trim().split(/\s+/);
    return {
      isDirectory: type === "directory",
      isFile: type === "regular file",
      size: Number(size) || 0,
      mtimeMs: Number(mtime) * 1000 || 0,
    };
  }

  async exec(handle: ContainerHandle, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    // --pwd /workspace: `apptainer exec` inherits the CALLING process's cwd
    // (a host path missing in-container), and without --pwd apptainer prints
    // "Error changing the container working directory" and falls back to
    // /home/<user> — noise on every tool call. The explicit `cd` below then
    // applies the requested cwd on top.
    const cwdPrefix = opts.cwd ? `cd ${shellQuote(opts.cwd)} && ` : "";
    const args = ["exec", "--pwd", "/workspace", `instance://${handle.id}`, "sh", "-c", cwdPrefix + command];
    return this.runCli(args, opts);
  }

  /** Run a command and capture stdout as raw BYTES (utf8 decoding would
   *  corrupt archives/binary payloads — used by workspace export). */
  async execBuffer(handle: ContainerHandle, command: string): Promise<Buffer> {
    const args = ["exec", "--pwd", "/workspace", `instance://${handle.id}`, "sh", "-c", command];
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.bin, args, { windowsHide: true });
      const chunks: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`execBuffer failed (exit ${code}): ${stderr.trim().slice(0, 300)}`));
      });
    });
  }

  /**
   * Interactive container terminal (R2): `apptainer exec --pwd /workspace
   * instance://<id> bash` on a REAL host-side PTY (node-pty). With plain
   * pipes bash runs non-interactive: no prompt, no echo — the web terminal
   * renders a black screen with nothing but the ready frame. A host PTY is
   * propagated by apptainer into the container, so prompt/echo/colors and
   * resize all behave like a local terminal.
   */
  async openPty(handle: ContainerHandle, opts: PtyOptions): Promise<PtySession> {
    const pty = await loadHostPty();
    // --pwd /workspace: without it the shell starts in the instance's inherited
    // HOST cwd (missing in-container), which apptainer "fixes" by falling back
    // to /home/<user> — the web terminal then looks like the host machine.
    const term = pty.spawn(this.bin, ["exec", "--pwd", "/workspace", `instance://${handle.id}`, "bash"], {
      name: "xterm-256color",
      cols: opts.cols > 0 ? opts.cols : 80,
      rows: opts.rows > 0 ? opts.rows : 24,
      cwd: "/tmp",
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    let exited = false;
    return {
      write(data: string) {
        if (!exited) term.write(data);
      },
      resize(cols: number, rows: number) {
        if (exited || cols <= 0 || rows <= 0) return;
        try {
          term.resize(cols, rows);
        } catch {
          /* torn-down pty */
        }
      },
      kill() {
        if (exited) return;
        exited = true;
        try {
          term.kill();
        } catch {
          /* already gone */
        }
      },
      onData(cb) {
        term.onData((d: string) => cb(Buffer.from(d, "utf8")));
      },
      onExit(cb) {
        term.onExit(({ exitCode }) => {
          exited = true;
          cb(exitCode);
        });
      },
    };
  }

  /** Size of a snapshot dir in bytes, measured on the HOST (du -sb, with a
   *  JS-walk fallback for non-GNU du — a silent 0 would bypass disk quotas). */
  private async hostDirSize(dir: string): Promise<number> {
    const duResult = await new Promise<number | null>((resolveFn) => {
      const child = spawn("du", ["-sb", dir], { windowsHide: true });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.on("error", () => resolveFn(null));
      child.on("close", (code) => {
        if (code !== 0) return resolveFn(null);
        resolveFn(Number.parseInt(out.trim().split(/\s+/)[0] ?? "0", 10) || 0);
      });
    });
    if (duResult !== null) return duResult;
    try {
      return await walkSize(dir);
    } catch {
      logger.warn({ dir }, "ApptainerCliExecutor: snapshot size unknown (du and walk failed); recording 0");
      return 0;
    }
  }

  /**
   * Lifecycle commands (instance start) MUST fail loudly: a non-zero exit
   * used to resolve normally, the container row was then marked running, and
   * every later tool call failed with "instance not found".
   */
  private async runLifecycle(args: string[]): Promise<ExecResult> {
    const r = await this.runCli(args);
    if (r.exitCode !== 0) {
      const detail = r.stderr.trim().slice(0, 500) || r.stdout.trim().slice(0, 200);
      throw new Error(`apptainer ${args[0]} ${args[1] ?? ""} 失败 (exit ${r.exitCode}): ${detail}`);
    }
    return r;
  }

  private runCli(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    logger.debug({ bin: this.bin, args }, "apptainer cli exec");
    return new Promise((resolveFn, reject) => {
      const child = spawn(this.bin, args, { windowsHide: true });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      const timer =
        opts.timeout && opts.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, opts.timeout * 1000)
          : undefined;
      child.stdout.on("data", (d: Buffer) => {
        stdoutChunks.push(d);
        opts.onData?.(d);
      });
      child.stderr.on("data", (d: Buffer) => {
        stderrChunks.push(d);
        opts.onData?.(d);
      });
      const onAbort = () => child.kill("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const result: ExecResult = {
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut,
        };
        // Non-zero exit is a normal ExecResult; only throw for spawn errors (handled above).
        resolveFn(result);
      });
    });
  }
}

/** Quote a string for POSIX sh (single-quote escaping). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render `--env KEY=VALUE` arg pairs for apptainer instance start. The KEY is
 * constrained to a conservative charset and VALUE is shell-quoted so a value
 * cannot inject into the argv. Returns [] when empty.
 */
export function envArgs(env?: Record<string, string>): string[] {
  if (!env) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!isValidEnvName(k)) continue;
    // Plain KEY=VALUE: this executor spawns argv directly (no shell), so
    // shell-quoting here would store literal quote characters in the env —
    // injected LLM keys would never authenticate.
    out.push("--env", `${k}=${String(v)}`);
  }
  return out;
}

/** Recursive directory size in bytes (du fallback for non-GNU hosts). */
async function walkSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await walkSize(full);
    else total += (await stat(full)).size;
  }
  return total;
}
