/**
 * Container input/output mount helpers (docs/沙盒输入输出挂载设计.md).
 *
 * Model:
 *   /input  ← read-only bind of a per-container STAGING dir on the platform
 *             host. "挂载一个文件/子目录" = the platform materializes the
 *             selected workspace item into the staging dir (host-side write),
 *             which the bind makes instantly visible in the container — no
 *             restart needed, container can never write back (:ro).
 *   /output ← read-write bind of <workspace>/outputs/<container-name>/ —
 *             writes land in the user's workspace directly (live reclaim).
 *
 * All host paths are DERIVED here (staging root + workspace storage root);
 * callers only ever pass (workspaceId, relPath) pairs validated against the
 * workspace storage layer's containment rules.
 */
import { cp, lstat, mkdir, readdir, rm, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { BadRequestError, NotFoundError } from "../utils/errors.ts";
import { secureResolve } from "./workspace-storage.ts";

/** Per-container input staging root: sibling of the workspaces base dir. */
export function containerInputBase(): string {
  const wsBase = resolve(loadConfig().executor.apptainer.workspaceBaseDir);
  return resolve(dirname(wsBase), "container-inputs");
}

export function inputDir(instanceId: string): string {
  return join(containerInputBase(), instanceId);
}

export async function ensureInputDir(instanceId: string): Promise<string> {
  const dir = inputDir(instanceId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Remove the staging dir (container destroy). Best-effort contract. */
export async function removeInputDir(instanceId: string): Promise<void> {
  await rm(inputDir(instanceId), { recursive: true, force: true });
}

/** Output lives under the TARGET WORKSPACE at outputs/<container-name>/. */
export function outputRelDir(containerName: string): string {
  return `outputs/${sanitizeMountName(containerName) || "container"}`;
}

export async function ensureOutputDir(userId: number, workspaceId: number, containerName: string): Promise<string> {
  // secureResolve rejects symlinks in every component: a previous container
  // could have planted `outputs -> C:\outside` through its RW bind, and a
  // plain mkdir would then create the new output dir OUTSIDE the workspace.
  const dir = await secureResolve(userId, workspaceId, outputRelDir(containerName));
  await mkdir(dir, { recursive: true });
  await assertDirHasNoSymlinks(dir);
  return dir;
}

/** Mount-safe name: strip separators, whitespace and anything hostile for a
 *  staging entry or an outputs/ dir segment. */
export function sanitizeMountName(name: string): string {
  const cleaned = name.replace(/[\\/\s\0]/g, "_").replace(/^\.+/, "").trim();
  return cleaned.slice(0, 120);
}

/**
 * Resolve a user-selected input item to its host path under the workspace
 * storage root. Rejects: traversal (via storage layer), missing items, and
 * top-level symlinks (an input item must be a real file or directory — a
 * symlink could point anywhere and would dangle or mislead in the container).
 */
export async function resolveInputSource(
  userId: number,
  workspaceId: number,
  relPath: string,
): Promise<{ hostPath: string; name: string; isDir: boolean; sizeBytes: number }> {
  // secureResolve rejects symlinks in ANY component, not just the selected
  // item: mounting `link/file` where `link` is a host symlink used to copy an
  // external file into /input (host-file disclosure).
  const hostPath = await secureResolve(userId, workspaceId, relPath);
  const lstats = await lstat(hostPath).catch(() => null);
  if (!lstats) throw new NotFoundError("Workspace item", relPath);
  if (lstats.isSymbolicLink()) {
    throw new BadRequestError("输入挂载项不能是符号链接（请选择真实文件或目录）");
  }
  const sizeBytes = await duBytes(hostPath);
  return {
    hostPath,
    name: sanitizeMountName(basename(hostPath)) || "input",
    isDir: lstats.isDirectory(),
    sizeBytes,
  };
}

/** Bounded recursive size (bytes). Caps the walk so a hostile tree cannot hang the platform. */
export async function duBytes(hostPath: string, maxEntries = 100_000): Promise<number> {
  let total = 0;
  let entries = 0;
  const walk = async (p: string): Promise<void> => {
    if (entries++ > maxEntries) throw new BadRequestError("输入项文件数过多（>100000）");
    const s = await lstat(p).catch(() => null);
    if (!s) return;
    if (s.isSymbolicLink()) {
      throw new BadRequestError("输入项包含符号链接（已拒绝）");
    }
    if (!s.isDirectory()) {
      total += s.size;
      return;
    }
    const names = await readdir(p).catch(() => []);
    for (const n of names) await walk(join(p, n));
  };
  await walk(hostPath);
  return total;
}

/**
 * Copy the workspace item into the staging dir under a collision-free name.
 * Returns the staging entry name actually used.
 */
export async function materializeInput(src: string, stagingDir: string, name: string): Promise<string> {
  let target = join(stagingDir, name);
  let finalName = name;
  for (let i = 1; ; i += 1) {
    const exists = await lstat(target).catch(() => null);
    if (!exists) break;
    const dot = name.lastIndexOf(".");
    finalName = dot > 0 ? `${name.slice(0, dot)}-${i}${name.slice(dot)}` : `${name}-${i}`;
    target = join(stagingDir, finalName);
    if (i > 64) throw new BadRequestError("同名输入项过多");
  }
  await cp(src, target, {
    recursive: true,
    // Do not follow symlinks inside the copied tree: they would either dangle
    // in the container or copy unintended external content into the staging.
    verbatimSymlinks: false,
    dereference: false,
  });
  return finalName;
}

/** Remove one staging entry by name (un-mount). Best-effort: missing = ok. */
export async function removeStagingEntry(stagingDir: string, name: string): Promise<void> {
  const safe = sanitizeMountName(name);
  if (!safe) return;
  await rm(join(stagingDir, safe), { recursive: true, force: true });
}

/**
 * Output-dir guard: the RW bind lets the container create arbitrary entries in
 * the workspace folder — including SYMLINKS pointing at host paths outside the
 * workspace, which the workspace API would then serve (host file disclosure).
 * Refuse to (re)bind when the output dir contains any symlink; the platform
 * keeps the container stopped with a clear error instead.
 */
export async function assertDirHasNoSymlinks(dir: string, maxEntries = 100_000): Promise<void> {
  let entries = 0;
  const walk = async (p: string): Promise<void> => {
    // readdir dirents do NOT follow symlinks, so e.isDirectory() is false for
    // dir-symlinks too — classify via lstat and recurse only into real dirs.
    const names = await readdir(p, { withFileTypes: true }).catch(() => []);
    for (const e of names) {
      if (entries++ > maxEntries) return;
      const child = join(p, e.name);
      if (e.isSymbolicLink()) {
        const resolved = await realpath(child).catch(() => "");
        throw new BadRequestError(
          `输出目录包含符号链接（${e.name} → ${resolved || "不可解析"}）：为防宿主文件泄露，请先在工作区中处理后再启动容器`,
        );
      }
      if (e.isDirectory()) await walk(child);
    }
  };
  await walk(dir);
}

/** Per-container mount caps (env: CONTAINER_MAX_INPUT_MOUNTS / CONTAINER_MAX_INPUT_BYTES). */
export function mountLimits(): { maxInputs: number; maxInputBytes: number } {
  return loadConfig().mounts;
}
