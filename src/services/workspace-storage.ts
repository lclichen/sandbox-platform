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
import {
  mkdir,
  rm,
  readdir,
  stat,
  lstat,
  rename,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  access as fsAccess,
} from "node:fs/promises";
import { createReadStream as fsCreateReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join, resolve, posix as posixPath, dirname as pathDirname, sep } from "node:path";
import { loadConfig } from "../config.ts";
import { effectiveWorkspaceUploadMaxBytes } from "./runtime-settings.ts";
import { BadRequestError, HttpError, NotFoundError } from "../utils/errors.ts";

/** Effective cap for one chunked-upload request (env: WORKSPACE_UPLOAD_PART_MAX_BYTES). */
export function uploadPartMaxBytes(): number {
  return loadConfig().workspace.uploadPartMaxBytes;
}

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

/**
 * Realpath containment (symlink-escape guard). resolveInWorkspace blocks
 * lexical `..` traversal but a SYMLINK inside the workspace — e.g. one planted
 * by a container through its RW /output bind — resolves to an arbitrary host
 * path and would be served/deleted/overwritten by the workspace API. Every
 * mutating or content-reading operation therefore verifies the REAL path of
 * the final target (and of each parent being written through) stays inside
 * the workspace's real root. Missing targets pass through so the operation
 * itself raises the proper 404.
 */
async function assertRealWithin(root: string, candidate: string): Promise<void> {
  const realRoot = await realpathNative(root).catch(() => root);
  const real = await realpathNative(candidate).catch(() => null);
  if (real === null) return; // absent — the op will 404 on its own
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (real !== realRoot && !real.startsWith(prefix)) {
    throw new BadRequestError("路径解析到工作区之外（符号链接被拒绝）");
  }
}

const realpathNative = (p: string) => import("node:fs/promises").then((m) => m.realpath(p));

async function lstatOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

/**
 * Reject ANY symlink component between the workspace root and `candidate`
 * (including a dangling final symlink). The old check only realpath'd the
 * final target, so `link -> C:\\outside` as a PARENT directory still let
 * writeFile/makeDir/move escape: the final file did not exist yet, realpath
 * returned null, and the operation created files outside the workspace.
 *
 * The workspace root itself is trusted (deployments may symlink
 * WORKSPACE_BASE_DIR); every component below it must be a real directory/file.
 */
export async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  const rootAbs = resolve(root);
  const realRoot = (await realpathNative(rootAbs).catch(() => null)) ?? rootAbs;
  let cur = resolve(candidate);
  for (;;) {
    if (cur === rootAbs) return; // reached the trusted root
    const st = await lstatOrNull(cur);
    if (st) {
      if (st.isSymbolicLink()) {
        throw new BadRequestError("路径包含符号链接（已拒绝，防止逃逸工作区）");
      }
      const real = await realpathNative(cur).catch(() => null);
      if (!real || (real !== realRoot && !real.startsWith(realRoot + sep))) {
        throw new BadRequestError("路径解析到工作区之外（符号链接被拒绝）");
      }
      return;
    }
    const parent = pathDirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}

/** Resolve + realpath-verify a workspace path (containment on both layers). */
export async function secureResolve(userId: number, wsId: number, rel: string): Promise<string> {
  const abs = resolveInWorkspace(userId, wsId, rel);
  const root = workspaceDir(userId, wsId);
  await assertNoSymlinkComponents(root, abs);
  await assertRealWithin(root, abs);
  return abs;
}

/** List the contents of a directory (one level) inside the workspace. */
export async function listFiles(
  userId: number,
  wsId: number,
  rel: string,
): Promise<WorkspaceFileEntry[]> {
  const dir = await secureResolve(userId, wsId, rel);
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
      // lstat, not stat: a symlink entry must report its own (zero-ish) size
      // instead of leaking the size/mtime of an arbitrary host target.
      s = await lstat(full);
    } catch {
      continue; // skip entries that disappear mid-walk
    }
    const hostRel = full.slice(root.length).split(sep).join("/");
    result.push({
      name: entry.name,
      path: hostRel.replace(/^\/+/, ""),
      isDir: entry.isDirectory(),
      size: entry.isDirectory() || s.isSymbolicLink() ? 0 : s.size,
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
  const abs = await secureResolve(userId, wsId, rel);
  const parent = pathDirname(abs);
  await mkdir(parent, { recursive: true });
  // Re-check after mkdir: the path was absent during secureResolve, so this
  // is the first point where every parent exists and can be verified. A
  // container racing a symlink into the tree is rejected here (no write).
  await assertNoSymlinkComponents(workspaceDir(userId, wsId), parent);
  await fsWriteFile(abs, content);
}

/** Size of a regular file inside the workspace (lstat — never a symlink target). */
export async function fileSize(userId: number, wsId: number, rel: string): Promise<number> {
  const abs = await secureResolve(userId, wsId, rel);
  const s = await lstat(abs).catch(() => null);
  if (!s || !s.isFile()) throw new NotFoundError("Workspace file", rel);
  return Number(s.size);
}

/** Resolve a downloadable file + its size (no buffering). */
export async function resolveDownloadFile(
  userId: number,
  wsId: number,
  rel: string,
): Promise<{ abs: string; size: number }> {
  const abs = await secureResolve(userId, wsId, rel);
  const s = await lstat(abs).catch(() => null);
  if (!s || !s.isFile()) throw new NotFoundError("Workspace file", rel);
  return { abs, size: Number(s.size) };
}

/** Ensure the target's parent exists and still has no symlink components. */
async function prepareTarget(userId: number, wsId: number, rel: string): Promise<string> {
  const abs = await secureResolve(userId, wsId, rel);
  const parent = pathDirname(abs);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkComponents(workspaceDir(userId, wsId), parent);
  return abs;
}

/**
 * Move a staged temp file into place. On POSIX rename replaces atomically.
 * Windows' MoveFileEx is also replace-capable in libuv; the fallback only
 * handles filesystems that refuse to replace, without touching directories.
 */
async function commitStagedFile(tmp: string, abs: string): Promise<void> {
  try {
    await rename(tmp, abs);
  } catch (err) {
    const existing = await lstat(abs).catch(() => null);
    if (!existing || !existing.isFile()) throw err;
    await rm(abs, { force: true });
    await rename(tmp, abs);
  }
}

/**
 * Stream an upload body into the workspace without buffering it in memory.
 * The body is written to a staging file first, the caller's `beforeCommit`
 * (aggregate-disk quota) runs, and only then is it renamed over the target.
 * A failed/aborted upload never destroys an existing file.
 */
export async function writeFileFromStream(
  userId: number,
  wsId: number,
  rel: string,
  input: Readable,
  maxBytes: number,
  beforeCommit?: (size: number) => Promise<void>,
): Promise<{ size: number }> {
  const abs = await prepareTarget(userId, wsId, rel);
  const tmpDir = uploadsRoot();
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `stream-${randomUUID()}.tmp`);
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        callback(new HttpError(413, "UPLOAD_TOO_LARGE", `upload exceeds the ${maxBytes}-byte limit`));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(input, counter, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
    if (beforeCommit) await beforeCommit(received);
    await commitStagedFile(tmp, abs);
    return { size: received };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if ((err as NodeJS.ErrnoException)?.code === "ERR_STREAM_PREMATURE_CLOSE") {
      throw new BadRequestError("upload aborted by client");
    }
    throw err;
  }
}

/**
 * Concatenate a completed chunked upload into the target file using streams.
 * Parts are read one at a time (8 MiB default), so completing a 2 GiB file
 * never materializes 2 GiB in the process heap.
 */
export async function writeUploadPartsToFile(
  uploadId: string,
  userId: number,
  wsId: number,
  rel: string,
  maxBytes: number,
  beforeCommit?: (size: number) => Promise<void>,
): Promise<{ size: number }> {
  const abs = await prepareTarget(userId, wsId, rel);
  const dir = join(uploadsRoot(), uploadId);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith("part-")).sort();
  } catch {
    throw new NotFoundError("Upload session", uploadId);
  }
  if (names.length === 0) throw new BadRequestError("Upload session has no parts");

  const tmpDir = uploadsRoot();
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `complete-${randomUUID()}.tmp`);
  const out = createWriteStream(tmp, { flags: "wx", mode: 0o600 });
  // A Writable with no error listener crashes the process on ENOSPC/EIO.
  // Keep the error and surface it from the read loop.
  let writeError: Error | undefined;
  out.on("error", (err) => {
    writeError = err;
  });
  let total = 0;
  try {
    for (const name of names) {
      const partPath = join(dir, name);
      const s = await lstat(partPath).catch(() => null);
      if (!s?.isFile()) continue;
      total += Number(s.size);
      if (total > maxBytes) {
        throw new HttpError(413, "UPLOAD_TOO_LARGE", `upload exceeds the ${maxBytes}-byte limit`);
      }
      for await (const chunk of fsCreateReadStream(partPath)) {
        if (writeError) throw writeError;
        if (!out.write(chunk)) await once(out, "drain");
      }
      if (writeError) throw writeError;
    }
    if (writeError) throw writeError;
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
    if (beforeCommit) await beforeCommit(total);
    await commitStagedFile(tmp, abs);
    return { size: total };
  } catch (err) {
    out.destroy();
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Read a file inside the workspace as a Buffer. */
export async function readFile(userId: number, wsId: number, rel: string): Promise<Buffer> {
  const abs = await secureResolve(userId, wsId, rel);
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
  const abs = await secureResolve(userId, wsId, rel);
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
  const abs = await secureResolve(userId, wsId, rel);
  await mkdir(abs, { recursive: true });
  await assertNoSymlinkComponents(workspaceDir(userId, wsId), abs);
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
      // Never follow symlinks: a planted link could otherwise make the
      // workspace's recorded size include arbitrary host files (quota evasion
      // and an information leak about their existence/size).
      if (entry.isSymbolicLink()) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          sizeBytes += (await lstat(full)).size;
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
  const rootDir = await secureResolve(userId, wsId, rel);
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
        s = await lstat(full);
      } catch {
        continue;
      }
      // Do not expose symlink targets through the tree API (and never descend
      // into them); the storage layer refuses them for reads/writes anyway.
      if (s.isSymbolicLink()) continue;
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
  const from = await secureResolve(userId, wsId, fromRel);
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
  const to = await secureResolve(userId, wsId, targetRel);
  if (to === root || to === from) {
    throw new BadRequestError("Invalid move target");
  }
  // Moving a directory into its own subtree would orphan it.
  if (to.startsWith(from + sep)) {
    throw new BadRequestError("Cannot move a directory into itself");
  }
  const hostToRel = to.slice(root.length).split(sep).join("/").replace(/^\/+/, "");
  await mkdir(dirname(to), { recursive: true });
  await assertNoSymlinkComponents(root, dirname(to));
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
  /** Bytes persisted so far, maintained by writeUploadPart (disk-bound cap). */
  receivedBytes?: number;
  createdAt: number;
}

async function uploadDir(uploadId: string): Promise<string> {
  const dir = join(uploadsRoot(), uploadId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeUploadMeta(uploadId: string, meta: UploadMeta): Promise<void> {
  const dir = await uploadDir(uploadId);
  const tmp = join(dir, "meta.json.tmp");
  await fsWriteFile(tmp, JSON.stringify(meta), "utf8");
  await rename(tmp, join(dir, "meta.json"));
}

/** Create an upload session and return its id (meta is kept next to the parts). */
export async function createUpload(
  meta: Omit<UploadMeta, "createdAt">,
): Promise<UploadMeta & { createdAt: number }> {
  const withTime = { ...meta, createdAt: Date.now(), receivedBytes: 0 };
  await writeUploadMeta(meta.uploadId, withTime);
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

/**
 * Store one numbered part (raw bytes). Parts are opaque until completion.
 *
 * SECURITY: each part and the session total are capped HERE, not only at
 * completion. Previously a client could stream unlimited 8 MiB parts into
 * .uploads (the total was checked only after every part had hit disk), which
 * let any authenticated user fill the platform volume.
 */
export async function writeUploadPart(
  uploadId: string,
  part: number,
  content: Buffer,
): Promise<number> {
  if (!Number.isInteger(part) || part < 1 || part > 100_000) {
    throw new BadRequestError("Part number must be an integer in [1, 100000]");
  }
  const partMax = uploadPartMaxBytes();
  if (content.byteLength > partMax) {
    throw new HttpError(413, "UPLOAD_TOO_LARGE", `upload part exceeds ${partMax} bytes`);
  }
  const meta = await readUpload(uploadId);
  if (!meta) throw new NotFoundError("Upload session", uploadId);
  const dir = await uploadDir(uploadId);
  const partPath = join(dir, `part-${String(part).padStart(6, "0")}`);
  const existing = await lstatOrNull(partPath);
  const previousBytes = existing?.isFile() ? Number(existing.size) : 0;
  // Sessions created before receivedBytes existed have no counter; measure the
  // parts that are already on disk so a legacy session cannot bypass the cap.
  const alreadyStored = meta.receivedBytes ?? (await sumStoredParts(uploadId));
  const nextTotal = alreadyStored + content.byteLength - previousBytes;
  const maxBytes = effectiveWorkspaceUploadMaxBytes();
  if (nextTotal > maxBytes) {
    throw new HttpError(413, "UPLOAD_TOO_LARGE", `upload exceeds the ${maxBytes}-byte limit`);
  }
  await fsWriteFile(partPath, content);
  await writeUploadMeta(uploadId, { ...meta, receivedBytes: Math.max(0, nextTotal) });
  return content.byteLength;
}


/** Sum every stored part's size (used for legacy sessions without receivedBytes). */
async function sumStoredParts(uploadId: string): Promise<number> {
  const dir = join(uploadsRoot(), uploadId);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith("part-"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const n of names) {
    const s = await lstat(join(dir, n)).catch(() => null);
    if (s?.isFile()) total += Number(s.size);
  }
  return total;
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
