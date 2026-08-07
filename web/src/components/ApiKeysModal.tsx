import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { Modal, ModalActions } from "./Modal";
import { ConfirmButton } from "./ConfirmDialog";

interface KeyRow {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Self-service API key management for the current user. */
export function ApiKeysModal({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.listMyApiKeys();
      setKeys(res.apiKeys);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load keys");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createMyApiKey(newName.trim() || "key");
      setCreated({ key: res.key, name: newName.trim() || "key" });
      setNewName("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to create key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="My API keys" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Long-lived credentials for CLI / automation. The full key is shown only once at creation.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {/* Newly created key — show once with copy hint */}
      {created && (
        <div
          style={{
            background: "rgba(74,222,128,0.1)",
            border: "1px solid var(--success)",
            borderRadius: 6,
            padding: 10,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: 4 }}>Key created — copy it now:</div>
          <code
            style={{
              display: "block",
              fontSize: 11,
              wordBreak: "break-all",
              background: "var(--bg)",
              padding: 6,
              borderRadius: 4,
              userSelect: "all",
            }}
          >
            {created.key}
          </code>
          <button className="small" style={{ marginTop: 6 }} onClick={() => setCreated(null)}>
            I&apos;ve copied it
          </button>
        </div>
      )}

      {/* Create form */}
      <div className="row-grid" style={{ gridTemplateColumns: "1fr auto", alignItems: "end", marginBottom: 12 }}>
        <div className="form-field" style={{ margin: 0 }}>
          <label>New key name</label>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-ci-key" />
        </div>
        <button className="primary" disabled={busy} onClick={create}>
          {busy ? "…" : "Create"}
        </button>
      </div>

      {/* List */}
      {!keys ? (
        <div className="muted">Loading…</div>
      ) : keys.length === 0 ? (
        <div className="muted">No API keys yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Name</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>
                  <code style={{ fontSize: 12 }}>{k.key_prefix}…</code>
                </td>
                <td>{k.name}</td>
                <td className="muted">{new Date(k.created_at).toLocaleDateString()}</td>
                <td className="muted">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}</td>
                <td>
                  {k.revoked_at ? (
                    <span className="muted">revoked</span>
                  ) : (
                    <ConfirmButton
                      className="small danger"
                      message={`Revoke key "${k.name}" (${k.key_prefix}…)? It stops working immediately.`}
                      confirmLabel="Revoke"
                      onConfirm={async () => {
                        await api.revokeMyApiKey(k.id);
                      }}
                      onSuccess={load}
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ModalActions>
        <button onClick={onClose}>Close</button>
      </ModalActions>
    </Modal>
  );
}
