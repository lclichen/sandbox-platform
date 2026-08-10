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
import { containerPathToLocal } from "../../pi-sandbox-extension/lib/paths.ts";
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
