/**
 * Shared manifest helpers for the Linux-shell executors (SSH + Apptainer CLI).
 *
 * `find -printf` is GNU-only; the SSH executor may target a non-GNU host, in
 * which case callers get a clear error and pi-web falls back to per-file stats.
 * Symlinks are never followed (`-type f` excludes them), matching projection's
 * host-side policy.
 */
import { shellQuote } from "./shell-quote.ts";
import type { ManifestResult } from "./types.ts";

export const MANIFEST_MAX_ENTRIES = 10_000;

/** Shell script that lists regular files under each existing root. */
export function manifestShellScript(roots: string[]): string {
  const quoted = roots.map((root) => shellQuote(root)).join(" ");
  return [
    `for p in ${quoted}; do`,
    `  [ -e "$p" ] || continue;`,
    `  find "$p" \\( -type d -name .git -prune \\) -o \\( -type d -path '*/node_modules/.cache' -prune \\) -o -type f -printf '%s\\t%T@\\t%p\\n'`,
    `done`,
  ].join("\n");
}

/** Parse `size\tmtimeSeconds\tpath` lines into the executor manifest shape. */
export function parseManifestOutput(stdout: string, outputTruncated = false): ManifestResult {
  const entries: ManifestResult["entries"] = [];
  let truncated = outputTruncated;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const first = line.indexOf("\t");
    const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
    if (first <= 0 || second < 0) continue;
    const size = Number(line.slice(0, first));
    const seconds = Number(line.slice(first + 1, second));
    const path = line
      .slice(second + 1)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (!path || !Number.isFinite(size) || !Number.isFinite(seconds)) continue;
    entries.push({ path, size, mtimeMs: Math.round(seconds * 1000) });
    if (entries.length >= MANIFEST_MAX_ENTRIES) {
      truncated = true;
      break;
    }
  }
  return { entries, truncated };
}
