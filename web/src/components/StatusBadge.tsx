/** Colored status badge for container/user states. */
export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  // Only known statuses get colored; unknown ones fall back to muted.
  const known = ["running", "stopped", "error", "creating", "pending", "destroyed", "active", "disabled"];
  const cls = known.includes(normalized) ? normalized : "destroyed";
  return <span className={`badge ${cls}`}>{status}</span>;
}
