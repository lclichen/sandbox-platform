/**
 * Workspace host-filesystem storage layer.
 *
 * Pure helper module: all host-FS operations for user workspaces go through
 * here so that path containment is enforced in one place. Workspace files live
 * under WORKSPACE_BASE_DIR/user-<userId>/ws-<wsId>/ on the platform host.
 *
 * SECURITY: every path is resolved and checked against the workspace's own
 * directory prefix. Traversal (`..`) that escapes the workspace root raises a
 * BadRequestError — this is the deliberate, single-point fix for the class of
 * host-escape bug present in the legacy MockExecutor.resolveIn. Unlike that
 * permissive helper, we NEVER allow escape here.
 */
import { mkdir, rm, readdir, stat, rename, readFile as fsReadFile, writeFile as fsWriteFile, access as fsAccess } from "node:fs/promises";
import { join, resolve, posix as posixPath, dirname as pathDirname, sep } from "node:path";
import { loadConfig } from "../config.ts";
import { BadRequestError, NotFoundError } from "../utils/errors.ts";

export interface WorkspaceFileEntry {
  name: string;
  path: string; // posix-style relative path within the workspace (e.g. "sub/dir/f.txt")
  isDir: boolean;
  size: number;
  mtime: string; // ISO string
}

/** Resolve and freeze the workspace base dir once. */
function base(): string {
  return resolve(loadConfig().executor.apptainer.workspaceBaseDir);
}

/** The per-user root directory. */
export function userRoot(userId: number): string {
  return join(base(), `user-${userId}`);
}

/** The directory for a specific workspace. */
export function workspaceDir(userId: number, wsId: number): string {
  return join(userRoot(userId), `ws-${wsId}`);
}

/**
 * Resolve a relative path inside a workspace, enforcing containment.
 * Returns the absolute host path. Throws BadRequestError on traversal escape.
 *
 * `rel` is interpreted as POSIX (`/`-separated) regardless of host OS, since it
 * arrives from HTTP clients and is stored in DB rows that way. We normalize to
 * the host separator when joining.
 */
export function resolveInWorkspace(userId: number, wsId: number, rel: string): string {
  const root = workspaceDir(userId, wsId);
  // Normalize leading slashes and convert to host path.
  const cleanedRel = rel.replace(/^\/+/, "");
  if (cleanedRel === "" || cleanedRel === ".") return root;
  // Block NUL bytes outright.
  if (cleanedRel.includes("\0")) {
    throw new BadRequestError("Invalid workspace path");
  }
  // Convert posix separators to host separators before resolve so cross-platform
  // `..` detection works.
  const hostRel = sep === "/" ? cleanedRel : cleanedRel.split("/").join(sep);
  const abs = resolve(root, hostRel);
  // Containment check: abs must equal root or live beneath it.
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(prefix)) {
    throw new BadRequestError("Workspace path escapes the workspace root");
  }
  return abs;
}

/** Ensure the base + user + workspace directories exist. */
export async function ensureWorkspaceDir(userId: number, wsId: number): Promise<string> {
  const dir = workspaceDir(userId, wsId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Remove a workspace's directory tree (used on workspace delete). */
export async function removeWorkspaceDir(userId: number, wsId: number): Promise<void> {
  await rm(workspaceDir(userId, wsId), { recursive: true, force: true });
}

/** Rename the workspace directory (used when the workspace is renamed). */
export async function renameWorkspaceDir(
  userId: number,
  oldWsId: number,
  newWsId: number,
): Promise<void> {
  // Identity rename (no-op). wsId doesn't change on rename — name is metadata.
  if (oldWsId === newWsId) return;
  const src = workspaceDir(userId, oldWsId);
  const dst = workspaceDir(userId, newWsId);
  await mkdir(dirname(dst), { recursive: true });
  await rename(src, dst);
}

// Helper to mirror node:path.dirname on the host.
function dirname(p: string): string {
  return pathDirname(p);
}

/** List the contents of a directory (one level) inside the workspace. */
export async function listFiles(
  userId: number,
  wsId: number,
  rel: string,
): Promise<WorkspaceFileEntry[]> {
  const dir = resolveInWorkspace(userId, wsId, rel);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError("Workspace path", rel || "/");
    }
    throw err;
  }
  const root = workspaceDir(userId, wsId);
  const result: WorkspaceFileEntry[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue; // skip entries that disappear mid-walk
    }
    const hostRel = full.slice(root.length).split(sep).join("/");
    result.push({
      name: entry.name,
      path: hostRel.replace(/^\/+/, ""),
      isDir: entry.isDirectory(),
      size: s.isDirectory() ? 0 : s.size,
      mtime: s.mtime.toISOString(),
    });
  }
  // Directories first, then files; both alphabetical.
  result.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

/** Write a file inside the workspace (creates parent dirs). */
export async function writeFile(
  userId: number,
  wsId: number,
  rel: string,
  content: Buffer,
): Promise<void> {
  const abs = resolveInWorkspace(userId, wsId, rel);
  await mkdir(pathDirname(abs), { recursive: true });
  await fsWriteFile(abs, content);
}

/** Read a file inside the workspace as a Buffer. */
export async function readFile(userId: number, wsId: number, rel: string): Promise<Buffer> {
  const abs = resolveInWorkspace(userId, wsId, rel);
  try {
    return await fsReadFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError("Workspace file", rel);
    }
    throw err;
  }
}

/** Delete a file or directory (recursive) inside the workspace. */
export async function deleteFile(userId: number, wsId: number, rel: string): Promise<void> {
  const abs = resolveInWorkspace(userId, wsId, rel);
  if (abs === workspaceDir(userId, wsId)) {
    throw new BadRequestError("Refusing to delete the workspace root");
  }
  try {
    await fsAccess(abs);
  } catch {
    throw new NotFoundError("Workspace path", rel);
  }
  await rm(abs, { recursive: true, force: true });
}

/** Create a directory inside the workspace. */
export async function makeDir(userId: number, wsId: number, rel: string): Promise<void> {
  const abs = resolveInWorkspace(userId, wsId, rel);
  await mkdir(abs, { recursive: true });
}

/** Recursively compute total bytes + file count for a workspace (for listings). */
export async function statWorkspace(
  userId: number,
  wsId: number,
): Promise<{ sizeBytes: number; fileCount: number }> {
  const root = workspaceDir(userId, wsId);
  let sizeBytes = 0;
  let fileCount = 0;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          sizeBytes += (await stat(full)).size;
          fileCount += 1;
        } catch {
          // ignore
        }
      }
    }
  };
  await walk(root);
  return { sizeBytes, fileCount };
}

// `posix` import is reserved for future cross-platform path serialization needs.
void posixPath;
