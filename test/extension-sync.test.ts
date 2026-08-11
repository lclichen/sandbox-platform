/**
 * Extension helper tests: offline path translation (lib/paths.ts) and
 * workspace sync (lib/sync.ts) — both pure/logic-only, so they are unit
 * tested here against temp dirs and a stub sync client.
 *
 * Cross-repo import: excluded from the platform typecheck (tsconfig.json)
 * like the other extension tests; vitest compiles it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerPathToLocal, toContainerPath } from "../../pi-sandbox-extension/lib/paths.ts";
import { withContainerCwd } from "../../pi-sandbox-extension/lib/operations.ts";
import {
  collectLocalFiles,
  syncWorkspaceToContainer,
  DEFAULT_SYNC_IGNORE,
  type SyncClient,
} from "../../pi-sandbox-extension/lib/sync.ts";

describe("containerPathToLocal (offline fallback)", () => {
  const cwd = "C:\\proj";
  it("maps the workspace root and container-style paths to the local cwd", () => {
    expect(containerPathToLocal("/workspace", cwd)).toBe("C:\\proj");
    expect(containerPathToLocal("/workspace/src/main.ts", cwd)).toBe("C:\\proj\\src\\main.ts");
    expect(containerPathToLocal("/", cwd)).toBe("C:\\proj");
    expect(containerPathToLocal("src/util.ts", cwd)).toBe("C:\\proj\\src\\util.ts");
    expect(containerPathToLocal(".", cwd)).toBe("C:\\proj");
    expect(containerPathToLocal("@/workspace/a.txt", cwd)).toBe("C:\\proj\\a.txt");
  });

  it("passes through paths pi already resolved to local absolute paths", () => {
    // win32: pi's path.resolve("/workspace", rel) yields drive-absolute host
    // paths — these are real local paths and must be used as-is.
    expect(containerPathToLocal("D:\\workspace\\quicksort.py", "D:\\workspace")).toBe("D:\\workspace\\quicksort.py");
    expect(containerPathToLocal("D:\\workspace\\workspace\\quicksort.py", "D:\\workspace")).toBe(
      "D:\\workspace\\workspace\\quicksort.py",
    );
    expect(containerPathToLocal("C:\\other\\file.txt", "D:\\workspace")).toBe("C:\\other\\file.txt");
    // POSIX host-absolute under the cwd is already local too.
    expect(containerPathToLocal("/home/u/proj/src/a.ts", "/home/u/proj")).toBe("/home/u/proj/src/a.ts");
  });
});

describe("toContainerPath (pi path un-mangling)", () => {
  it("maps relative paths into the workspace root", () => {
    expect(toContainerPath("quicksort.py")).toBe("/workspace/quicksort.py");
    expect(toContainerPath("src/util.ts")).toBe("/workspace/src/util.ts");
    expect(toContainerPath("@quicksort.py")).toBe("/workspace/quicksort.py");
  });

  it("keeps container-absolute paths unchanged", () => {
    expect(toContainerPath("/workspace/quicksort.py")).toBe("/workspace/quicksort.py");
    expect(toContainerPath("/workspace/src/a.ts")).toBe("/workspace/src/a.ts");
    expect(toContainerPath("/etc/hostname")).toBe("/etc/hostname");
  });

  it("un-mangles win32 drive paths pi's path.resolve produces", () => {
    const cwd = "D:\\workspace";
    // write "quicksort.py" -> "D:\workspace\quicksort.py"
    expect(toContainerPath("D:\\workspace\\quicksort.py", cwd)).toBe("/workspace/quicksort.py");
    // read "workspace/quicksort.py" -> "D:\workspace\workspace\quicksort.py"
    expect(toContainerPath("D:\\workspace\\workspace\\quicksort.py", cwd)).toBe("/workspace/quicksort.py");
    expect(toContainerPath("D:\\workspace\\src\\util.ts", cwd)).toBe("/workspace/src/util.ts");
    // model reads an absolute container path -> "D:\etc\hostname" on win32
    expect(toContainerPath("D:\\etc\\hostname", cwd)).toBe("/etc/hostname");
    expect(toContainerPath("D:\\workspace", cwd)).toBe("/workspace");
  });

  it("strips the local cwd from host-absolute paths (POSIX hosts)", () => {
    const cwd = "/home/u/proj";
    expect(toContainerPath("/home/u/proj/src/a.ts", cwd)).toBe("/workspace/src/a.ts");
    expect(toContainerPath("/home/u/proj/quicksort.py", cwd)).toBe("/workspace/quicksort.py");
  });

  it("collapses a doubled workspace prefix", () => {
    // "workspace/x" resolved against cwd /workspace doubles the prefix.
    expect(toContainerPath("/workspace/workspace/quicksort.py")).toBe("/workspace/quicksort.py");
    expect(toContainerPath("/workspace/workspace")).toBe("/workspace");
    expect(toContainerPath("workspace/quicksort.py")).toBe("/workspace/quicksort.py");
  });

  it("maps the workspace root and dot to itself", () => {
    expect(toContainerPath(".")).toBe("/workspace");
    expect(toContainerPath("/workspace")).toBe("/workspace");
    expect(toContainerPath("@/workspace")).toBe("/workspace");
  });
});

describe("collectLocalFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sync-test-"));
    await mkdir(join(dir, "src", "deep"), { recursive: true });
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "README.md"), "readme");
    await writeFile(join(dir, "src", "main.ts"), "main");
    await writeFile(join(dir, "src", "deep", "nested.txt"), "nested");
    await writeFile(join(dir, "node_modules", "junk.js"), "junk");
    await writeFile(join(dir, ".git", "config"), "git");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("walks the tree, skips ignored dirs, returns posix relative paths", async () => {
    const files = await collectLocalFiles(dir);
    const rels = files.map((f) => f.rel).sort();
    expect(rels).toEqual(["README.md", "src/deep/nested.txt", "src/main.ts"]);
    expect(files.find((f) => f.rel === "src/main.ts")?.size).toBe(4);
  });

  it("skips oversized files", async () => {
    const files = await collectLocalFiles(dir, { maxFileBytes: 5 });
    const rels = files.map((f) => f.rel);
    // README.md (6B) and nested.txt (6B) skipped; main.ts (4B) kept.
    expect(rels).toEqual(["src/main.ts"]);
  });
});

describe("syncWorkspaceToContainer", () => {
  let dir: string;
  let writes: Array<{ path: string; content: string }>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sync-up-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "README.md"), "readme");
    await writeFile(join(dir, "src", "main.ts"), "export const x = 1;");
    writes = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads every file as /workspace/<rel> and reports totals", async () => {
    const client: SyncClient = {
      toolWrite: async (_id, path, content) => {
        writes.push({ path, content: content.toString("utf8") });
      },
    };
    const result = await syncWorkspaceToContainer(client, 7, dir);
    expect(result.files).toBe(2);
    expect(result.failures).toEqual([]);
    expect(writes.map((w) => w.path).sort()).toEqual(["/workspace/README.md", "/workspace/src/main.ts"]);
    expect(writes.find((w) => w.path === "/workspace/src/main.ts")?.content).toBe("export const x = 1;");
    expect(result.bytes).toBe(6 + 19);
  });

  it("collects per-file failures without aborting the rest", async () => {
    const client: SyncClient = {
      toolWrite: async (_id, path) => {
        if (path.endsWith("README.md")) throw new Error("boom");
      },
    };
    const result = await syncWorkspaceToContainer(client, 7, dir);
    expect(result.files).toBe(1);
    expect(result.failures).toEqual(["README.md: boom"]);
  });

  it("respects a custom ignore list", async () => {
    await mkdir(join(dir, "generated"), { recursive: true });
    await writeFile(join(dir, "generated", "out.js"), "x");
    const client: SyncClient = { toolWrite: async () => {} };
    const result = await syncWorkspaceToContainer(client, 7, dir, {
      ignoreDirs: new Set([...DEFAULT_SYNC_IGNORE, "generated"]),
    });
    expect(result.files).toBe(2); // generated/out.js skipped
  });
});

describe("withContainerCwd (user_bash ! prefix)", () => {
  it("pins exec cwd to the container workspace root regardless of pi's cwd", async () => {
    const seen: Array<{ command: string; cwd: string | undefined }> = [];
    const ops = {
      exec: async (command: string, cwd: string | undefined) => {
        seen.push({ command, cwd });
        return { exitCode: 0 };
      },
    };
    const wrapped = withContainerCwd(ops as never);
    // pi's user_bash passes the LOCAL session cwd (a host path).
    await wrapped.exec("ls", "D:\\MyCourses\\26Q3\\AgentSandbox", {});
    expect(seen).toEqual([{ command: "ls", cwd: "/workspace" }]);
  });
});
