/**
 * Executors barrel: re-exports the public executor surface.
 */
export type { SandboxExecutor, ExecutorKind, ContainerHandle, SnapshotHandle, ExecOptions, ExecResult } from "./types.ts";
export { handleFromRow, persistRunningState } from "./types.ts";
export { MockExecutor } from "./mock-executor.ts";
export { SshExecutor } from "./ssh-executor.ts";
export { ApptainerCliExecutor } from "./apptainer-cli-executor.ts";
export { getExecutor, setExecutorForTesting, resetExecutorForTesting } from "./factory.ts";

import type { SandboxExecutor } from "./types.ts";
/** Alias so app/routes can reference the executor type without importing types.ts separately. */
export type SandboxExecutorRef = SandboxExecutor;
