import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { ImageRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Modal, ModalActions } from "../components/Modal";
import { ConfirmButton } from "../components/ConfirmDialog";

interface Draft {
  name: string;
  display_name: string;
  sif_path: string;
  description: string;
  is_public: boolean;
  tags: string; // comma-separated in the form
  cpu: string;
  memoryMb: string;
  diskGb: string;
}

const EMPTY: Draft = {
  name: "",
  display_name: "",
  sif_path: "",
  description: "",
  is_public: true,
  tags: "",
  cpu: "1",
  memoryMb: "1024",
  diskGb: "5",
};

function draftFromImage(img: ImageRow): Draft {
  return {
    name: img.name,
    display_name: img.display_name,
    sif_path: img.sif_path,
    description: img.description ?? "",
    is_public: img.is_public,
    tags: (img.tags ?? []).join(", "),
    cpu: String(img.default_resources?.cpu ?? 1),
    memoryMb: String(img.default_resources?.memoryMb ?? 1024),
    diskGb: String(img.default_resources?.diskGb ?? 5),
  };
}

export function Images() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [images, setImages] = useState<ImageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ image?: ImageRow; draft: Draft } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Admin sees all images; regular users see only public ones.
      const res = isAdmin ? await api.listImages() : await api.publicImages();
      setImages(res.images);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load images");
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-header">
        <h1>Images</h1>
        {isAdmin && (
          <button className="primary" onClick={() => setEditing({ draft: { ...EMPTY } })}>
            + New image
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Display name</th>
              <th>SIF path</th>
              <th>Public</th>
              <th>Tags</th>
              <th>Default resources</th>
              {isAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={isAdmin ? 7 : 6} className="center-msg">
                  Loading…
                </td>
              </tr>
            ) : images.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 7 : 6} className="center-msg">
                  No images.
                </td>
              </tr>
            ) : (
              images.map((img) => (
                <tr key={img.id}>
                  <td>{img.name}</td>
                  <td>{img.display_name}</td>
                  <td className="muted" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {img.sif_path}
                  </td>
                  <td>{img.is_public ? "yes" : "no"}</td>
                  <td className="muted">{(img.tags ?? []).join(", ") || "—"}</td>
                  <td className="muted">
                    {img.default_resources
                      ? `${img.default_resources.cpu}cpu / ${img.default_resources.memoryMb}MB / ${img.default_resources.diskGb}GB`
                      : "—"}
                  </td>
                  {isAdmin && (
                    <td className="actions">
                      <button className="small" onClick={() => setEditing({ image: img, draft: draftFromImage(img) })}>
                        Edit
                      </button>
                      <ConfirmButton
                        className="small danger"
                        message={`Delete image "${img.name}"? Only allowed when no containers reference it.`}
                        confirmLabel="Delete"
                        onConfirm={async () => {
                          await api.deleteImage(img.id);
                        }}
                        onSuccess={load}
                      >
                        Delete
                      </ConfirmButton>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && <ImageModal image={editing.image} initial={editing.draft} onClose={() => setEditing(null)} onSaved={load} />}
    </>
  );
}

function ImageModal({
  image,
  initial,
  onClose,
  onSaved,
}: {
  image?: ImageRow;
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
      const tags = draft.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const payload = {
        name: draft.name,
        display_name: draft.display_name,
        sif_path: draft.sif_path,
        description: draft.description || undefined,
        is_public: draft.is_public,
        tags,
        default_resources: {
          cpu: Number(draft.cpu) || 1,
          memoryMb: Number(draft.memoryMb) || 1024,
          diskGb: Number(draft.diskGb) || 5,
        },
      };
      if (image) {
        await api.updateImage(image.id, payload);
      } else {
        await api.createImage(payload);
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
    <Modal title={image ? `Edit ${image.name}` : "New image"} onClose={onClose}>
      <div className="form-field">
        <label>Name</label>
        <input value={draft.name} onChange={(e) => set("name", e.target.value)} disabled={!!image} autoFocus />
      </div>
      <div className="form-field">
        <label>Display name</label>
        <input value={draft.display_name} onChange={(e) => set("display_name", e.target.value)} />
      </div>
      <div className="form-field">
        <label>SIF path</label>
        <input value={draft.sif_path} onChange={(e) => set("sif_path", e.target.value)} />
      </div>
      <div className="form-field">
        <label>Description</label>
        <input value={draft.description} onChange={(e) => set("description", e.target.value)} />
      </div>
      <div className="form-field">
        <label>Tags (comma-separated)</label>
        <input value={draft.tags} onChange={(e) => set("tags", e.target.value)} placeholder="linux, node, base" />
      </div>
      <div className="row-grid two">
        <div className="form-field">
          <label>Default CPU</label>
          <input type="number" min={1} value={draft.cpu} onChange={(e) => set("cpu", e.target.value)} />
        </div>
        <div className="form-field">
          <label>Default memory (MB)</label>
          <input type="number" min={128} value={draft.memoryMb} onChange={(e) => set("memoryMb", e.target.value)} />
        </div>
      </div>
      <div className="row-grid two">
        <div className="form-field">
          <label>Default disk (GB)</label>
          <input type="number" min={1} value={draft.diskGb} onChange={(e) => set("diskGb", e.target.value)} />
        </div>
        <div className="form-field">
          <label>Public</label>
          <select value={draft.is_public ? "yes" : "no"} onChange={(e) => set("is_public", e.target.value === "yes")}>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ModalActions>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !draft.name || !draft.sif_path} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </button>
      </ModalActions>
    </Modal>
  );
}
