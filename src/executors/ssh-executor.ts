/**
 * SshExecutor: preferred production executor.
 *
 * Connects (via node-ssh) to the host node that runs Apptainer, and executes
 * `apptainer exec instance://<instance> <cmd>` / `apptainer instance start|stop`
 * etc. (instances are addressed via the instance:// URI — a bare instance
 * name is treated as an image path by `apptainer exec`).
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
import type { ClientChannel } from "ssh2";
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

/** apptainer's phrasings when `instance stop` targets an unknown instance —
 *  that is a successful stop for our purposes (idempotent end state). */
const INSTANCE_NOT_FOUND_RE = /no instance|not found|does not exist|no such instance/i;

export class SshExecutor implements SandboxExecutor {
  readonly kind: ExecutorKind = "ssh";
  private readonly ssh: NodeSSH;
  private readonly defaultHost?: string;
  private readonly port: number;
  private readonly username?: string;
  private readonly privateKeyPath?: string;
  private readonly password?: string;
  private readonly resourceLimits: boolean;
  /** Remote-side base dirs (config-driven, was hardcoded /srv/apptainer/...). */
  private readonly overlayBaseDir: string;
  private readonly seedBaseDir: string;

  constructor() {
    const config = loadConfig();
    this.ssh = new NodeSSH();
    this.defaultHost = config.executor.ssh.host;
    this.port = config.executor.ssh.port;
    this.username = config.executor.ssh.username;
    this.privateKeyPath = config.executor.ssh.privateKeyPath;
    this.password = config.executor.ssh.password;
    this.resourceLimits = config.executor.apptainer.resourceLimits;
    this.overlayBaseDir = config.executor.ssh.overlayBaseDir;
    this.seedBaseDir = config.executor.ssh.seedBaseDir;
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

  private connectedHost: string | undefined;

  private async connect(host: string): Promise<void> {
    // isConnected() alone is not enough: with node overrides the same client
    // could silently run commands on the WRONG node. Reconnect on host change.
    if (this.ssh.isConnected() && this.connectedHost === host) return;
    await this.ssh.connect({
      host,
      port: this.port,
      username: this.username!,
      ...(this.privateKeyPath ? { privateKeyPath: this.privateKeyPath } : {}),
      ...(this.password ? { password: this.password } : {}),
    });
    this.connectedHost = host;
  }

  private async execRemote(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await this.ssh.execCommand(command);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
  }

  async create(req: CreateRequest): Promise<ContainerHandle> {
    const host = req.node ?? this.defaultHost!;
    await this.connect(host);
    const overlayPath = req.overlayPath ?? `${this.overlayBaseDir}/${req.id}.ext3`;
    // P1-6: enforce the disk ceiling at the overlay layer (sparse ext3 image of
    // diskGb*1024 MiB, manual §2.2); falls back to a directory overlay.
    await this.ensureOverlay(overlayPath, req.diskGb);

    // If a workspace seed directory is provided, push it to the remote host and
    // bind-mount it at /workspace inside the container. The remote staging path
    // is unique per instance so concurrent creates do not collide.
    let bindOpt = "";
    if (req.seedFromPath) {
      const remoteSeed = `${this.seedBaseDir}/${req.id}`;
      await this.execRemote(`rm -rf ${shellQuote(remoteSeed)} && mkdir -p ${shellQuote(remoteSeed)}`);
      await this.ssh.putDirectory(req.seedFromPath, remoteSeed, { recursive: true });
      bindOpt = `--bind ${shellQuote(remoteSeed)}:/workspace`;
    }

    await this.startInstance(overlayPath, req.imagePath, req.id, req.cpu, req.memoryMb, bindOpt, req.env);
    // --contain drops default binds; ensure /workspace exists (bash cwd target).
    // Idempotent; skipped when a seed is bind-mounted (bind already provides it).
    if (!req.seedFromPath) {
      try {
        await this.execRemote(`apptainer exec instance://${shellQuote(req.id)} mkdir -p /workspace`);
      } catch {
        // best-effort
      }
    }
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
   * guest cannot see or write the SSH user's host filesystem. Lifecycle
   * command: a non-zero exit THROWS — a resolved failure used to mark the
   * container row running with no live instance.
   */
  private async startInstance(
    overlayPath: string,
    imagePath: string,
    id: string,
    cpu?: number,
    memoryMb?: number,
    extraOpts = "",
    env?: Record<string, string>,
  ): Promise<void> {
    // Resource limits need cgroup support; only apply when enabled (default
    // OFF: rootless + cgroup-v1 hosts fail instance start with "rootless
    // cgroups requires cgroups v2").
    const cpuOpt = this.resourceLimits && cpu ? `--cpus ${cpu}` : "";
    const memOpt = this.resourceLimits && memoryMb ? `--memory ${memoryMb}M` : "";
    const envOpt = envOpts(env);
    const r = await this.execRemote(
      `apptainer instance start --contain --no-mount hostfs,cwd ${cpuOpt} ${memOpt} ${envOpt} --overlay ${shellQuote(overlayPath)} ${extraOpts} ${shellQuote(imagePath)} ${shellQuote(id)}`,
    );
    if (r.code !== 0) {
      throw new Error(`apptainer instance start 失败 (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`);
    }
  }

  async stop(handle: ContainerHandle): Promise<void> {
    await this.connect(handle.node);
    const r = await this.execRemote(`apptainer instance stop ${shellQuote(handle.id)}`);
    // "instance not found" IS the desired end state (already stopped); any
    // other failure must surface — the service used to mark the row stopped
    // regardless, desyncing DB state from a still-running instance.
    if (r.code !== 0 && !INSTANCE_NOT_FOUND_RE.test(`${r.stderr}\n${r.stdout}`)) {
      throw new Error(`apptainer instance stop 失败 (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    }
    handle.running = false;
  }

  async removePath(path: string, node?: string): Promise<void> {
    await this.connect(node ?? this.defaultHost!);
    await this.execRemote(`rm -rf ${shellQuote(path)} 2>/dev/null || true`);
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    await this.connect(handle.node);
    const stop = await this.execRemote(`apptainer instance stop ${shellQuote(handle.id)} 2>/dev/null || true`);
    void stop;
    // Refuse to rm -rf the overlay of an instance that is STILL RUNNING:
    // a live ext3 overlay deleted underneath the kernel corrupts data.
    const listed = await this.execRemote(
      `apptainer instance list ${shellQuote(handle.id)} 2>/dev/null | tail -n +2 | grep -q . && echo ALIVE || echo GONE`,
    );
    if (listed.stdout.includes("ALIVE")) {
      throw new Error(
        `instance ${handle.id} did not stop (still listed); refusing to delete its overlay — investigate on the node`,
      );
    }
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
    const overlayPath = req.overlayPath ?? `${this.overlayBaseDir}/${req.id}.ext3`;
    // Atomic swap: copy to a sibling temp first, then rename the old overlay
    // aside and move the fresh one in. A failed copy used to leave the
    // container's live overlay DELETED (rm -rf then cp) — restore itself was
    // the biggest data-loss path in the platform.
    const copy = await this.execRemote(
      `tmp=${shellQuote(`${overlayPath}.restore-tmp`)}; old=${shellQuote(`${overlayPath}.restore-old`)}; ` +
        `rm -rf "$tmp"; ` +
        `cp -a --sparse=always ${shellQuote(snapshot.overlayPath)} "$tmp" && ` +
        `{ rm -rf "$old"; mv ${shellQuote(overlayPath)} "$old" 2>/dev/null || true; } && ` +
        `mv "$tmp" ${shellQuote(overlayPath)} && rm -rf "$old"`,
    );
    if (copy.code !== 0) {
      throw new Error(
        `snapshot copy failed (exit ${copy.code}): ${copy.stderr.trim().slice(0, 300)} ` +
          `(previous overlay may remain at ${overlayPath}.restore-old for manual recovery)`,
      );
    }
    // env overrides must survive restore (LLM keys ride here)
    await this.startInstance(overlayPath, req.imagePath, req.id, req.cpu, req.memoryMb, "", req.env);
    return { id: req.id, node: host, overlayPath, running: true, imagePath: req.imagePath, env: req.env };
  }

  async readFile(handle: ContainerHandle, path: string): Promise<Buffer> {
    await this.connect(handle.node);
    const r = await this.execRemote(
      `apptainer exec instance://${shellQuote(handle.id)} base64 ${shellQuote(path)} 2>/dev/null || apptainer exec instance://${shellQuote(handle.id)} cat ${shellQuote(path)} | base64`,
    );
    if (r.code !== 0) throw new Error(`readFile failed: ${r.stderr}`);
    return Buffer.from(r.stdout.replace(/\s/g, ""), "base64");
  }

  async writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void> {
    await this.connect(handle.node);
    const b64 = content.toString("base64");
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    // SECURITY: the inner command must be passed as ONE shell-quoted argument.
    // The previous form embedded shellQuote() output inside an outer
    // single-quoted string, so a path containing ' broke out of quoting and
    // executed on the SSH HOST as this user.
    const inner = `mkdir -p ${shellQuote(parent)} && echo ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}`;
    const r = await this.execRemote(
      `apptainer exec instance://${shellQuote(handle.id)} sh -c ${shellQuote(inner)}`,
    );
    if (r.code !== 0) throw new Error(`writeFile failed (exit ${r.code}): ${path}`);
  }

  async access(handle: ContainerHandle, path: string): Promise<void> {
    await this.connect(handle.node);
    const r = await this.execRemote(`apptainer exec instance://${shellQuote(handle.id)} test -e ${shellQuote(path)}`);
    if (r.code !== 0) throw new Error(`access failed: ${path}`);
  }

  async readdir(handle: ContainerHandle, path: string): Promise<string[]> {
    await this.connect(handle.node);
    const r = await this.execRemote(`apptainer exec instance://${shellQuote(handle.id)} ls -1 ${shellQuote(path)}`);
    if (r.code !== 0) throw new Error(`readdir failed: ${r.stderr}`);
    return r.stdout.split("\n").filter(Boolean);
  }

  async stat(handle: ContainerHandle, path: string): Promise<FileStat> {
    await this.connect(handle.node);
    const r = await this.execRemote(
      `apptainer exec instance://${shellQuote(handle.id)} stat -c '%F %s %Y' ${shellQuote(path)}`,
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
    const wrapped = `apptainer exec instance://${shellQuote(handle.id)} sh -c ${shellQuote(cwdPrefix + command)}`;
    // node-ssh's execOptions.timeout kills the process but doesn't surface a
    // distinct "timed out" signal (result.code is typically null afterward).
    // Track the deadline ourselves so callers get an accurate timedOut flag,
    // matching the mock + apptainer-cli executors.
    const timeoutMs = opts.timeout ? opts.timeout * 1000 : undefined;
    const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
    let timedOut = false;
    const onTimeout = () => {
      timedOut = true;
    };
    const timer = deadline ? setTimeout(onTimeout, timeoutMs!) : undefined;
    if (timer) timer.unref?.();
    try {
      const result = await this.ssh.execCommand(wrapped, {
        execOptions: opts.timeout ? { timeout: opts.timeout * 1000 } as never : undefined,
      });
      // If our own deadline fired (or has passed by the time execCommand
      // returned), treat it as a timeout regardless of node-ssh's signal.
      if (deadline && (timedOut || Date.now() >= deadline)) timedOut = true;
      return {
        exitCode: result.code ?? -1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Interactive container terminal (R2): an SSH exec channel with a pty
   * allocated, running `apptainer exec instance://<id> bash`. The shared SSH
   * connection stays open — only the channel ends when the shell exits.
   */
  async openPty(handle: ContainerHandle, opts: PtyOptions): Promise<PtySession> {
    await this.connect(handle.node);
    const client = this.ssh.connection;
    if (!client) throw new Error("SSH connection not established");
    const command = `apptainer exec instance://${shellQuote(handle.id)} bash`;
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(
        command,
        { pty: { term: "xterm", cols: opts.cols, rows: opts.rows } } as never,
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) reject(err);
          else resolve(stream);
        },
      );
    });
    let exited = false;
    return {
      write(data: string) {
        channel.write(data);
      },
      resize(cols: number, rows: number) {
        channel.setWindow(rows, cols, 480, 640);
      },
      kill() {
        if (!exited) {
          exited = true;
          channel.close();
        }
      },
      onData(cb) {
        channel.stdout.on("data", (d: Buffer) => cb(d));
        channel.stderr.on("data", (d: Buffer) => cb(d));
      },
      onExit(cb) {
        channel.on("exit", (code: number | null) => {
          exited = true;
          cb(code);
        });
        channel.on("close", () => {
          if (!exited) {
            exited = true;
            cb(null);
          }
        });
      },
    };
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render `--env KEY=VALUE` flags for apptainer instance start. The KEY is
 * constrained to a conservative charset (letters/digits/_/.) and VALUE is
 * shell-quoted so injection via a value is not possible. Returns "" when empty.
 */
export function envOpts(env?: Record<string, string>): string {
  if (!env) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!isValidEnvName(k)) continue; // skip malformed names
    parts.push(`--env ${k}=${shellQuote(String(v))}`);
  }
  return parts.join(" ");
}
