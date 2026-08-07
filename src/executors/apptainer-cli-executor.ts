/**
 * ApptainerCliExecutor: fallback executor that spawns the `apptainer` binary
 * directly from the platform process (same-host deployment).
 *
 * Used when SSH is not available but the platform runs on a host with
 * Apptainer installed. Same overlay/instance model as the SSH executor, but
 * commands run locally via child_process.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, cp } from "node:fs/promises";
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

export class ApptainerCliExecutor implements SandboxExecutor {
  readonly kind: ExecutorKind = "apptainer-cli";
  private readonly bin: string;
  private readonly overlayBase: string;
  private readonly snapshotBase: string;

  constructor() {
    const config = loadConfig();
    this.bin = config.executor.apptainer.bin;
    this.overlayBase = config.executor.apptainer.overlayBaseDir;
    this.snapshotBase = `${config.executor.apptainer.overlayBaseDir}/snapshots`;
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
    await mkdir(overlayPath, { recursive: true });
    await this.runCli([
      "instance", "start",
      ...(req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(req.memoryMb ? ["--memory", `${req.memoryMb}M`] : []),
      "--overlay", overlayPath,
      req.imagePath,
      req.id,
    ]);
    return { id: req.id, node: "local", overlayPath, running: true };
  }

  async start(handle: ContainerHandle): Promise<void> {
    await this.runCli(["instance", "start", handle.overlayPath, handle.id]);
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
    return { id: `${handle.id}:${name}`, overlayPath: dst, sizeBytes: 0 };
  }

  async restore(snapshot: SnapshotHandle, req: CreateRequest): Promise<ContainerHandle> {
    const overlayPath = this.overlayPathFor(req.id);
    await rm(overlayPath, { recursive: true, force: true });
    await cp(snapshot.overlayPath, overlayPath, { recursive: true });
    await this.runCli([
      "instance", "start",
      ...(req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(req.memoryMb ? ["--memory", `${req.memoryMb}M`] : []),
      "--overlay", overlayPath,
      req.imagePath,
      req.id,
    ]);
    return { id: req.id, node: "local", overlayPath, running: true };
  }

  async readFile(handle: ContainerHandle, path: string): Promise<Buffer> {
    const r = await this.runCli(["exec", handle.id, "cat", path]);
    return Buffer.from(r.stdout, "utf8");
  }

  async writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void> {
    const b64 = content.toString("base64");
    await this.runCli(["exec", handle.id, "sh", "-c", `mkdir -p "$(dirname ${path})" && echo '${b64}' | base64 -d > ${path}`]);
  }

  async access(handle: ContainerHandle, path: string): Promise<void> {
    await this.runCli(["exec", handle.id, "test", "-e", path]);
  }

  async readdir(handle: ContainerHandle, path: string): Promise<string[]> {
    const r = await this.runCli(["exec", handle.id, "ls", "-1", path]);
    return r.stdout.split("\n").filter(Boolean);
  }

  async stat(handle: ContainerHandle, path: string): Promise<FileStat> {
    const r = await this.runCli(["exec", handle.id, "stat", "-c", "%F %s %Y", path]);
    const [type, size, mtime] = r.stdout.trim().split(/\s+/);
    return {
      isDirectory: type === "directory",
      isFile: type === "regular file",
      size: Number(size) || 0,
      mtimeMs: Number(mtime) * 1000 || 0,
    };
  }

  async exec(handle: ContainerHandle, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const args = ["exec", handle.id, "sh", "-c", command];
    return this.runCli(args, opts);
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
