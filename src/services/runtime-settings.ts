/**
 * Runtime-adjustable limits — data/runtime-settings.json.
 *
 * Deployment config (env) remains the DEFAULT/S EED; this file only carries
 * admin-set overrides so a cap can be raised or lowered without restarting the
 * platform (the raw upload parsers read the effective value per request).
 * Deleting an override restores the env default.
 *
 * The file lives next to the SQLite database so it travels with the data dir
 * (backup/restore flows already capture that directory); postgres deployments
 * fall back to the resolved "./data" path.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, resolveAppPath } from "../config.ts";
import { BadRequestError } from "../utils/errors.ts";

/** Sanity bounds for the per-file workspace upload cap. */
export const UPLOAD_MAX_MIN_BYTES = 1 * 1024 * 1024;
export const UPLOAD_MAX_CEILING_BYTES = 64 * 1024 * 1024 * 1024;

export interface RuntimeSettings {
  /** Per-file workspace upload cap (null/absent = config default). */
  workspaceUploadMaxBytes?: number;
}

let cached: { path: string; mtimeMs: number; data: RuntimeSettings } | undefined;

/** Override for tests/deployments that relocate the data dir. Deliberately
 *  NOT derived from the DB path: createApp()/tests can inject a database that
 *  differs from the config value, and limits would then be read from a stale
 *  location. */
export function runtimeSettingsPath(): string {
  return resolveAppPath(process.env.RUNTIME_SETTINGS_PATH ?? "./data/runtime-settings.json");
}

function parseSettings(raw: unknown): RuntimeSettings {
  if (!raw || typeof raw !== "object") return {};
  const value = (raw as { workspaceUploadMaxBytes?: unknown }).workspaceUploadMaxBytes;
  if (typeof value !== "number" || !Number.isInteger(value)) return {};
  if (value < UPLOAD_MAX_MIN_BYTES || value > UPLOAD_MAX_CEILING_BYTES) return {};
  return { workspaceUploadMaxBytes: value };
}

export function readRuntimeSettings(): RuntimeSettings {
  const path = runtimeSettingsPath();
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return {};
  }
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.data;
  try {
    const data = parseSettings(JSON.parse(readFileSync(path, "utf8")));
    cached = { path, mtimeMs, data };
    return data;
  } catch {
    // Malformed file must not break uploads — behave as "no override" and let
    // the next admin write repair it.
    cached = { path, mtimeMs, data: {} };
    return {};
  }
}

/** Effective per-file workspace upload cap: runtime override, else env default. */
export function effectiveWorkspaceUploadMaxBytes(): number {
  return readRuntimeSettings().workspaceUploadMaxBytes ?? loadConfig().workspace.uploadMaxBytes;
}

/** Admin-facing view (effective value + bounds so the UI can validate). */
export function workspaceUploadLimitsView(): {
  workspaceUploadMaxBytes: number;
  envDefaultBytes: number;
  minBytes: number;
  maxBytes: number;
} {
  return {
    workspaceUploadMaxBytes: effectiveWorkspaceUploadMaxBytes(),
    envDefaultBytes: loadConfig().workspace.uploadMaxBytes,
    minBytes: UPLOAD_MAX_MIN_BYTES,
    maxBytes: UPLOAD_MAX_CEILING_BYTES,
  };
}

/** Persist one override; `null` removes it (back to the env default). */
export function setWorkspaceUploadMaxBytes(bytes: number | null): RuntimeSettings {
  if (bytes !== null) {
    if (!Number.isInteger(bytes) || bytes < UPLOAD_MAX_MIN_BYTES || bytes > UPLOAD_MAX_CEILING_BYTES) {
      throw new BadRequestError(
        `workspaceUploadMaxBytes 必须是 ${UPLOAD_MAX_MIN_BYTES}–${UPLOAD_MAX_CEILING_BYTES} 之间的整数（字节）`,
      );
    }
  }
  const current = readRuntimeSettings();
  const next: RuntimeSettings = { ...current };
  if (bytes === null) delete next.workspaceUploadMaxBytes;
  else next.workspaceUploadMaxBytes = bytes;
  const path = runtimeSettingsPath();
  if (Object.keys(next).length === 0 && !existsSync(path)) {
    cached = undefined;
    return next;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, path);
  cached = undefined;
  return next;
}
