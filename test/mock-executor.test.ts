/**
 * Milestone 3: MockExecutor full lifecycle unit test.
 *
 * Exercises every operation the real executors implement, using a temp
 * directory so win32 can run it without any container runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile as fsWriteFile, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockExecutor } from "../src/executors/mock-executor.ts";
import { setExecutorForTesting, resetExecutorForTesting } from "../src/executors/factory.ts";
import type { ContainerHandle } from "../src/executors/types.ts";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "mock-exec-"));
  const exec = new MockExecutor(base);
  setExecutorForTesting(exec);
  expect(await exec.isAvailable()).toBe(true);
});

afterEach(async () => {
  resetExecutorForTesting();
  await rm(base, { recursive: true, force: true });
});

describe("MockExecutor lifecycle", () => {
  it("create -> write -> read -> exec -> snapshot -> destroy -> restore", async () => {
    const exec = new MockExecutor(base);
    const handle = await exec.create({
      id: "sb-test1",
      imagePath: "/fake/ubuntu.sif",
      cpu: 1,
      memoryMb: 512,
      diskGb: 2,
    });
    expect(handle.running).toBe(true);

    await exec.writeFile(handle, "hello.txt", Buffer.from("hello world", "utf8"));
    const data = await exec.readFile(handle, "hello.txt");
    expect(data.toString("utf8")).toBe("hello world");

    const stat = await exec.stat(handle, "hello.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(11);

    const listing = await exec.readdir(handle, ".");
    expect(listing).toContain("hello.txt");

    // exec: write via shell, read back.
    const echoRes = await exec.exec(handle, process.platform === "win32" ? "echo hi > out.txt" : "echo hi > out.txt");
    expect(echoRes.exitCode).toBe(0);
    const out = await exec.readFile(handle, "out.txt");
    expect(out.toString("utf8").trim()).toBe("hi");

    // Snapshot, mutate, destroy, restore -> file back.
    const snap = await exec.snapshot(handle, "v1");
    expect(snap.sizeBytes).toBeGreaterThan(0);
    await exec.writeFile(handle, "hello.txt", Buffer.from("changed", "utf8"));
    await exec.destroy(handle);

    const restored = await exec.restore(snap, {
      id: "sb-test1",
      imagePath: "/fake/ubuntu.sif",
      cpu: 1,
      memoryMb: 512,
      diskGb: 2,
    });
    const restoredData = await exec.readFile(restored, "hello.txt");
    expect(restoredData.toString("utf8")).toBe("hello world"); // pre-mutation content

    await exec.destroy(restored);
  });

  it("supports streaming output via onData", async () => {
    const exec = new MockExecutor(base);
    const handle = await exec.create({ id: "sb-stream", imagePath: "/x", cpu: 1, memoryMb: 256, diskGb: 1 });
    const chunks: string[] = [];
    const res = await exec.exec(handle, "echo line1 && echo line2", {
      onData: (c) => chunks.push(c.toString("utf8")),
    });
    expect(res.exitCode).toBe(0);
    expect(chunks.join("")).toContain("line1");
    expect(chunks.join("")).toContain("line2");
    await exec.destroy(handle);
  });

  it("respects timeout", async () => {
    const exec = new MockExecutor(base);
    const handle = await exec.create({ id: "sb-timeout", imagePath: "/x", cpu: 1, memoryMb: 256, diskGb: 1 });
    const res = await exec.exec(handle, process.platform === "win32" ? "ping -n 10 127.0.0.1 > nul" : "sleep 10", {
      timeout: 1,
    });
    expect(res.timedOut).toBe(true);
    await exec.destroy(handle);
  }, 10000);

  it("rejects path traversal that escapes the sandbox root", async () => {
    const exec = new MockExecutor(base);
    const handle = await exec.create({ id: "sb-escape", imagePath: "/x", cpu: 1, memoryMb: 256, diskGb: 1 });

    const traversal = process.platform === "win32" ? "..\\..\\..\\..\\windows\\win.ini" : "../../../../etc/passwd";
    // read
    await expect(exec.readFile(handle, traversal)).rejects.toThrow(/escapes the sandbox root/);
    // write
    await expect(exec.writeFile(handle, traversal, Buffer.from("pwn"))).rejects.toThrow(/escapes the sandbox root/);
    // access / stat / readdir
    await expect(exec.access(handle, traversal)).rejects.toThrow(/escapes the sandbox root/);
    await expect(exec.stat(handle, traversal)).rejects.toThrow(/escapes the sandbox root/);
    await expect(exec.readdir(handle, traversal)).rejects.toThrow(/escapes the sandbox root/);
    // exec cwd (both absolute escape and relative traversal)
    await expect(exec.exec(handle, "echo hi", { cwd: traversal })).rejects.toThrow(/escapes the sandbox root/);
    await expect(exec.exec(handle, "echo hi", { cwd: "sub/../../.." })).rejects.toThrow(/escapes the sandbox root/);
    // NUL bytes are rejected outright
    await expect(exec.readFile(handle, "a\0b")).rejects.toThrow(/Invalid container path/);

    await exec.destroy(handle);
  });

  it("still allows nested paths and root-contained traversal", async () => {
    const exec = new MockExecutor(base);
    const handle = await exec.create({ id: "sb-nested", imagePath: "/x", cpu: 1, memoryMb: 256, diskGb: 1 });
    // Nested subdirs with relative traversal that stays inside the root.
    await exec.writeFile(handle, "sub/dir/f.txt", Buffer.from("data", "utf8"));
    const data = await exec.readFile(handle, "sub/./dir/f.txt");
    expect(data.toString("utf8")).toBe("data");
    const viaUp = await exec.readFile(handle, "sub/dir/../dir/f.txt");
    expect(viaUp.toString("utf8")).toBe("data");
    // Root itself is a valid target.
    const rootListing = await exec.readdir(handle, ".");
    expect(rootListing).toContain("sub");
    await exec.destroy(handle);
  });

  it("interprets container-style absolute paths (/workspace/...) inside the sandbox", async () => {
    const exec = new MockExecutor(base);
    const handle = await exec.create({ id: "sb-abs", imagePath: "/x", cpu: 1, memoryMb: 256, diskGb: 1 });
    // /workspace is the container's workspace, not the host root.
    await exec.writeFile(handle, "/workspace/notes.txt", Buffer.from("abs-path", "utf8"));
    const data = await exec.readFile(handle, "/workspace/notes.txt");
    expect(data.toString("utf8")).toBe("abs-path");
    const st = await exec.stat(handle, "/workspace/notes.txt");
    expect(st.isFile).toBe(true);

    // exec with cwd=/workspace runs inside the sandbox and can see the file.
    const res = await exec.exec(handle, "ls", { cwd: "/workspace" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("notes.txt");

    // Host-style absolute paths are still rejected (they would escape).
    const hostAbs = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";
    await expect(exec.readFile(handle, hostAbs)).rejects.toThrow(/escapes the sandbox root/);
    await exec.destroy(handle);
  });

  it("emulates a shell cd failure for a missing cwd instead of crashing", async () => {
    const exec = new MockExecutor(base);
    const handle = await exec.create({ id: "sb-nocwd", imagePath: "/x", cpu: 1, memoryMb: 256, diskGb: 1 });
    const res = await exec.exec(handle, "echo should-not-run", { cwd: "/no/such/dir" });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("No such file or directory");
    expect(res.stdout).toBe("");
    await exec.destroy(handle);
  });

  it("backfills /workspace for containers created before the workspace-dir change", async () => {
    // Simulate a legacy container root (only .sandbox_root, no workspace/).
    const legacyRoot = join(base, "sb-legacy");
    await mkdir(legacyRoot, { recursive: true });
    await fsWriteFile(join(legacyRoot, ".sandbox_root"), "legacy marker");

    const exec = new MockExecutor(base);
    await exec.isAvailable(); // backfill runs here

    // The legacy container gained a workspace dir...
    const wsStat = await fsStat(join(legacyRoot, "workspace"));
    expect(wsStat.isDirectory()).toBe(true);
    // ...its existing files are untouched...
    expect(await fsReadFile(join(legacyRoot, ".sandbox_root"), "utf8")).toBe("legacy marker");
    // ...and it can now run commands with cwd=/workspace.
    const handle = {
      id: "sb-legacy",
      node: "mock-local",
      overlayPath: legacyRoot,
      running: true,
    } as unknown as ContainerHandle;
    const res = await exec.exec(handle, "ls", { cwd: "/workspace" });
    expect(res.exitCode).toBe(0);
    await exec.destroy(handle);
  });

  it("round-trips non-ASCII output (UTF-8 shell)", async () => {
    const exec = new MockExecutor(base);
    const handle = await exec.create({ id: "sb-utf8", imagePath: "/x", cpu: 1, memoryMb: 256, diskGb: 1 });
    const res = await exec.exec(handle, "echo 你好世界");
    if (res.stdout.includes("你好世界")) {
      // Git Bash sh (preferred on win32) / POSIX shells round-trip UTF-8.
      expect(res.stdout).toContain("你好世界");
    } else if (process.platform === "win32") {
      // cmd.exe fallback (no Git Bash installed) cannot round-trip non-ASCII
      // through the ANSI codepage; the command still runs (documented limit).
      expect(res.exitCode).toBe(0);
    } else {
      expect(res.stdout).toContain("你好世界");
    }
    await exec.destroy(handle);
  });
});
