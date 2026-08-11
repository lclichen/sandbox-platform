/**
 * SshExecutor: preferred production executor.
 *
 * Connects (via node-ssh) to the host node that runs Apptainer, and executes
 * `apptainer exec <instance> <cmd>` / `apptainer instance start|stop` etc.
 * File operations are implemented as base64-piped shell commands (robust
 * against binary content and quoting), mirroring the pattern in pi's ssh.ts
 * example.
 *
 * Overlay: a sparse ext3 image created with `apptainer overlay create --size
 * <diskGb*1024>` enforces the per-container disk ceiling (P1-6, manual §2.2),
 * with a directory-overlay fallback if creation fails. Instances run with
 * `--contain --no-mount hostfs,cwd` so the guest cannot see the SSH user's
 * host filesystem (P1-7).
 *
 * This executor is only exercised on Linux deployments; on win32 it reports
 * unavailable so the factory falls back.
 */
import { NodeSSH } from "node-ssh";
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

export class SshExecutor implements SandboxExecutor {
  readonly kind: ExecutorKind = "ssh";
  private readonly ssh: NodeSSH;
  private readonly defaultHost?: string;
  private readonly port: number;
  private readonly username?: string;
  private readonly privateKeyPath?: string;
  private readonly password?: string;
  private readonly resourceLimits: boolean;

  constructor() {
    const config = loadConfig();
    this.ssh = new NodeSSH();
    this.defaultHost = config.executor.ssh.host;
    this.port = config.executor.ssh.port;
    this.username = config.executor.ssh.username;
    this.privateKeyPath = config.executor.ssh.privateKeyPath;
    this.password = config.executor.ssh.password;
    this.resourceLimits = config.executor.apptainer.resourceLimits;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.defaultHost || !this.username) return false;
    try {
      await this.connect(this.defaultHost);
      return true;
    } catch (err) {
      logger.warn({ error: (err as Error).message }, "SshExecutor: unavailable");
      return false;
    }
  }

  private async connect(host: string): Promise<void> {
    if (this.ssh.isConnected()) return;
    await this.ssh.connect({
      host,
      port: this.port,
      username: this.username!,
      ...(this.privateKeyPath ? { privateKeyPath: this.privateKeyPath } : {}),
      ...(this.password ? { password: this.password } : {}),
    });
  }

  private async execRemote(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await this.ssh.execCommand(command);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
  }

  async create(req: CreateRequest): Promise<ContainerHandle> {
    const host = req.node ?? this.defaultHost!;
    await this.connect(host);
    const overlayPath = req.overlayPath ?? `/srv/apptainer/overlays/${req.id}.ext3`;
    // P1-6: enforce the disk ceiling at the overlay layer (sparse ext3 image of
    // diskGb*1024 MiB, manual §2.2); falls back to a directory overlay.
    await this.ensureOverlay(overlayPath, req.diskGb);

    // If a workspace seed directory is provided, push it to the remote host and
    // bind-mount it at /workspace inside the container. The remote staging path
    // is unique per instance so concurrent creates do not collide.
    let bindOpt = "";
    if (req.seedFromPath) {
      const remoteSeed = `/srv/apptainer/workspace-seeds/${req.id}`;
      await this.execRemote(`rm -rf ${shellQuote(remoteSeed)} && mkdir -p ${shellQuote(remoteSeed)}`);
      await this.ssh.putDirectory(req.seedFromPath, remoteSeed, { recursive: true });
      bindOpt = `--bind ${shellQuote(remoteSeed)}:/workspace`;
    }

    await this.startInstance(overlayPath, req.imagePath, req.id, req.cpu, req.memoryMb, bindOpt);
    return { id: req.id, node: host, overlayPath, running: true, imagePath: req.imagePath };
  }

  /**
   * Ensure the overlay exists, bounded to diskGb when possible. Prefers a
   * sparse ext3 image created via `apptainer overlay create --size <MiB>`
   * (manual §2.2); falls back to a plain directory overlay (unbounded but
   * functional) when overlay creation fails on the remote host.
   */
  private async ensureOverlay(overlayPath: string, diskGb: number): Promise<void> {
    const exists = await this.execRemote(`test -e ${shellQuote(overlayPath)} && echo yes || echo no`);
    if (exists.stdout.trim() === "yes") return;
    if (diskGb > 0) {
      const sizeMiB = Math.max(1, Math.round(diskGb * 1024));
      const created = await this.execRemote(
        `apptainer overlay create --size ${sizeMiB} ${shellQuote(overlayPath)} 2>&1`,
      );
      if (created.code === 0) return;
      logger.warn(
        { overlayPath, err: created.stderr.trim() || "overlay create failed" },
        "SshExecutor: ext3 overlay create failed; falling back to directory overlay (unbounded)",
      );
    }
    await this.execRemote(`mkdir -p ${shellQuote(overlayPath)}`);
  }

  /**
   * P1-7: run instances with host isolation (no hostfs / no cwd mount) so the
   * guest cannot see or write the SSH user's host filesystem.
   */
  private async startInstance(
    overlayPath: string,
    imagePath: string,
    id: string,
    cpu?: number,
    memoryMb?: number,
    extraOpts = "",
  ): Promise<void> {
    // Resource limits need cgroup support; only apply when enabled (default
    // OFF: rootless + cgroup-v1 hosts fail instance start with "rootless
    // cgroups requires cgroups v2").
    const cpuOpt = this.resourceLimits && cpu ? `--cpus ${cpu}` : "";
    const memOpt = this.resourceLimits && memoryMb ? `--memory ${memoryMb}M` : "";
    await this.execRemote(
      `apptainer instance start --contain --no-mount hostfs,cwd ${cpuOpt} ${memOpt} --overlay ${shellQuote(overlayPath)} ${extraOpts} ${shellQuote(imagePath)} ${shellQuote(id)}`,
    );
  }

  async start(handle: ContainerHandle): Promise<void> {
    await this.connect(handle.node);
    // The handle carries the image path so a resume rebuilds a valid start
    // command; fall back to the overlay path as the image for legacy handles.
    const imageArg = handle.imagePath ? shellQuote(handle.imagePath) : shellQuote(handle.overlayPath);
    await this.execRemote(
      `apptainer instance start --contain --no-mount hostfs,cwd --overlay ${shellQuote(handle.overlayPath)} ${imageArg} ${shellQuote(handle.id)}`,
    );
    handle.running = true;
  }

  async stop(handle: ContainerHandle): Promise<void> {
    await this.connect(handle.node);
    await this.execRemote(`apptainer instance stop ${shellQuote(handle.id)}`);
    handle.running = false;
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    await this.connect(handle.node);
    await this.execRemote(`apptainer instance stop ${shellQuote(handle.id)} 2>/dev/null || true`);
    await this.execRemote(`rm -rf ${shellQuote(handle.overlayPath)}`);
  }

  async snapshot(handle: ContainerHandle, name: string): Promise<SnapshotHandle> {
    await this.connect(handle.node);
    const dst = `${handle.overlayPath}.snap-${name}`;
    // --sparse=always keeps ext3 images sparse on copy (manual §4.2).
    await this.execRemote(`rm -rf ${shellQuote(dst)}; cp -a --sparse=always ${shellQuote(handle.overlayPath)} ${shellQuote(dst)}`);
    const sizeRes = await this.execRemote(`du -sb ${shellQuote(dst)} | cut -f1`);
    return {
      id: `${handle.id}:${name}`,
      overlayPath: dst,
      sizeBytes: Number.parseInt(sizeRes.stdout.trim(), 10) || 0,
    };
  }

  async restore(snapshot: SnapshotHandle, req: CreateRequest): Promise<ContainerHandle> {
    const host = req.node ?? this.defaultHost!;
    await this.connect(host);
    const overlayPath = req.overlayPath ?? `/srv/apptainer/overlays/${req.id}.ext3`;
    await this.execRemote(`rm -rf ${shellQuote(overlayPath)}; cp -a --sparse=always ${shellQuote(snapshot.overlayPath)} ${shellQuote(overlayPath)}`);
    await this.startInstance(overlayPath, req.imagePath, req.id, req.cpu, req.memoryMb);
    return { id: req.id, node: host, overlayPath, running: true, imagePath: req.imagePath };
  }

  async readFile(handle: ContainerHandle, path: string): Promise<Buffer> {
    await this.connect(handle.node);
    const r = await this.execRemote(
      `apptainer exec ${shellQuote(handle.id)} base64 ${shellQuote(path)} 2>/dev/null || apptainer exec ${shellQuote(handle.id)} cat ${shellQuote(path)} | base64`,
    );
    if (r.code !== 0) throw new Error(`readFile failed: ${r.stderr}`);
    return Buffer.from(r.stdout.replace(/\s/g, ""), "base64");
  }

  async writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void> {
    await this.connect(handle.node);
    const b64 = content.toString("base64");
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    await this.execRemote(
      `apptainer exec ${shellQuote(handle.id)} sh -c 'mkdir -p ${shellQuote(parent)} && echo ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}'`,
    );
  }

  async access(handle: ContainerHandle, path: string): Promise<void> {
    await this.connect(handle.node);
    const r = await this.execRemote(`apptainer exec ${shellQuote(handle.id)} test -e ${shellQuote(path)}`);
    if (r.code !== 0) throw new Error(`access failed: ${path}`);
  }

  async readdir(handle: ContainerHandle, path: string): Promise<string[]> {
    await this.connect(handle.node);
    const r = await this.execRemote(`apptainer exec ${shellQuote(handle.id)} ls -1 ${shellQuote(path)}`);
    if (r.code !== 0) throw new Error(`readdir failed: ${r.stderr}`);
    return r.stdout.split("\n").filter(Boolean);
  }

  async stat(handle: ContainerHandle, path: string): Promise<FileStat> {
    await this.connect(handle.node);
    const r = await this.execRemote(
      `apptainer exec ${shellQuote(handle.id)} stat -c '%F %s %Y' ${shellQuote(path)}`,
    );
    if (r.code !== 0) throw new Error(`stat failed: ${r.stderr}`);
    const [type, size, mtime] = r.stdout.trim().split(/\s+/);
    return {
      isDirectory: type === "directory",
      isFile: type === "regular file",
      size: Number(size) || 0,
      mtimeMs: Number(mtime) * 1000 || 0,
    };
  }

  async exec(handle: ContainerHandle, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    await this.connect(handle.node);
    const cwdPrefix = opts.cwd ? `cd ${shellQuote(opts.cwd)} && ` : "";
    const wrapped = `apptainer exec ${shellQuote(handle.id)} sh -c ${shellQuote(cwdPrefix + command)}`;
    // node-ssh execCommand is non-streaming at this layer; collect buffers.
    const result = await this.ssh.execCommand(wrapped, { execOptions: opts.timeout ? { timeout: opts.timeout * 1000 } as never : undefined });
    return {
      exitCode: result.code ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: false,
    };
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
