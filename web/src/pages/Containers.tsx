import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { ContainerPublic, SnapshotRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { StatusBadge } from "../components/StatusBadge";
import { ConfirmButton } from "../components/ConfirmDialog";

const PAGE_SIZE = 30;

export function Containers() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [containers, setContainers] = useState<ContainerPublic[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Admins see all containers (global view); regular users see their own.
      const fn = isAdmin ? api.listAllContainers : api.listContainers;
      const res = await fn({ limit: PAGE_SIZE, offset, status: statusFilter });
      setContainers(res.containers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load containers");
    } finally {
      setLoading(false);
    }
  }, [offset, statusFilter, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Operation failed");
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Containers</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted">{isAdmin ? "all users · admin view" : "my containers"}</span>
          <button className="small" onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="toolbar">
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }}>
          <option value="">All statuses</option>
          <option value="running">running</option>
          <option value="stopped">stopped</option>
          <option value="error">error</option>
          <option value="destroyed">destroyed</option>
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Resources</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="center-msg">
                  Loading…
                </td>
              </tr>
            ) : containers.length === 0 ? (
              <tr>
                <td colSpan={7} className="center-msg">
                  No containers.
                </td>
              </tr>
            ) : (
              containers.map((c) => (
                <ContainerRow
                  key={c.id}
                  container={c}
                  expanded={expanded === c.id}
                  onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
                  onAct={act}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span></span>
        <span>
          <button className="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </button>{" "}
          <button className="small" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={containers.length < PAGE_SIZE}>
            Next
          </button>
        </span>
      </div>
    </>
  );
}

function ContainerRow({
  container: c,
  expanded,
  onToggle,
  onAct,
}: {
  container: ContainerPublic;
  expanded: boolean;
  onToggle: () => void;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const runnable = c.status === "running";
  const stopped = c.status === "stopped";

  return (
    <>
      <tr style={{ cursor: "pointer" }} onClick={onToggle}>
        <td className="muted">{c.id}</td>
        <td>{c.name}</td>
        <td className="muted">user {c.user_id}</td>
        <td>
          <StatusBadge status={c.status} />
        </td>
        <td className="muted">
          {c.cpu}cpu / {c.memory_mb}MB / {c.disk_gb}GB
        </td>
        <td className="muted">{new Date(c.created_at).toLocaleString()}</td>
        <td className="actions" onClick={(e) => e.stopPropagation()}>
          {stopped && (
            <button className="small" onClick={() => onAct(() => api.startContainer(c.id))}>
              Start
            </button>
          )}
          {runnable && (
            <button className="small" onClick={() => onAct(() => api.stopContainer(c.id))}>
              Stop
            </button>
          )}
          {c.status !== "destroyed" && (
            <ConfirmButton
              className="small danger"
              message={`Destroy container "${c.name}"? Its overlay will be deleted.`}
              confirmLabel="Destroy"
              onConfirm={async () => {
                await api.destroyContainer(c.id);
              }}
            >
              Destroy
            </ConfirmButton>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ padding: 0 }}>
            <SnapshotsPane containerId={c.id} onAct={onAct} />
          </td>
        </tr>
      )}
    </>
  );
}

function SnapshotsPane({
  containerId,
  onAct,
}: {
  containerId: number;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [snaps, setSnaps] = useState<SnapshotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.listSnapshots(containerId);
      setSnaps(res.snapshots);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load snapshots");
    }
  }, [containerId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="expandable-content">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>Snapshots</strong>
        <span>
          <input
            placeholder="snapshot name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: 160, marginRight: 6 }}
          />
          <button
            className="small primary"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                await api.createSnapshot(containerId, { name: name.trim() });
                setName("");
                await load();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : "Failed");
              }
            }}
          >
            Snapshot
          </button>
        </span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!snaps ? (
        <div className="muted">Loading…</div>
      ) : snaps.length === 0 ? (
        <div className="muted">No snapshots.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {snaps.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="muted">{(s.size_bytes / 1024).toFixed(0)} KB</td>
                <td className="muted">{new Date(s.created_at).toLocaleString()}</td>
                <td className="actions">
                  <button
                    className="small"
                    onClick={() => onAct(() => api.restoreSnapshot(containerId, s.id))}
                  >
                    Restore
                  </button>
                  <ConfirmButton
                    className="small danger"
                    message={`Delete snapshot "${s.name}"?`}
                    confirmLabel="Delete"
                    onConfirm={async () => {
                      await api.deleteSnapshot(containerId, s.id);
                      await load();
                    }}
                  >
                    Delete
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
