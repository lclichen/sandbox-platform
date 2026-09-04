/**
 * Per-container async mutex (fix plan C6).
 *
 * Every lifecycle transition (start/stop/snapshot/restore/destroy, reaper
 * reclaim) serializes per container id. Without this, read-row → act →
 * write-row races let the reaper kill a freshly restarted instance, or let a
 * snapshot's finally-restart resurrect a destroyed container.
 *
 * Single-process by design (the platform is single-instance; see
 * workspace-storage notes). Entries self-clean once the tail settles.
 */
const locks = new Map<number, Promise<unknown>>();

export function withContainerLock<T>(containerId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(containerId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous holder's outcome
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(containerId, tail);
  void tail.then(() => {
    if (locks.get(containerId) === tail) locks.delete(containerId);
  });
  return run;
}
