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

  // In production the fallback chain must NEVER land on the mock executor
  // silently: it "creates" containers as plain host directories and reports
  // success — a dangerous degradation that looks like a working deployment.
  const allowMock =
    preferred === "mock" || config.nodeEnv !== "production";

  // Try the configured executor first, then walk the fallback chain.
  const chain = allowMock ? FALLBACK_CHAIN : FALLBACK_CHAIN.filter((k) => k !== "mock");
  const order: ExecutorKind[] = [preferred, ...chain.filter((k) => k !== preferred)];

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

  if (!allowMock) {
    throw new Error(
      `EXECUTOR_KIND=${preferred} 不可用（探测失败），且生产环境禁止回退到 mock 执行器。请检查 apptainer/ssh 配置后重启。`,
    );
  }

  // Dev/demo only: MockExecutor is always available as a last resort.
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
