/**
 * Executor factory.
 *
 * Selects the configured executor, cached as a singleton for the process
 * lifetime. Selection is FAIL-CLOSED:
 *
 *  - EXECUTOR_KIND=ssh | apptainer-cli — that executor, or startup fails.
 *  - EXECUTOR_KIND=auto (default) — probe ssh (when SSH_HOST is configured),
 *    then apptainer-cli; if neither is usable, startup fails with guidance.
 *  - EXECUTOR_KIND=mock — accepted explicitly (local dev/tests on machines
 *    without a container runtime). It executes shells on the platform host,
 *    so it is never reached implicitly and never allowed in production
 *    (see assertSecureProductionConfig).
 *
 * The old behavior — silently degrading to MockExecutor whenever nothing else
 * probed OK — turned a misconfigured production host into an unisolated one
 * that still reported "healthy". That path is deliberately gone.
 */
import type { SandboxExecutor, ExecutorKind } from "./types.ts";
import { MockExecutor } from "./mock-executor.ts";
import { SshExecutor } from "./ssh-executor.ts";
import { ApptainerCliExecutor } from "./apptainer-cli-executor.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../utils/logger.ts";

let cached: SandboxExecutor | undefined;

function resolveOrder(config: ReturnType<typeof loadConfig>): ExecutorKind[] {
  const preferred = config.executor.kind;
  if (preferred !== "auto") return [preferred];
  // auto: real executors only, most-managed first.
  return config.executor.ssh.host ? ["ssh", "apptainer-cli"] : ["apptainer-cli"];
}

export async function getExecutor(): Promise<SandboxExecutor> {
  if (cached) return cached;

  const config = loadConfig();
  const order = resolveOrder(config);
  const failures: string[] = [];

  for (const kind of order) {
    const candidate = createExecutor(kind);
    try {
      const ok = await candidate.isAvailable();
      if (ok) {
        logger.info({ kind: candidate.kind }, "Executor selected.");
        cached = candidate;
        return candidate;
      }
      failures.push(`${kind}: unavailable`);
      logger.info({ kind, reason: "unavailable" }, "Executor skipped.");
    } catch (err) {
      failures.push(`${kind}: ${(err as Error).message}`);
      logger.warn({ kind, error: (err as Error).message }, "Executor probe failed; skipping.");
    }
  }

  throw new Error(
    `没有可用的沙盒执行器（EXECUTOR_KIND=${config.executor.kind}，尝试：${failures.join("; ")}）。` +
      `mock 执行器在宿主机上直接运行用户命令、无任何隔离，必须显式指定：本地开发请在 .env 设置 EXECUTOR_KIND=mock，` +
      `生产环境请配置 EXECUTOR_KIND=ssh（SSH_HOST 等）或 EXECUTOR_KIND=apptainer-cli 后重启。`,
  );
}

function createExecutor(kind: ExecutorKind): SandboxExecutor {
  switch (kind) {
    case "mock":
      return new MockExecutor();
    case "ssh":
      return new SshExecutor();
    case "apptainer-cli":
      return new ApptainerCliExecutor();
    case "auto":
      throw new Error("auto must be resolved to a concrete kind before createExecutor");
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
