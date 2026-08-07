/**
 * SshExecutor: preferred production executor.
 *
 * Connects (via node-ssh) to the host node that runs Apptainer, and executes
 * `apptainer exec <instance> <cmd>` / `apptainer instance start|stop` etc.
 * File operations are implemented as base64-piped shell commands (robust
 * against binary content and quoting), mirroring the pattern in pi's ssh.ts
 * example. The overlay (ext3 or directory) is a host path the SSH user has
 * access to; snapshot copies it on the remote side.
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

  constructor() {
    const config = loadConfig();
    this.ssh = new NodeSSH();
    this.defaultHost = config.executor.ssh.host;
    this.port = config.executor.ssh.port;
    this.username = config.executor.ssh.username;
    this.privateKeyPath = config.executor.ssh.privateKeyPath;
    this.password = config.executor.ssh.password;
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
    // Create the overlay if missing (directory-style overlay for simplicity).
    await this.execRemote(`mkdir -p ${shellQuote(overlayPath)}`);
    // Start the instance.
    const cpuOpt = req.cpu ? `--cpus ${req.cpu}` : "";
    const memOpt = req.memoryMb ? `--memory ${req.memoryMb}M` : "";
    await this.execRemote(
      `apptainer instance start ${cpuOpt} ${memOpt} --overlay ${shellQuote(overlayPath)} ${shellQuote(req.imagePath)} ${shellQuote(req.id)}`,
    );
    return { id: req.id, node: host, overlayPath, running: true };
  }

  async start(handle: ContainerHandle): Promise<void> {
    await this.connect(handle.node);
    await this.execRemote(`apptainer instance start ${shellQuote(handle.overlayPath)} ${shellQuote(handle.id)}`);
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
    await this.execRemote(`rm -rf ${shellQuote(dst)}; cp -a ${shellQuote(handle.overlayPath)} ${shellQuote(dst)}`);
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
    await this.execRemote(`rm -rf ${shellQuote(overlayPath)}; cp -a ${shellQuote(snapshot.overlayPath)} ${shellQuote(overlayPath)}`);
    const cpuOpt = req.cpu ? `--cpus ${req.cpu}` : "";
    const memOpt = req.memoryMb ? `--memory ${req.memoryMb}M` : "";
    await this.execRemote(
      `apptainer instance start ${cpuOpt} ${memOpt} --overlay ${shellQuote(overlayPath)} ${shellQuote(req.imagePath)} ${shellQuote(req.id)}`,
    );
    return { id: req.id, node: host, overlayPath, running: true };
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
