import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { QuotaRow, UserPublic } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Modal, ModalActions } from "../components/Modal";
import { ConfirmButton } from "../components/ConfirmDialog";
import { StatusBadge } from "../components/StatusBadge";

const PAGE_SIZE = 20;

type StatusFilter = "" | "active" | "disabled" | "pending";

export function Users() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<UserPublic[]>([]);
  const [total, setTotal] = useState(0);
  const [quotas, setQuotas] = useState<QuotaRow[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserPublic | null>(null);
  const [pwUser, setPwUser] = useState<UserPublic | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, q] = await Promise.all([
        api.listUsers({
          limit: PAGE_SIZE,
          offset,
          search: search.trim(),
          ...(statusFilter ? { status: statusFilter } : {}),
        }),
        api.listQuotas(),
      ]);
      setUsers(u.users);
      setTotal(u.total);
      setQuotas(q.quotas);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [offset, search, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const quotaName = (id: number | null) => quotas.find((q) => q.id === id)?.name ?? "—";

  return (
    <>
      <div className="page-header">
        <h1>Users</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => void load()}>Refresh</button>
          <button onClick={() => setImporting(true)}>Import CSV</button>
          <button className="primary" onClick={() => setCreating(true)}>
            + New user
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="toolbar">
        <input
          placeholder="Search username or email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as StatusFilter);
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          <option value="active">active</option>
          <option value="pending">pending approval</option>
          <option value="disabled">disabled</option>
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Quota</th>
              <th>Status</th>
              <th>Last login</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="center-msg">
                  Loading…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={8} className="center-msg">
                  No users.
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id}>
                  <td className="muted">{u.id}</td>
                  <td>
                    {u.username}
                    {u.must_change_password && (
                      <span className="badge user" title="Must change password on next login" style={{ marginLeft: 6 }}>
                        pwd↻
                      </span>
                    )}
                  </td>
                  <td className="muted">{u.email ?? "—"}</td>
                  <td>
                    <span className={`badge ${u.role}`}>{u.role}</span>
                  </td>
                  <td className="muted">{quotaName(u.quota_id)}</td>
                  <td>
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="muted">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "—"}</td>
                  <td className="actions">
                    {u.status === "pending" ? (
                      <>
                        <button
                          className="small primary"
                          onClick={async () => {
                            try {
                              await api.approveUser(u.id);
                              await load();
                            } catch (e) {
                              setError(e instanceof ApiError ? e.message : "Failed");
                            }
                          }}
                        >
                          Approve
                        </button>
                        <ConfirmButton
                          className="small danger"
                          message={`Reject registration of "${u.username}"? The account will be deleted.`}
                          confirmLabel="Reject"
                          onConfirm={async () => {
                            await api.rejectUser(u.id);
                          }}
                          onSuccess={load}
                        >
                          Reject
                        </ConfirmButton>
                      </>
                    ) : (
                      <>
                        <button className="small" onClick={() => setEditing(u)}>
                          Edit
                        </button>
                        <button className="small" onClick={() => setPwUser(u)}>
                          Password
                        </button>
                        <button
                          className="small"
                          onClick={async () => {
                            try {
                              await api.updateUser(u.id, { status: u.status === "active" ? "disabled" : "active" });
                              await load();
                            } catch (e) {
                              setError(e instanceof ApiError ? e.message : "Failed");
                            }
                          }}
                        >
                          {u.status === "active" ? "Disable" : "Enable"}
                        </button>
                        <ConfirmButton
                          className="small danger"
                          message={`Delete user "${u.username}"? This cannot be undone.`}
                          confirmLabel="Delete"
                          disabled={u.id === currentUser?.id}
                          onConfirm={async () => {
                            await api.deleteUser(u.id);
                          }}
                          onSuccess={load}
                        >
                          Delete
                        </ConfirmButton>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span>
          {total} user{total === 1 ? "" : "s"}
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

      {creating && <CreateUserModal quotas={quotas} onClose={() => setCreating(false)} onSaved={load} />}
      {editing && <EditUserModal user={editing} quotas={quotas} onClose={() => setEditing(null)} onSaved={load} />}
      {pwUser && <PasswordModal user={pwUser} onClose={() => setPwUser(null)} />}
      {importing && <ImportUsersModal quotas={quotas} onClose={() => setImporting(false)} onSaved={load} />}
    </>
  );
}

function CreateUserModal({
  quotas,
  onClose,
  onSaved,
}: {
  quotas: QuotaRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [quotaId, setQuotaId] = useState<number | "">("");
  const [mustChange, setMustChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createUser({
        username,
        password,
        email: email || undefined,
        role,
        quota_id: quotaId === "" ? undefined : Number(quotaId),
        mustChangePassword: mustChange,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New user" onClose={onClose}>
      <div className="form-field">
        <label>Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      </div>
      <div className="form-field">
        <label>Password (min 8 chars)</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="form-field">
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="row-grid two">
        <div className="form-field">
          <label>Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div className="form-field">
          <label>Quota</label>
          <select value={quotaId} onChange={(e) => setQuotaId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">(inherit default)</option>
            {quotas.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-field">
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
          Require password change on first login
        </label>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ModalActions>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !username || password.length < 8} onClick={submit}>
          {busy ? "Creating…" : "Create user"}
        </button>
      </ModalActions>
    </Modal>
  );
}

function ImportUsersModal({
  quotas,
  onClose,
  onSaved,
}: {
  quotas: QuotaRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [quotaId, setQuotaId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; failed: number; results: Array<{ username: string; ok: boolean; error?: string }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = async (file: File | undefined) => {
    if (file) setCsv(await file.text());
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.importUsers({
        csv,
        mustChangePassword: mustChange,
        ...(quotaId === "" ? {} : { quota_id: Number(quotaId) }),
      });
      setResult(res);
      if (res.failed === 0) onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Import users (CSV)" onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>
        One account per line: <code>username,password[,email]</code>. A header line, blank lines, and
        <code> #</code> comments are skipped. Up to 500 rows.
      </p>
      <div className="form-field">
        <label>CSV file</label>
        <input ref={fileRef} type="file" accept=".csv,.txt" onChange={(e) => void pickFile(e.target.files?.[0])} />
      </div>
      <div className="form-field">
        <label>Or paste CSV</label>
        <textarea
          rows={6}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={"username,password,email\nalice,alicepass1,alice@example.com"}
        />
      </div>
      <div className="row-grid two">
        <div className="form-field">
          <label>Quota</label>
          <select value={quotaId} onChange={(e) => setQuotaId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">(platform default)</option>
            {quotas.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
            Require password change on first login
          </label>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {result && (
        <div style={{ maxHeight: 180, overflowY: "auto" }}>
          <div>
            Created {result.created}, failed {result.failed}:
          </div>
          {result.results
            .filter((r) => !r.ok)
            .map((r) => (
              <div key={r.username} className="muted">
                {r.username}: {r.error}
              </div>
            ))}
        </div>
      )}
      <ModalActions>
        <button onClick={onClose}>{result ? "Close" : "Cancel"}</button>
        <button className="primary" disabled={busy || !csv.trim()} onClick={submit}>
          {busy ? "Importing…" : "Import"}
        </button>
      </ModalActions>
    </Modal>
  );
}

function EditUserModal({
  user,
  quotas,
  onClose,
  onSaved,
}: {
  user: UserPublic;
  quotas: QuotaRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState(user.email ?? "");
  const [role, setRole] = useState<"user" | "admin">(user.role);
  const [quotaId, setQuotaId] = useState<number | null>(user.quota_id);
  const [status, setStatus] = useState<"active" | "disabled">(user.status === "pending" ? "disabled" : user.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(user.id, { email: email || undefined, role, quota_id: quotaId, status });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${user.username}`} onClose={onClose}>
      <div className="form-field">
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="row-grid two">
        <div className="form-field">
          <label>Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div className="form-field">
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as "active" | "disabled")}>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        </div>
      </div>
      <div className="form-field">
        <label>Quota</label>
        <select value={quotaId ?? ""} onChange={(e) => setQuotaId(e.target.value === "" ? null : Number(e.target.value))}>
          <option value="">(inherit default)</option>
          {quotas.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ModalActions>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </button>
      </ModalActions>
    </Modal>
  );
}

function PasswordModal({ user, onClose }: { user: UserPublic; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setUserPassword(user.id, password);
      setDone(true);
      setTimeout(onClose, 800);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Set password for ${user.username}`} onClose={onClose}>
      <div className="form-field">
        <label>New password (min 8 chars)</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </div>
      {error && <div className="error-banner">{error}</div>}
      {done && <div style={{ color: "var(--success)" }}>Password updated.</div>}
      <ModalActions>
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={busy || password.length < 8 || done} onClick={submit}>
          {busy ? "Saving…" : "Set password"}
        </button>
      </ModalActions>
    </Modal>
  );
}
