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

// ---- R5: recursive tree, move/rename, chunked uploads ----

export interface TreeEntry extends WorkspaceFileEntry {
  /** Depth relative to the tree root (root's direct children = 0). */
  depth: number;
}

export interface TreeOptions {
  /** Directory names skipped entirely (node_modules, .git, ...). */
  ignore: string[];
  /** Maximum recursion depth (root's children = 0). */
  maxDepth: number;
  /** Stop and mark truncated after this many entries. */
  maxEntries: number;
  /** Continuation cursor from a previous response (last entry path). */
  afterPath?: string;
}

export interface TreeResult {
  entries: TreeEntry[];
  truncated: boolean;
  nextCursor?: string;
}

/**
 * Walk the workspace (or a subdirectory) depth-first and return a flat,
 * path-sorted entry list with depth annotations. Deterministic order (path
 * ascending) makes the `afterPath` cursor stable across pages. The ignore
 * list only applies to directories; hidden files are kept.
 */
export async function walkTree(
  userId: number,
  wsId: number,
  rel: string,
  opts: TreeOptions,
): Promise<TreeResult> {
  const rootDir = resolveInWorkspace(userId, wsId, rel);
  const root = workspaceDir(userId, wsId);
  const entries: TreeEntry[] = [];
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or vanished — skip
    }
    // Sort by name for a stable, cursor-friendly order.
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (truncated) return;
      if (dirent.isDirectory() && opts.ignore.includes(dirent.name)) continue;
      const full = join(dir, dirent.name);
      const hostRel = full.slice(root.length).split(sep).join("/").replace(/^\/+/, "");
      let s;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      const entry: TreeEntry = {
        name: dirent.name,
        path: hostRel,
        isDir: dirent.isDirectory(),
        size: s.isDirectory() ? 0 : s.size,
        mtime: s.mtime.toISOString(),
        depth,
      };
      // Cursor continuation: skip emitting entries at/before the cursor, but
      // STILL descend into directories — their subtree may contain later paths
      // ("docs" <= cursor "docs", yet "docs/a.md" > cursor).
      const beforeCursor = !!opts.afterPath && hostRel <= opts.afterPath!;
      if (!beforeCursor) {
        if (entries.length >= opts.maxEntries) {
          truncated = true;
          return;
        }
        entries.push(entry);
      }
      if (dirent.isDirectory() && depth < opts.maxDepth) {
        await walk(full, depth + 1);
      }
    }
  };

  await walk(rootDir, 0);
  return {
    entries,
    truncated,
    ...(truncated && entries.length > 0 ? { nextCursor: entries[entries.length - 1].path } : {}),
  };
}

/**
 * Move/rename a file or directory within the workspace (R5). `to` semantics
 * mirror `mv`: a trailing slash means "target directory, keep the name";
 * otherwise `to` is the new full path. Containment is enforced on both ends,
 * and a move onto the workspace root or into itself is rejected.
 */
export async function move(
  userId: number,
  wsId: number,
  fromRel: string,
  toRel: string,
): Promise<{ path: string }> {
  const from = resolveInWorkspace(userId, wsId, fromRel);
  const root = workspaceDir(userId, wsId);
  if (from === root) throw new BadRequestError("Refusing to move the workspace root");
  try {
    await fsAccess(from);
  } catch {
    throw new NotFoundError("Workspace path", fromRel);
  }
  const name = from.split(sep).pop()!;
  // Trailing slash (or ".") → target directory; keep the entry's name.
  const asDir = /\/$/.test(toRel) || toRel === "." || toRel === "./";
  const targetRel = asDir ? `${toRel.replace(/\/+$/, "")}/${name}` : toRel;
  const to = resolveInWorkspace(userId, wsId, targetRel);
  if (to === root || to === from) {
    throw new BadRequestError("Invalid move target");
  }
  // Moving a directory into its own subtree would orphan it.
  if (to.startsWith(from + sep)) {
    throw new BadRequestError("Cannot move a directory into itself");
  }
  const hostToRel = to.slice(root.length).split(sep).join("/").replace(/^\/+/, "");
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return { path: hostToRel };
}

// ---- chunked uploads (R5) ----

/** Root directory holding in-flight chunked uploads (per platform instance). */
function uploadsRoot(): string {
  return join(base(), ".uploads");
}

export interface UploadMeta {
  uploadId: string;
  userId: number;
  wsId: number;
  name: string;
  dirRel: string;
  /** Declared total size (optional; enforcement uses actual bytes). */
  size?: number;
  createdAt: number;
}

async function uploadDir(uploadId: string): Promise<string> {
  const dir = join(uploadsRoot(), uploadId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Create an upload session and return its id (meta is kept next to the parts). */
export async function createUpload(
  meta: Omit<UploadMeta, "createdAt">,
): Promise<UploadMeta & { createdAt: number }> {
  const withTime = { ...meta, createdAt: Date.now() };
  const dir = await uploadDir(meta.uploadId);
  await fsWriteFile(join(dir, "meta.json"), JSON.stringify(withTime), "utf8");
  return withTime;
}

/** Read back an upload session's meta; null when unknown or swept. */
export async function readUpload(uploadId: string): Promise<UploadMeta | null> {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(uploadId)) return null;
  try {
    const raw = await fsReadFile(join(uploadsRoot(), uploadId, "meta.json"), "utf8");
    return JSON.parse(raw) as UploadMeta;
  } catch {
    return null;
  }
}

/** Store one numbered part (raw bytes). Parts are opaque until completion. */
export async function writeUploadPart(
  uploadId: string,
  part: number,
  content: Buffer,
): Promise<number> {
  if (!Number.isInteger(part) || part < 1 || part > 100_000) {
    throw new BadRequestError("Part number must be an integer in [1, 100000]");
  }
  const meta = await readUpload(uploadId);
  if (!meta) throw new NotFoundError("Upload session", uploadId);
  const dir = await uploadDir(uploadId);
  await fsWriteFile(join(dir, `part-${String(part).padStart(6, "0")}`), content);
  return content.byteLength;
}

/** Concatenate stored parts (in part-number order) into ordered buffers. */
export async function collectUploadParts(uploadId: string): Promise<Buffer[]> {
  const dir = join(uploadsRoot(), uploadId);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith("part-")).sort();
  } catch {
    throw new NotFoundError("Upload session", uploadId);
  }
  if (names.length === 0) throw new BadRequestError("Upload session has no parts");
  const chunks: Buffer[] = [];
  for (const n of names) chunks.push(await fsReadFile(join(dir, n)));
  return chunks;
}

/** Remove the upload session directory (after completion or on abort). */
export async function removeUpload(uploadId: string): Promise<void> {
  await rm(join(uploadsRoot(), uploadId), { recursive: true, force: true });
}

/**
 * Sweep upload sessions older than ttlHours. Called opportunistically when a
 * new session starts so no background timer is needed (single-instance
 * constraint is documented; see docs/API-REFERENCE.md).
 */
export async function sweepStaleUploads(ttlHours: number): Promise<void> {
  const root = uploadsRoot();
  let ids: string[];
  try {
    ids = await readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - ttlHours * 3600_000;
  for (const id of ids) {
    try {
      const dirStat = await stat(join(root, id));
      if (dirStat.mtimeMs < cutoff) {
        await rm(join(root, id), { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

// `posix` import is reserved for future cross-platform path serialization needs.
void posixPath;
