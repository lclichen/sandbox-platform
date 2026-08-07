/**
 * Workspace file browser modal.
 *
 * A path-style (not tree) browser for a single workspace's files. Supports:
 *   - navigation via breadcrumbs and clicking directories
 *   - uploading a file (octet-stream) into the current directory
 *   - downloading a file
 *   - deleting a file or directory
 *   - creating a subdirectory
 *
 * No online editing (kept the project's minimal-dependency invariant).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { WorkspaceFileEntry, WorkspaceRow } from "../api/types";
import { Modal } from "./Modal";
import { ConfirmButton } from "./ConfirmDialog";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Split a workspace-relative path into breadcrumb segments. */
function breadcrumbs(path: string): Array<{ label: string; path: string }> {
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean === "") return [{ label: "/", path: "/" }];
  const parts = clean.split("/");
  const crumbs = [{ label: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    crumbs.push({ label: p, path: acc });
  }
  return crumbs;
}

export function WorkspaceFilesModal({
  workspace,
  onClose,
}: {
  workspace: WorkspaceRow;
  onClose: () => void;
}) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listWorkspaceFiles(workspace.id, path);
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to list files");
    } finally {
      setLoading(false);
    }
  }, [workspace.id, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const onUpload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      await api.uploadWorkspaceFile(workspace.id, path, file.name, buf);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const onDownload = async (entry: WorkspaceFileEntry) => {
    setError(null);
    try {
      const blob = await api.downloadWorkspaceFile(workspace.id, entry.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Download failed");
    }
  };

  const onMakeDir = async () => {
    // Lightweight prompt — no UI library in this project.
    const name = window.prompt("New folder name:");
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const rel = path === "/" ? name : `${path.replace(/\/+$/, "")}/${name}`;
      await api.makeWorkspaceDir(workspace.id, rel);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create folder");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Files · ${workspace.name}`} onClose={onClose}>
      <div className="ws-breadcrumbs">
        {breadcrumbs(path).map((c, i, arr) => (
          <span key={c.path}>
            <a
              onClick={() => setPath(c.path)}
              style={{
                cursor: "pointer",
                fontWeight: i === arr.length - 1 ? 600 : 400,
                color: "var(--accent, #4aa3df)",
              }}
            >
              {c.label}
            </a>
            {i < arr.length - 1 ? " / " : ""}
          </span>
        ))}
      </div>

      <div className="ws-toolbar">
        <button className="small" disabled={busy} onClick={onMakeDir}>
          + Folder
        </button>
        <button className="small primary" disabled={busy} onClick={() => fileInput.current?.click()}>
          ↑ Upload
        </button>
        <input
          ref={fileInput}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
            e.target.value = "";
          }}
        />
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="ws-file-list">
        {loading ? (
          <div className="center-msg">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="center-msg">Empty.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.path}>
                  <td>
                    {e.isDir ? (
                      <a
                        onClick={() => setPath(e.path)}
                        style={{ cursor: "pointer", color: "var(--accent, #4aa3df)" }}
                      >
                        📁 {e.name}
                      </a>
                    ) : (
                      <span>📄 {e.name}</span>
                    )}
                  </td>
                  <td className="muted">{e.isDir ? "—" : formatSize(e.size)}</td>
                  <td className="muted">{new Date(e.mtime).toLocaleString()}</td>
                  <td className="actions">
                    {!e.isDir && (
                      <button className="small" onClick={() => void onDownload(e)}>
                        Download
                      </button>
                    )}
                    <ConfirmButton
                      className="small danger"
                      message={`Delete "${e.name}"?${e.isDir ? " This removes the folder and everything inside." : ""}`}
                      confirmLabel="Delete"
                      onConfirm={async () => {
                        await api.deleteWorkspaceFile(workspace.id, e.path);
                      }}
                      onSuccess={load}
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
    </Modal>
  );
}
