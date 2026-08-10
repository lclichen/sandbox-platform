/**
 * MockExecutor: a local-filesystem simulation of an Apptainer sandbox.
 *
 * Each container maps to a directory under the mock base dir. read/write/access
 * operate on that directory directly; `exec` spawns a shell with cwd set to
 * the container root. Snapshot copies the directory tree; restore copies it
 * back. This lets the entire platform run end-to-end on win32 without any
 * container runtime, while exercising every code path the real executors use.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, readdir, stat, cp, access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join, resolve, dirname as pathDirname, sep } from "node:path";
import type {
  SandboxExecutor,
  ExecutorKind,
  ContainerHandle,
  SnapshotHandle,
  CreateRequest,
  FileStat,
  ExecOptions,
  ExecResult,
} from "./types.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { BadRequestError } from "../utils/errors.ts";

export class MockExecutor implements SandboxExecutor {
  readonly kind: ExecutorKind = "mock";
  private readonly baseDir: string;
  private readonly snapshotDir: string;
  private readonly handles = new Map<string, ContainerHandle>();

  constructor(baseDir?: string) {
    const config = loadConfig();
    this.baseDir = resolve(baseDir ?? `${config.executor.apptainer.overlayBaseDir}/mock-containers`);
    this.snapshotDir = resolve(`${config.executor.apptainer.overlayBaseDir}/mock-snapshots`);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await mkdir(this.baseDir, { recursive: true });
      await mkdir(this.snapshotDir, { recursive: true });
      // Backfill: containers created before the workspace-dir change (commit
      // 2330489) lack <root>/workspace, so `cd /workspace` (the extension's
      // default cwd) fails for them. Ensure the dir exists for every existing
      // container; harmless mkdir -p, runs once per process start.
      await this.ensureAllWorkspaceDirs();
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure <containerRoot>/workspace exists for every existing container. */
  private async ensureAllWorkspaceDirs(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await mkdir(join(this.baseDir, entry.name, "workspace"), { recursive: true });
      } catch {
        // ignore per-container failures
      }
    }
  }

  private root(handle: ContainerHandle): string {
    return join(this.baseDir, handle.id);
  }

  async create(req: CreateRequest): Promise<ContainerHandle> {
    const root = join(this.baseDir, req.id);
    await mkdir(root, { recursive: true });
    // Seed a tiny marker so the "container" looks initialized.
    await fsWriteFile(join(root, ".sandbox_root"), `mock container ${req.id}\nimage=${req.imagePath}\n`);
    // The conventional in-container workspace dir always exists (the extension
    // runs commands with cwd=/workspace); seeding below may populate it.
    await mkdir(join(root, "workspace"), { recursive: true });
    // Seed /workspace from a host-side workspace directory when requested.
    if (req.seedFromPath) {
      const wsTarget = join(root, "workspace");
      await mkdir(wsTarget, { recursive: true });
      try {
        await cp(req.seedFromPath, wsTarget, { recursive: true });
      } catch (err) {
        logger.warn({ id: req.id, seedFromPath: req.seedFromPath, err: (err as Error).message }, "MockExecutor: workspace seed copy failed");
      }
    }
    const handle: ContainerHandle = {
      id: req.id,
      node: "mock-local",
      overlayPath: root,
      running: true,
    };
    this.handles.set(handle.id, handle);
    logger.debug({ id: req.id, root }, "MockExecutor: container created");
    return handle;
  }

  async start(handle: ContainerHandle): Promise<void> {
    handle.running = true;
    this.handles.set(handle.id, handle);
  }

  async stop(handle: ContainerHandle): Promise<void> {
    handle.running = false;
    this.handles.set(handle.id, handle);
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    await rm(this.root(handle), { recursive: true, force: true });
    this.handles.delete(handle.id);
  }

  async snapshot(handle: ContainerHandle, name: string): Promise<SnapshotHandle> {
    const src = this.root(handle);
    const dst = join(this.snapshotDir, `${handle.id}-${name}`);
    await rm(dst, { recursive: true, force: true });
    await mkdir(pathDirname(dst), { recursive: true });
    await cp(src, dst, { recursive: true });
    const size = await this.dirSize(dst);
    return { id: `${handle.id}:${name}`, overlayPath: dst, sizeBytes: size };
  }

  async restore(snapshot: SnapshotHandle, req: CreateRequest): Promise<ContainerHandle> {
    const handle: ContainerHandle = {
      id: req.id,
      node: "mock-local",
      overlayPath: join(this.baseDir, req.id),
      running: true,
    };
    const root = this.root(handle);
    await rm(root, { recursive: true, force: true });
    await mkdir(pathDirname(root), { recursive: true });
    await cp(snapshot.overlayPath, root, { recursive: true });
    this.handles.set(handle.id, handle);
    return handle;
  }

  async readFile(handle: ContainerHandle, path: string): Promise<Buffer> {
    const abs = this.resolveIn(handle, path);
    return fsReadFile(abs);
  }

  async writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void> {
    const abs = this.resolveIn(handle, path);
    await mkdir(pathDirname(abs), { recursive: true });
    await fsWriteFile(abs, content);
  }

  async access(handle: ContainerHandle, path: string): Promise<void> {
    const abs = this.resolveIn(handle, path);
    await fsAccess(abs);
  }

  async readdir(handle: ContainerHandle, path: string): Promise<string[]> {
    const abs = this.resolveIn(handle, path);
    return readdir(abs);
  }

  async stat(handle: ContainerHandle, path: string): Promise<FileStat> {
    const abs = this.resolveIn(handle, path);
    const s = await stat(abs);
    return {
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async exec(handle: ContainerHandle, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const root = this.root(handle);
    let cwd = root;
    if (opts.cwd) {
      cwd = this.resolveIn(handle, opts.cwd); // throws BadRequestError on escape
      // Emulate the container shell: cd into a missing dir fails the command
      // (exit 1 + stderr), rather than crashing spawn with ENOENT.
      try {
        await fsAccess(cwd);
      } catch {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `cd: ${opts.cwd}: No such file or directory`,
          timedOut: false,
        };
      }
    }
    const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];
    return new Promise((resolveFn) => {
      const child = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
      });
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
        resolveFn({
          exitCode: -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8") + err.message,
          timedOut,
        });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolveFn({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut,
        });
      });
    });
  }

  /**
   * Resolve a path argument (possibly relative, possibly with @ prefix) inside
   * the container root.
   *
   * SECURITY: mirrors `resolveInWorkspace` in services/workspace-storage.ts —
   * a single-point containment check. Any traversal (`..`) that resolves
   * outside the container root is rejected outright; the mock is NOT
   * permissive, because it is the default executor on win32 and the factory's
   * last-resort fallback, so an escape here is a host-escape anywhere.
   *
   * Container-style absolute paths (`/workspace`, `/etc/...`) are interpreted
   * relative to the CONTAINER root, not the host root — leading slashes are
   * stripped, exactly like the real executors (where those paths are resolved
   * inside the container's own filesystem).
   */
  private resolveIn(handle: ContainerHandle, pathArg: string): string {
    const trimmed = pathArg.startsWith("@") ? pathArg.slice(1) : pathArg;
    const root = this.root(handle);
    if (!trimmed || trimmed === ".") return root;
    // Block NUL bytes outright (they must never reach the filesystem layer).
    if (trimmed.includes("\0")) {
      throw new BadRequestError("Invalid container path");
    }
    const containerRel = trimmed.replace(/^\/+/, "");
    if (!containerRel || containerRel === ".") return root;
    // Convert posix separators to host separators before resolve so
    // cross-platform `..` detection works.
    const hostRel = sep === "/" ? containerRel : containerRel.split("/").join(sep);
    const abs = resolve(root, hostRel);
    // Containment check: abs must equal root or live beneath it.
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (abs !== root && !abs.startsWith(prefix)) {
      throw new BadRequestError("Container path escapes the sandbox root");
    }
    return abs;
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    const walk = async (d: string): Promise<void> => {
      const entries = await readdir(d, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          try {
            total += (await stat(full)).size;
          } catch {
            // ignore
          }
        }
      }
    };
    try {
      await walk(dir);
    } catch {
      // ignore
    }
    return total;
  }
}
