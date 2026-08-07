/**
 * Milestone 3: MockExecutor full lifecycle unit test.
 *
 * Exercises every operation the real executors implement, using a temp
 * directory so win32 can run it without any container runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockExecutor } from "../src/executors/mock-executor.ts";
import { setExecutorForTesting, resetExecutorForTesting } from "../src/executors/factory.ts";

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
});
