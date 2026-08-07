import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { LogRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";

const PAGE_SIZE = 50;

interface Filters {
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  status: string;
}

const EMPTY_FILTERS: Filters = {
  userId: "",
  action: "",
  resourceType: "",
  resourceId: "",
  status: "",
};

export function Logs() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const common = {
        action: applied.action || undefined,
        resourceType: applied.resourceType || undefined,
        resourceId: applied.resourceId ? Number(applied.resourceId) : undefined,
        status: applied.status || undefined,
        limit: PAGE_SIZE,
        offset,
      };
      // Admins can query across users (with an optional userId filter); regular
      // users are always scoped to their own logs server-side.
      const res = isAdmin
        ? await api.listLogs({ ...common, userId: applied.userId ? Number(applied.userId) : undefined })
        : await api.myLogs(common);
      setLogs(res.logs);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [applied, offset, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = () => {
    setApplied(filters);
    setOffset(0);
  };

  const reset = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setOffset(0);
  };

  const set = (key: keyof Filters, value: string) => setFilters({ ...filters, [key]: value });

  return (
    <>
      <div className="page-header">
        <h1>Operation logs</h1>
        <span className="muted">
          {total} entr{total === 1 ? "y" : "ies"}
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="toolbar">
        {isAdmin && (
          <input placeholder="User ID" value={filters.userId} onChange={(e) => set("userId", e.target.value)} />
        )}
        <input placeholder="Action" value={filters.action} onChange={(e) => set("action", e.target.value)} />
        <input
          placeholder="Resource type"
          value={filters.resourceType}
          onChange={(e) => set("resourceType", e.target.value)}
        />
        <input
          placeholder="Resource ID"
          value={filters.resourceId}
          onChange={(e) => set("resourceId", e.target.value)}
        />
        <select value={filters.status} onChange={(e) => set("status", e.target.value)}>
          <option value="">Any status</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
        </select>
        <button className="primary small" onClick={apply}>
          Apply
        </button>
        <button className="small" onClick={reset}>
          Reset
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              {isAdmin && <th>User</th>}
              <th>Action</th>
              <th>Resource</th>
              <th>Status</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={isAdmin ? 6 : 5} className="center-msg">
                  Loading…
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 6 : 5} className="center-msg">
                  No log entries.
                </td>
              </tr>
            ) : (
              logs.map((l) => (
                <tr key={l.id}>
                  <td className="muted">{new Date(l.created_at).toLocaleString()}</td>
                  {isAdmin && <td className="muted">{l.user_id ?? "—"}</td>}
                  <td>
                    <code style={{ fontSize: 12 }}>{l.action}</code>
                  </td>
                  <td className="muted">
                    {l.resource_type}
                    {l.resource_id ? ` #${l.resource_id}` : ""}
                  </td>
                  <td>
                    <span className={`badge ${l.status === "success" ? "running" : "error"}`}>{l.status}</span>
                  </td>
                  <td className="muted">{l.ip ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span>
          Showing {offset + 1}–{Math.min(offset + logs.length, total)} of {total}
        </span>
        <span>
          <button className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </button>{" "}
          <button
            className="small"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </span>
      </div>
    </>
  );
}
