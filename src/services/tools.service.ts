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
import { HttpError } from "../utils/errors.ts";
import { posix as posixPath } from "node:path";
import safeRegex from "safe-regex2";
import { loadConfig } from "../config.ts";

// Resource caps (fix plan C4). The platform is a single multi-tenant process:
// every one of these bounds a user-controllable input that could otherwise
// balloon memory or pin the event loop (unbounded stderr, whole-file reads of
// huge files, catastrophic-backtracking regexes on long lines, unbounded
// directory walks). They are env-configurable — see docs/LIMITS.md.
export function toolLimits() {
  return loadConfig().tools;
}

/** Reject a bash timeout above the configured ceiling (routes validate too). */
export function assertBashTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  const max = toolLimits().bashMaxTimeoutSeconds;
  if (timeout > max) {
    throw new HttpError(400, "TIMEOUT_TOO_LARGE", `bash timeout exceeds the ${max}-second limit`);
  }
}

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
  const limits = toolLimits();

  async function resolve(cid: number, userId: number) {
    return containers.resolveRunningHandle(cid, userId);
  }

  /** Read a file with a hard size cap (missing files still surface the
   *  executor's canonical not-found error — stat failures fall through). */
  async function readCapped(handle: ContainerHandle, path: string): Promise<Buffer> {
    try {
      const s = await executor.stat(handle, path);
      if (s.size > limits.readMaxBytes) {
        throw new HttpError(413, "FILE_TOO_LARGE", `File is larger than the ${limits.readMaxBytes}-byte read cap`);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // stat failed (missing/unreadable) — readFile below produces the
      // canonical error shape.
    }
    const buf = await executor.readFile(handle, path);
    if (buf.length > limits.readMaxBytes) {
      throw new HttpError(413, "FILE_TOO_LARGE", `File is larger than the ${limits.readMaxBytes}-byte read cap`);
    }
    return buf;
  }

  return {
    containers,

    async read(cid: number, userId: number, path: string): Promise<ReadResult> {
      const { handle } = await resolve(cid, userId);
      const buf = await readCapped(handle, path);
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
      const current = (await readCapped(handle, path)).toString("utf8");
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
      assertBashTimeout(opts.timeout);
      const { handle } = await resolve(cid, userId);
      const result = await executor.exec(handle, command, {
        ...opts,
        maxOutputBytes: limits.bashOutputMaxBytes,
      });
      const truncated = truncate(result.stdout, { maxBytes: 50000, maxLines: 2000 });
      // stderr is just as user-controllable as stdout (`ls / >&2`) and used to
      // flow back uncapped into the JSON response.
      const truncatedErr = truncate(result.stderr, { maxBytes: 50000, maxLines: 2000 });
      return {
        stdout: truncated.content,
        stderr: truncatedErr.content,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: truncated.truncated || truncatedErr.truncated || result.outputTruncated === true,
      };
    },

    async grep(cid: number, userId: number, params: GrepParams): Promise<string> {
      const { handle } = await resolve(cid, userId);
      if (params.pattern.length > limits.grepMaxPatternChars) {
        throw new HttpError(400, "PATTERN_TOO_LONG", `grep pattern exceeds ${limits.grepMaxPatternChars} characters`);
      }
      // Reject patterns with nested quantifiers/backrefs before they reach the
      // main-thread RegExp engine. Truncating each line bounds input, but does
      // NOT prevent classic exponential backtracking on a 10 KB line.
      if (!params.literal && !safeRegex(params.pattern)) {
        throw new HttpError(
          400,
          "UNSAFE_PATTERN",
          "grep pattern is potentially catastrophic (nested quantifiers/backreferences); use a simpler pattern or literal:true",
        );
      }
      // Portable pure-JS implementation: walk files via executor primitives so
      // it works identically on Mock (win32) and real (Linux) executors,
      // without depending on the container having `grep` installed.
      const root = params.path ?? ".";
      let matcher: (line: string) => boolean;
      try {
        matcher = buildLineMatcher(params.pattern, params.literal, params.ignoreCase);
      } catch {
        throw new HttpError(400, "INVALID_PATTERN", "grep pattern is not a valid regular expression");
      }
      const limit = params.limit ?? 100;
      const output: string[] = [];
      let matchCount = 0;

      await walkFiles(executor, handle, root, async (fileRel) => {
        if (matchCount >= limit) return false;
        if (params.glob && !globMatches(fileRel, params.glob)) return true;
        let content: string;
        try {
          const buf = await executor.readFile(handle, posixPath.join(root, fileRel));
          if (buf.length > limits.readMaxBytes) return true; // skip huge files
          content = buf.toString("utf8");
        } catch {
          return true;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i] ?? "";
          // Truncate BEFORE the regex: bounded input bounds backtracking.
          const line = raw.length > limits.grepMaxLineChars ? raw.slice(0, limits.grepMaxLineChars) : raw;
          if (matcher(line)) {
            output.push(`${fileRel}:${i + 1}:${line}`);
            matchCount++;
            if (matchCount >= limit) return false;
          }
        }
        return true;
      }, limits.walkTimeoutMs > 0 ? Date.now() + limits.walkTimeoutMs : Number.POSITIVE_INFINITY, limits);
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
      }, limits.walkTimeoutMs > 0 ? Date.now() + limits.walkTimeoutMs : Number.POSITIVE_INFINITY, limits);
      return results;
    },
  };
}

export type ToolsService = ReturnType<typeof createToolsService>;

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

/** Walk files under `root` (relative paths), invoking `visit`. Return false to stop.
 *  Bounded by WALK_MAX_FILES / WALK_MAX_DEPTH so a deep or huge tree cannot
 *  drive unbounded serial executor round-trips (each stat/readdir is a remote
 *  call on the SSH executor). */
async function walkFiles(
  executor: SandboxExecutor,
  handle: ContainerHandle,
  root: string,
  visit: (rel: string) => Promise<boolean>,
  deadline: number | undefined,
  limits: { walkMaxFiles: number; walkMaxDepth: number },
): Promise<void> {
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  const visited = new Set<string>();
  let files = 0;
  while (queue.length > 0) {
    if (deadline !== undefined && Date.now() > deadline) return;
    const { dir, rel, depth } = queue.shift()!;
    let names: string[];
    try {
      names = await executor.readdir(handle, dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (deadline !== undefined && Date.now() > deadline) return;
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
        if (depth + 1 <= limits.walkMaxDepth) {
          queue.push({ dir: childAbs, rel: childRel, depth: depth + 1 });
        }
      } else {
        files += 1;
        if (files > limits.walkMaxFiles) return;
        if (!(await visit(childRel))) return;
      }
    }
  }
}
