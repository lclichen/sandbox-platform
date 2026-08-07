/**
 * Executor factory.
 *
 * Selects the configured executor and, if the first choice is unavailable at
 * startup, falls back through a preference chain: ssh -> apptainer-cli -> mock.
 * The chosen executor is cached as a singleton for the process lifetime.
 */
import type { SandboxExecutor, ExecutorKind } from "./types.ts";
import { MockExecutor } from "./mock-executor.ts";
import { SshExecutor } from "./ssh-executor.ts";
import { ApptainerCliExecutor } from "./apptainer-cli-executor.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../utils/logger.ts";

const FALLBACK_CHAIN: ExecutorKind[] = ["ssh", "apptainer-cli", "mock"];

let cached: SandboxExecutor | undefined;

export async function getExecutor(): Promise<SandboxExecutor> {
  if (cached) return cached;

  const config = loadConfig();
  const preferred = config.executor.kind;

  // Try the configured executor first, then walk the fallback chain.
  const order: ExecutorKind[] = [preferred, ...FALLBACK_CHAIN.filter((k) => k !== preferred)];

  for (const kind of order) {
    const candidate = createExecutor(kind);
    try {
      const ok = await candidate.isAvailable();
      if (ok) {
        logger.info({ kind: candidate.kind }, "Executor selected.");
        cached = candidate;
        return candidate;
      }
      logger.info({ kind, reason: "unavailable" }, "Executor skipped.");
    } catch (err) {
      logger.warn({ kind, error: (err as Error).message }, "Executor probe failed; skipping.");
    }
  }

  // MockExecutor is always available as a last resort (it only needs mkdir).
  logger.warn("No executor available; falling back to MockExecutor unconditionally.");
  cached = new MockExecutor();
  return cached;
}

function createExecutor(kind: ExecutorKind): SandboxExecutor {
  switch (kind) {
    case "mock":
      return new MockExecutor();
    case "ssh":
      return new SshExecutor();
    case "apptainer-cli":
      return new ApptainerCliExecutor();
  }
}

/** Test-only: inject an executor (e.g. a MockExecutor on a temp dir). */
export function setExecutorForTesting(executor: SandboxExecutor): void {
  cached = executor;
}

/** Test-only: clear the cached executor. */
export function resetExecutorForTesting(): void {
  cached = undefined;
}
