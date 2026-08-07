/**
 * Workspaces page: persistent per-user file storage management.
 *
 * Each user manages their own workspaces (templates that seed a container's
 * /workspace on create). Admins see only their own here too (same per-user
 * semantics as containers), since workspaces are personal data, not a global
 * resource.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { WorkspaceRow } from "../api/types";
import { Modal, ModalActions } from "../components/Modal";
import { ConfirmButton } from "../components/ConfirmDialog";
import { WorkspaceFilesModal } from "../components/WorkspaceFilesModal";

interface Draft {
  name: string;
  description: string;
  isTemplate: boolean;
}

const EMPTY: Draft = {
  name: "",
  description: "",
  isTemplate: false,
};

function draftFromWorkspace(ws: WorkspaceRow): Draft {
  return {
    name: ws.name,
    description: ws.description ?? "",
    isTemplate: ws.is_template,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function Workspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ workspace?: WorkspaceRow; draft: Draft } | null>(null);
  const [browsing, setBrowsing] = useState<WorkspaceRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listWorkspaces();
      setWorkspaces(res.workspaces);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load workspaces");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-header">
        <h1>Workspaces</h1>
        <button className="primary" onClick={() => setEditing({ draft: { ...EMPTY } })}>
          + New workspace
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 12 }}>
        Persistent file storage that survives container destroy. Files here seed a new container&apos;s{" "}
        <code>/workspace</code> when you create one with this workspace.
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Size</th>
              <th>Files</th>
              <th>Template</th>
              <th>Updated</th>
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
            ) : workspaces.length === 0 ? (
              <tr>
                <td colSpan={7} className="center-msg">
                  No workspaces yet. Create one to seed your next container.
                </td>
              </tr>
            ) : (
              workspaces.map((ws) => (
                <tr key={ws.id}>
                  <td>{ws.name}</td>
                  <td className="muted">{ws.description || "—"}</td>
                  <td>{formatSize(ws.size_bytes)}</td>
                  <td>{ws.file_count}</td>
                  <td>{ws.is_template ? "yes" : "no"}</td>
                  <td className="muted">{new Date(ws.updated_at).toLocaleString()}</td>
                  <td className="actions">
                    <button className="small" onClick={() => setBrowsing(ws)}>
                      Files
                    </button>
                    <button className="small" onClick={() => setEditing({ workspace: ws, draft: draftFromWorkspace(ws) })}>
                      Edit
                    </button>
                    <ConfirmButton
                      className="small danger"
                      message={`Delete workspace "${ws.name}"? All its files will be removed. Containers already seeded are not affected.`}
                      confirmLabel="Delete"
                      onConfirm={async () => {
                        await api.deleteWorkspace(ws.id);
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
        <WorkspaceModal
          workspace={editing.workspace}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
      {browsing && <WorkspaceFilesModal workspace={browsing} onClose={() => setBrowsing(null)} />}
    </>
  );
}

function WorkspaceModal({
  workspace,
  initial,
  onClose,
  onSaved,
}: {
  workspace?: WorkspaceRow;
  initial: Draft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: draft.name,
        description: draft.description || undefined,
        isTemplate: draft.isTemplate,
      };
      if (workspace) {
        await api.updateWorkspace(workspace.id, payload);
      } else {
        await api.createWorkspace(payload);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });

  return (
    <Modal title={workspace ? `Edit ${workspace.name}` : "New workspace"} onClose={onClose}>
      <div className="form-field">
        <label>Name</label>
        <input value={draft.name} onChange={(e) => set("name", e.target.value)} autoFocus />
      </div>
      <div className="form-field">
        <label>Description</label>
        <input value={draft.description} onChange={(e) => set("description", e.target.value)} />
      </div>
      <div className="form-field">
        <label>Template</label>
        <select
          value={draft.isTemplate ? "yes" : "no"}
          onChange={(e) => set("isTemplate", e.target.value === "yes")}
        >
          <option value="no">no</option>
          <option value="yes">yes</option>
        </select>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Mark reusable base setups (e.g. a project skeleton) so you can find them quickly.
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ModalActions>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !draft.name.trim()} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </button>
      </ModalActions>
    </Modal>
  );
}
