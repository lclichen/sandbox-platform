/**
 * ApptainerCliExecutor: fallback executor that spawns the `apptainer` binary
 * directly from the platform process (same-host deployment).
 *
 * Used when SSH is not available but the platform runs on a host with
 * Apptainer installed. Same overlay/instance model as the SSH executor, but
 * commands run locally via child_process.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, cp, stat } from "node:fs/promises";
import { dirname } from "node:path";
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
import { isValidEnvName } from "./shell-quote.ts";

export class ApptainerCliExecutor implements SandboxExecutor {
  readonly kind: ExecutorKind = "apptainer-cli";
  private readonly bin: string;
  private readonly overlayBase: string;
  private readonly snapshotBase: string;
  private readonly resourceLimits: boolean;

  constructor() {
    const config = loadConfig();
    this.bin = config.executor.apptainer.bin;
    this.overlayBase = config.executor.apptainer.overlayBaseDir;
    this.snapshotBase = `${config.executor.apptainer.overlayBaseDir}/snapshots`;
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
    const overlayPath = this.overlayPathFor(req.id);
    // P1-6: bounded ext3 overlay when possible (manual §2.2); fall back to a
    // directory overlay if `apptainer overlay create` is unavailable.
    await this.ensureOverlay(overlayPath, req.diskGb);
    // Seed the overlay's /workspace from a host-side workspace directory. The
    // overlay is a directory this executor manages locally, so a plain cp lands
    // the files where the container will see them mounted.
    let bindArgs: string[] = [];
    if (req.seedFromPath) {
      try {
        const seedTarget = `${overlayPath}/workspace`;
        await mkdir(seedTarget, { recursive: true });
        await cp(req.seedFromPath, seedTarget, { recursive: true });
      } catch (err) {
        logger.warn({ id: req.id, seedFromPath: req.seedFromPath, err: (err as Error).message }, "ApptainerCliExecutor: workspace seed copy failed");
      }
    }
    await this.runCli([
      "instance", "start",
      // Resource limits need cgroup support; only apply when enabled (default
      // OFF: rootless + cgroup-v1 hosts fail with "rootless cgroups requires
      // cgroups v2").
      ...(this.resourceLimits && req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(this.resourceLimits && req.memoryMb ? ["--memory", `${req.memoryMb}M`] : []),
      ...envArgs(req.env),
      "--overlay", overlayPath,
      ...bindArgs,
      req.imagePath,
      req.id,
    ]);
    return { id: req.id, node: "local", overlayPath, running: true, imagePath: req.imagePath, env: req.env };
  }

  /** Create a sparse ext3 overlay sized to diskGb (MiB); fall back to a dir. */
  private async ensureOverlay(overlayPath: string, diskGb: number): Promise<void> {
    try {
      await stat(overlayPath);
      return; // exists
    } catch {
      // missing — create below
    }
    if (diskGb > 0) {
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

  async start(handle: ContainerHandle, env?: Record<string, string>): Promise<void> {
    const args = ["instance", "start", ...envArgs(env ?? handle.env), "--overlay", handle.overlayPath];
    if (handle.imagePath) args.push(handle.imagePath);
    else args.push(handle.overlayPath);
    args.push(handle.id);
    await this.runCli(args);
    handle.running = true;
  }

  async stop(handle: ContainerHandle): Promise<void> {
    try {
      await this.runCli(["instance", "stop", handle.id]);
    } catch {
      // instance may already be stopped
    }
    handle.running = false;
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    try {
      await this.runCli(["instance", "stop", handle.id]);
    } catch {
      // ignore
    }
    await rm(handle.overlayPath, { recursive: true, force: true });
  }

  async snapshot(handle: ContainerHandle, name: string): Promise<SnapshotHandle> {
    const dst = `${this.snapshotBase}/${handle.id}-${name}`;
    await mkdir(dirname(dst), { recursive: true });
    await rm(dst, { recursive: true, force: true });
    await cp(handle.overlayPath, dst, { recursive: true });
    // P3-2: report the real copied size (mirrors ssh-executor.ts). du must run
    // on the HOST — `apptainer du` is an image-usage command with no -sb flags
    // and cannot measure a plain directory.
    const sizeBytes = await this.hostDirSize(dst);
    return { id: `${handle.id}:${name}`, overlayPath: dst, sizeBytes };
  }

  async restore(snapshot: SnapshotHandle, req: CreateRequest): Promise<ContainerHandle> {
    const overlayPath = this.overlayPathFor(req.id);
    await rm(overlayPath, { recursive: true, force: true });
    await cp(snapshot.overlayPath, overlayPath, { recursive: true });
    await this.runCli([
      "instance", "start",
      ...(this.resourceLimits && req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(this.resourceLimits && req.memoryMb ? ["--memory", `${req.memoryMb}M`] : []),
      "--overlay", overlayPath,
      req.imagePath,
      req.id,
    ]);
    return { id: req.id, node: "local", overlayPath, running: true, imagePath: req.imagePath };
  }

  async readFile(handle: ContainerHandle, path: string): Promise<Buffer> {
    const r = await this.runCli(["exec", `instance://${handle.id}`, "cat", path]);
    return Buffer.from(r.stdout, "utf8");
  }

  async writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void> {
    const b64 = content.toString("base64");
    // P3-2: shell-quote the path so spaces/quotes in filenames cannot inject.
    const quoted = shellQuote(path);
    await this.runCli(["exec", `instance://${handle.id}`, "sh", "-c", `mkdir -p "$(dirname -- ${quoted})" && echo '${b64}' | base64 -d > ${quoted}`]);
  }

  async access(handle: ContainerHandle, path: string): Promise<void> {
    await this.runCli(["exec", `instance://${handle.id}`, "test", "-e", path]);
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
    const args = ["exec", `instance://${handle.id}`, "sh", "-c", command];
    return this.runCli(args, opts);
  }

  /** Size of a snapshot dir in bytes, measured on the HOST (du -sb). */
  private async hostDirSize(dir: string): Promise<number> {
    return new Promise((resolveFn) => {
      const child = spawn("du", ["-sb", dir], { windowsHide: true });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.on("error", () => resolveFn(0));
      child.on("close", (code) => {
        if (code !== 0) return resolveFn(0);
        resolveFn(Number.parseInt(out.trim().split(/\s+/)[0] ?? "0", 10) || 0);
      });
    });
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
    out.push("--env", `${k}=${shellQuote(String(v))}`);
  }
  return out;
}
