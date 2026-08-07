/**
 * Tools service: relays pi's built-in tool operations into the container.
 *
 * The pi extension calls these endpoints to make read/write/edit/bash/grep/
 * find/ls run inside the sandbox instead of on the host. Each method resolves
 * the running container, then delegates to the executor's file/exec
 * primitives. Grep/find are implemented as in-container shell commands so the
 * real executors (SSH/Apptainer) do the right thing; the MockExecutor
 * satisfies them via its own shell.
 */
import type { Database } from "../db/driver.ts";
import type { SandboxExecutor, ContainerHandle } from "../executors/types.ts";
import { createContainerService } from "./container.service.ts";
import { truncate } from "../utils/truncate.ts";
import { posix as posixPath } from "node:path";

export interface ReadResult {
  contentBase64: string;
  size: number;
}
export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}
export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
  limit?: number;
}
export interface FindParams {
  pattern: string;
  path?: string;
  limit?: number;
}
export interface LsEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}

export function createToolsService(db: Database, executor: SandboxExecutor) {
  const containers = createContainerService(db, executor);

  async function resolve(cid: number, userId: number) {
    return containers.resolveRunningHandle(cid, userId);
  }

  return {
    containers,

    async read(cid: number, userId: number, path: string): Promise<ReadResult> {
      const { handle } = await resolve(cid, userId);
      const buf = await executor.readFile(handle, path);
      return { contentBase64: buf.toString("base64"), size: buf.length };
    },

    async write(cid: number, userId: number, path: string, contentBase64: string): Promise<{ size: number }> {
      const { handle } = await resolve(cid, userId);
      const buf = Buffer.from(contentBase64, "base64");
      await executor.writeFile(handle, path, buf);
      return { size: buf.length };
    },

    async edit(
      cid: number,
      userId: number,
      path: string,
      oldText: string,
      newText: string,
    ): Promise<{ applied: boolean; size: number }> {
      const { handle } = await resolve(cid, userId);
      const current = (await executor.readFile(handle, path)).toString("utf8");
      if (!current.includes(oldText)) {
        return { applied: false, size: current.length };
      }
      const updated = current.replace(oldText, newText);
      await executor.writeFile(handle, path, Buffer.from(updated, "utf8"));
      return { applied: true, size: updated.length };
    },

    async access(cid: number, userId: number, path: string): Promise<{ exists: boolean }> {
      const { handle } = await resolve(cid, userId);
      try {
        await executor.access(handle, path);
        return { exists: true };
      } catch {
        return { exists: false };
      }
    },

    async stat(cid: number, userId: number, path: string) {
      const { handle } = await resolve(cid, userId);
      return executor.stat(handle, path);
    },

    async ls(cid: number, userId: number, path: string): Promise<LsEntry[]> {
      const { handle } = await resolve(cid, userId);
      const names = await executor.readdir(handle, path);
      const entries: LsEntry[] = [];
      for (const name of names) {
        try {
          const childPath = path.replace(/\/$/, "") + "/" + name;
          const s = await executor.stat(handle, childPath);
          entries.push({ name, isDirectory: s.isDirectory, isFile: s.isFile, size: s.size });
        } catch {
          entries.push({ name, isDirectory: false, isFile: false, size: 0 });
        }
      }
      return entries;
    },

    async bash(
      cid: number,
      userId: number,
      command: string,
      opts: { cwd?: string; timeout?: number; env?: Record<string, string> } = {},
    ): Promise<BashResult> {
      const { handle } = await resolve(cid, userId);
      const result = await executor.exec(handle, command, opts);
      const truncated = truncate(result.stdout, { maxBytes: 50000, maxLines: 2000 });
      return {
        stdout: truncated.content,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: truncated.truncated,
      };
    },

    async grep(cid: number, userId: number, params: GrepParams): Promise<string> {
      const { handle } = await resolve(cid, userId);
      // Portable pure-JS implementation: walk files via executor primitives so
      // it works identically on Mock (win32) and real (Linux) executors,
      // without depending on the container having `grep` installed.
      const root = params.path ?? ".";
      const matcher = buildLineMatcher(params.pattern, params.literal, params.ignoreCase);
      const limit = params.limit ?? 100;
      const output: string[] = [];
      let matchCount = 0;

      await walkFiles(executor, handle, root, async (fileRel) => {
        if (matchCount >= limit) return false;
        if (params.glob && !globMatches(fileRel, params.glob)) return true;
        let content: string;
        try {
          const buf = await executor.readFile(handle, posixPath.join(root, fileRel));
          content = buf.toString("utf8");
        } catch {
          return true;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i] ?? "")) {
            output.push(`${fileRel}:${i + 1}:${lines[i]}`);
            matchCount++;
            if (matchCount >= limit) return false;
          }
        }
        return true;
      });
      return output.join("\n");
    },

    async find(cid: number, userId: number, params: FindParams): Promise<string[]> {
      const { handle } = await resolve(cid, userId);
      const root = params.path ?? ".";
      const limit = params.limit ?? 100;
      const results: string[] = [];
      await walkFiles(executor, handle, root, async (fileRel) => {
        if (results.length >= limit) return false;
        if (globMatches(posixPath.basename(fileRel), params.pattern) || globMatches(fileRel, params.pattern)) {
          results.push(posixPath.join(root, fileRel));
          if (results.length >= limit) return false;
        }
        return true;
      });
      return results;
    },
  };
}

export type ToolsService = ReturnType<typeof createToolsService>;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build a per-line matcher function from grep-style parameters. */
function buildLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const re = new RegExp(pattern, ignoreCase ? "i" : "");
  return (line: string) => re.test(line);
}

/** Simple glob match supporting `*`, `?`, and `**`. */
function globMatches(s: string, pattern: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\0GLOBSTAR\0")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\0GLOBSTAR\0/g, ".*") +
      "$",
  );
  return re.test(s);
}

/** Walk files under `root` (relative paths), invoking `visit`. Return false to stop. */
async function walkFiles(
  executor: SandboxExecutor,
  handle: ContainerHandle,
  root: string,
  visit: (rel: string) => Promise<boolean>,
): Promise<void> {
  const queue: Array<{ dir: string; rel: string }> = [{ dir: root, rel: "" }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { dir, rel } = queue.shift()!;
    let names: string[];
    try {
      names = await executor.readdir(handle, dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === ".git" || name === "node_modules") continue;
      const childAbs = posixPath.join(dir, name);
      const childRel = rel ? posixPath.join(rel, name) : name;
      if (visited.has(childAbs)) continue;
      visited.add(childAbs);
      let isDir: boolean;
      try {
        const s = await executor.stat(handle, childAbs);
        isDir = s.isDirectory;
      } catch {
        continue;
      }
      if (isDir) {
        queue.push({ dir: childAbs, rel: childRel });
      } else {
        if (!(await visit(childRel))) return;
      }
    }
  }
}
