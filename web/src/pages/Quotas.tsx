import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { ImageRow, QuotaRow } from "../api/types";
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
  max_workspaces_per_user: 10,
  allowed_image_ids: null,
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
        max_workspaces_per_user: q.max_workspaces_per_user,
        allowed_image_ids: q.allowed_image_ids,
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
              <th>Workspaces/user</th>
              <th>Image whitelist</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="center-msg">
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
                  <td>{q.max_workspaces_per_user}</td>
                  <td className="muted">{q.allowed_image_ids ? `${q.allowed_image_ids.length} images` : "all public"}</td>
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
  const [images, setImages] = useState<ImageRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listImages()
      .then((res) => setImages(res.images))
      .catch(() => setImages([]));
  }, []);

  const setNum = (key: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft({ ...draft, [key]: Number(e.target.value) || 0 });

  // R6: toggle an image id in the whitelist; unchecking everything except a
  // non-empty selection keeps null = "all public images".
  const toggleImage = (id: number, checked: boolean) => {
    const current = draft.allowed_image_ids ?? [];
    const next = checked ? [...current, id] : current.filter((x) => x !== id);
    setDraft({ ...draft, allowed_image_ids: next.length > 0 ? next : null });
  };

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
      <div className="form-field">
        <label>Max workspaces per user</label>
        <input
          type="number"
          min={0}
          value={draft.max_workspaces_per_user}
          onChange={setNum("max_workspaces_per_user")}
        />
      </div>
      <div className="form-field">
        <label>
          Allowed images (R6) — none checked = all public images; users on this quota can only create
          containers from checked images
        </label>
        <div style={{ maxHeight: 140, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
          {images.length === 0 ? (
            <span className="muted">No images defined.</span>
          ) : (
            images.map((img) => (
              <label key={img.id} style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={(draft.allowed_image_ids ?? []).includes(img.id)}
                  onChange={(e) => toggleImage(img.id, e.target.checked)}
                />
                {img.display_name} <span className="muted">({img.name})</span>
              </label>
            ))
          )}
        </div>
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
