const fs = require('fs');
const file = 'src/executors/apptainer-cli-executor.ts';
let raw = fs.readFileSync(file, 'utf8');
const nl = raw.includes('\r\n') ? '\r\n' : '\n';
let s = raw.replace(/\r\n/g, '\n');
let misses = 0;
function rep(from, to) {
  if (!s.includes(from)) { console.error('MISS:', JSON.stringify(from.slice(0, 70))); misses++; return; }
  s = s.split(from).join(to);
}

// 1. Lifecycle-strict runner (throws on non-zero) + use it for instance start
rep(`  private runCli(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {`,
`  /**
   * Lifecycle commands (instance start) MUST fail loudly: a non-zero exit
   * used to resolve normally, the container row was marked running, and
   * every later tool call failed with "instance not found".
   */
  private async runLifecycle(args: string[]): Promise<ExecResult> {
    const r = await this.runCli(args);
    if (r.exitCode !== 0) {
      throw new Error(
        `apptainer ${args[0]} ${args[1] ?? ""} 失败 (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 500) || r.stdout.trim().slice(0, 200)}`,
      );
    }
    return r;
  }

  private runCli(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {`);

// create: instance start strict
rep(`    await this.runCli([
      "instance", "start",
      ...ISOLATION_FLAGS,
      // Resource limits need cgroup support; only apply when enabled (default
      // OFF: rootless + cgroup-v1 hosts fail instance start with "rootless
      // cgroups requires cgroups v2").
      ...(this.resourceLimits && req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(this.resourceLimits && req.memoryMb ? ["--memory", \`\${req.memoryMb}M\`] : []),
      ...envArgs(req.env),
      "--overlay", overlayPath,
      ...bindArgs,
      req.imagePath,
      req.id,
    ]);`,
`    await this.runLifecycle([
      "instance", "start",
      ...ISOLATION_FLAGS,
      // Resource limits need cgroup support; only apply when enabled (default
      // OFF: rootless + cgroup-v1 hosts fail instance start with "rootless
      // cgroups requires cgroups v2").
      ...(this.resourceLimits && req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(this.resourceLimits && req.memoryMb ? ["--memory", \`\${req.memoryMb}M\`] : []),
      ...envArgs(req.env),
      "--overlay", overlayPath,
      req.imagePath,
      req.id,
    ]);`);

// 2. Remove dead start() (never called; overlay-as-image fallback could never boot)
rep(`  async start(handle: ContainerHandle, env?: Record<string, string>): Promise<void> {
    const args = ["instance", "start", ...ISOLATION_FLAGS, ...envArgs(env ?? handle.env), "--overlay", handle.overlayPath];
    if (handle.imagePath) args.push(handle.imagePath);
    else args.push(handle.overlayPath);
    args.push(handle.id);
    await this.runCli(args);
    await this.ensureWorkspaceDir(handle.id);
    handle.running = true;
  }

`, '');

// 3. restore: strict start + env passthrough
rep(`  async restore(snapshot: SnapshotHandle, req: CreateRequest): Promise<ContainerHandle> {
    const overlayPath = this.overlayPathFor(req.id);
    await rm(overlayPath, { recursive: true, force: true });
    await cp(snapshot.overlayPath, overlayPath, { recursive: true });
    await this.runCli([
      "instance", "start",
      ...ISOLATION_FLAGS,
      ...(this.resourceLimits && req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(this.resourceLimits && req.memoryMb ? ["--memory", \`\${req.memoryMb}M\`] : []),
      "--overlay", overlayPath,
      req.imagePath,
      req.id,
    ]);
    await this.ensureWorkspaceDir(req.id);
    return { id: req.id, node: "local", overlayPath, running: true, imagePath: req.imagePath };
  }`,
`  async restore(snapshot: SnapshotHandle, req: CreateRequest): Promise<ContainerHandle> {
    const overlayPath = this.overlayPathFor(req.id);
    await rm(overlayPath, { recursive: true, force: true });
    await cp(snapshot.overlayPath, overlayPath, { recursive: true });
    // env overrides must survive restore (LLM keys ride here)
    await this.runLifecycle([
      "instance", "start",
      ...ISOLATION_FLAGS,
      ...(this.resourceLimits && req.cpu ? ["--cpus", String(req.cpu)] : []),
      ...(this.resourceLimits && req.memoryMb ? ["--memory", \`\${req.memoryMb}M\`] : []),
      ...envArgs(req.env),
      "--overlay", overlayPath,
      req.imagePath,
      req.id,
    ]);
    await this.ensureWorkspaceDir(req.id);
    return { id: req.id, node: "local", overlayPath, running: true, imagePath: req.imagePath, env: req.env };
  }`);

// 4. readFile: base64 pipe (UTF-8 round-trip corrupts binary)
rep(`  async readFile(handle: ContainerHandle, path: string): Promise<Buffer> {
    const r = await this.runCli(["exec", \`instance://\${handle.id}\`, "cat", path]);
    return Buffer.from(r.stdout, "utf8");
  }`,
`  async readFile(handle: ContainerHandle, path: string): Promise<Buffer> {
    // base64 (not cat): a UTF-8 round-trip mangles any non-UTF-8 file. GNU
    // base64 wraps output at 76 cols — strip all whitespace before decoding
    // (mirrors ssh-executor).
    const r = await this.runCli(["exec", \`instance://\${handle.id}\`, "base64", path]);
    if (r.exitCode !== 0) throw new Error(\`readFile failed (exit \${r.exitCode}): \${path}\`);
    return Buffer.from(r.stdout.replace(/\\s/g, ""), "base64");
  }`);

// 5. writeFile: stream base64 via stdin (single-argv embed hits MAX_ARG_STRLEN ~96KB)
rep(`  async writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void> {
    const b64 = content.toString("base64");
    // P3-2: shell-quote the path so spaces/quotes in filenames cannot inject.
    const quoted = shellQuote(path);
    await this.runCli(["exec", \`instance://\${handle.id}\`, "sh", "-c", \`mkdir -p "$(dirname -- \${quoted})" && echo '\${b64}' | base64 -d > \${quoted}\`]);
  }`,
`  async writeFile(handle: ContainerHandle, path: string, content: Buffer): Promise<void> {
    // Stream the base64 through stdin: embedding it in one argv element hits
    // Linux MAX_ARG_STRLEN (128 KiB) and fails with E2BIG above ~96 KB files.
    // P3-2: shell-quote the path so spaces/quotes in filenames cannot inject.
    const quoted = shellQuote(path);
    const inner = \`mkdir -p "$(dirname -- \${quoted})" && base64 -d > \${quoted}\`;
    await new Promise<void>((resolveFn, reject) => {
      const child = spawn(this.bin, ["exec", \`instance://\${handle.id}\`, "sh", "-c", inner], { windowsHide: true });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolveFn();
        else reject(new Error(\`writeFile failed (exit \${code}): \${path}\`));
      });
      child.stdin.on("error", () => { /* EPIPE if child dies early; close handler reports */ });
      child.stdin.end(content.toString("base64"));
    });
  }`);

// 6. access: THROW on non-zero — tools.service infers existence from failure
rep(`  async access(handle: ContainerHandle, path: string): Promise<void> {
    await this.runCli(["exec", \`instance://\${handle.id}\`, "test", "-e", path]);
  }`,
`  async access(handle: ContainerHandle, path: string): Promise<void> {
    // tools.service maps THROW => not-exists; a resolved non-zero exit used to
    // report every path as existing.
    const r = await this.runCli(["exec", \`instance://\${handle.id}\`, "test", "-e", path]);
    if (r.exitCode !== 0) throw new Error(\`not found: \${path}\`);
  }`);

// 7. envArgs: argv passes verbatim — shell-quoting here put literal '...' into values
rep(`    if (!isValidEnvName(k)) continue;
    out.push("--env", \`\${k}=\${shellQuote(String(v))}\`);`,
`    if (!isValidEnvName(k)) continue;
    // Plain KEY=VALUE: this executor spawns argv directly (no shell), so
    // shell-quoting here would store literal quote characters in the env
    // (injected LLM keys would never authenticate).
    out.push("--env", \`\${k}=\${String(v)}\`);`);

// 8. hostDirSize: fall back to a JS walk when du is missing/non-GNU
rep(`  /** Size of a snapshot dir in bytes, measured on the HOST (du -sb). */
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
        resolveFn(Number.parseInt(out.trim().split(/\\s+/)[0] ?? "0", 10) || 0);
      });
    });
  }`,
`  /** Size of a snapshot dir in bytes, measured on the HOST (du -sb, JS-walk
   *  fallback for non-GNU du — a silent 0 would bypass the disk quota). */
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
        resolveFn(Number.parseInt(out.trim().split(/\\s+/)[0] ?? "0", 10) || 0);
      });
    });
    if (duResult !== null) return duResult;
    try {
      return await this.walkSize(dir);
    } catch {
      logger.warn({ dir }, "ApptainerCliExecutor: snapshot size unknown (du and walk failed); recording 0");
      return 0;
    }
  }

  private async walkSize(dir: string): Promise<number> {
    let total = 0;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += await this.walkSize(full);
      else total += (await statFile(full)).size;
    }
    return total;
  }`);

fs.writeFileSync(file, s.replace(/\n/g, nl));
console.log(misses === 0 ? 'cli executor patched clean' : `DONE with ${misses} misses`);
