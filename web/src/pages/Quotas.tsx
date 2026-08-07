import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { QuotaRow } from "../api/types";
import { Modal, ModalActions } from "../components/Modal";
import { ConfirmButton } from "../components/ConfirmDialog";

const EMPTY: Omit<QuotaRow, "id" | "created_at" | "updated_at"> = {
  name: "",
  description: "",
  max_containers: 2,
  max_cpu_cores: 2,
  max_memory_mb: 2048,
  max_disk_gb: 10,
  max_snapshots_per_container: 5,
};

export function Quotas() {
  const [quotas, setQuotas] = useState<QuotaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ quota?: QuotaRow; draft: typeof EMPTY } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listQuotas();
      setQuotas(res.quotas);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load quotas");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startCreate = () => setEditing({ draft: { ...EMPTY } });
  const startEdit = (q: QuotaRow) =>
    setEditing({
      quota: q,
      draft: {
        name: q.name,
        description: q.description ?? "",
        max_containers: q.max_containers,
        max_cpu_cores: q.max_cpu_cores,
        max_memory_mb: q.max_memory_mb,
        max_disk_gb: q.max_disk_gb,
        max_snapshots_per_container: q.max_snapshots_per_container,
      },
    });

  return (
    <>
      <div className="page-header">
        <h1>Resource quotas</h1>
        <button className="primary" onClick={startCreate}>
          + New quota
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Containers</th>
              <th>CPU cores</th>
              <th>Memory</th>
              <th>Disk</th>
              <th>Snapshots/container</th>
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
            ) : (
              quotas.map((q) => (
                <tr key={q.id}>
                  <td>{q.name}</td>
                  <td>{q.max_containers}</td>
                  <td>{q.max_cpu_cores}</td>
                  <td>{q.max_memory_mb} MB</td>
                  <td>{q.max_disk_gb} GB</td>
                  <td>{q.max_snapshots_per_container}</td>
                  <td className="actions">
                    <button className="small" onClick={() => startEdit(q)}>
                      Edit
                    </button>
                    <ConfirmButton
                      className="small danger"
                      message={`Delete quota "${q.name}"? Only allowed when no users are assigned.`}
                      confirmLabel="Delete"
                      onConfirm={async () => {
                        await api.deleteQuota(q.id);
                      }}
                      onSuccess={load}
                    >
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <QuotaModal
          quota={editing.quota}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </>
  );
}

function QuotaModal({
  quota,
  initial,
  onClose,
  onSaved,
}: {
  quota?: QuotaRow;
  initial: typeof EMPTY;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({ ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setNum = (key: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft({ ...draft, [key]: Number(e.target.value) || 0 });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (quota) {
        await api.updateQuota(quota.id, draft);
      } else {
        await api.createQuota(draft);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={quota ? `Edit ${quota.name}` : "New quota"} onClose={onClose}>
      <div className="form-field">
        <label>Name</label>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          disabled={!!quota}
          autoFocus
        />
      </div>
      <div className="form-field">
        <label>Description</label>
        <input
          value={draft.description ?? ""}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>
      <div className="row-grid two">
        <div className="form-field">
          <label>Max containers</label>
          <input type="number" min={0} value={draft.max_containers} onChange={setNum("max_containers")} />
        </div>
        <div className="form-field">
          <label>Max CPU cores</label>
          <input type="number" min={0} value={draft.max_cpu_cores} onChange={setNum("max_cpu_cores")} />
        </div>
      </div>
      <div className="row-grid two">
        <div className="form-field">
          <label>Max memory (MB)</label>
          <input type="number" min={0} value={draft.max_memory_mb} onChange={setNum("max_memory_mb")} />
        </div>
        <div className="form-field">
          <label>Max disk (GB)</label>
          <input type="number" min={0} value={draft.max_disk_gb} onChange={setNum("max_disk_gb")} />
        </div>
      </div>
      <div className="form-field">
        <label>Max snapshots per container</label>
        <input
          type="number"
          min={0}
          value={draft.max_snapshots_per_container}
          onChange={setNum("max_snapshots_per_container")}
        />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ModalActions>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !draft.name} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </button>
      </ModalActions>
    </Modal>
  );
}
