import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { LlmBinding, LlmModel, LlmSpendEntry, UserPublic } from "../api/types";
import { Modal, ModalActions } from "../components/Modal";
import { ConfirmButton } from "../components/ConfirmDialog";

type Tab = "bindings" | "models";

export function LlmAdmin() {
  const [tab, setTab] = useState<Tab>("bindings");
  const [bindings, setBindings] = useState<LlmBinding[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [granting, setGranting] = useState(false);

  const loadBindings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listLlmBindings();
      setBindings(res.bindings);
      setDisabled(false);
    } catch (err) {
      // 501 LLM_NOT_ENABLED is the expected state when LiteLLM is off.
      if (err instanceof ApiError && err.status === 501) {
        setDisabled(true);
        setBindings([]);
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to load LLM bindings");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const res = await api.listLlmModels();
      setModels(res.models);
    } catch {
      // Models are best-effort; the bindings tab is the source of truth.
    }
  }, []);

  useEffect(() => {
    void loadBindings();
    void loadModels();
  }, [loadBindings, loadModels]);

  if (disabled) {
    return (
      <>
        <div className="page-header">
          <h1>LLM</h1>
        </div>
        <div className="error-banner">
          LLM integration is not enabled on this platform. Set <code>LLM_ENABLED=true</code> and configure{" "}
          <code>LITELLM_MASTER_KEY</code> / <code>LLM_ENCRYPTION_KEY</code> to enable.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1>LLM</h1>
        {tab === "bindings" && (
          <button className="primary" onClick={() => setGranting(true)}>
            + Grant access
          </button>
        )}
      </div>

      <div className="tabs">
        <button className={tab === "bindings" ? "active" : ""} onClick={() => setTab("bindings")}>
          Access bindings
        </button>
        <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>
          Models
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {tab === "bindings" ? (
        <BindingsTable bindings={bindings} loading={loading} onChanged={loadBindings} />
      ) : (
        <ModelsTable models={models} />
      )}

      {granting && <GrantModal onClose={() => setGranting(false)} onSaved={loadBindings} />}
    </>
  );
}

function BindingsTable({
  bindings,
  loading,
  onChanged,
}: {
  bindings: LlmBinding[];
  loading: boolean;
  onChanged: () => void;
}) {
  if (loading) {
    return (
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td className="center-msg">Loading…</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>LiteLLM user</th>
            <th>Budget (USD)</th>
            <th>Window</th>
            <th>Models</th>
            <th>Granted</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {bindings.length === 0 ? (
            <tr>
              <td colSpan={8} className="center-msg">
                No users have been granted LLM access yet.
              </td>
            </tr>
          ) : (
            bindings.map((b) => (
              <tr key={b.id}>
                <td>{b.username}</td>
                <td>
                  <code className="muted">{b.litellm_user_id}</code>
                </td>
                <td>${b.max_budget.toFixed(2)}</td>
                <td>{b.budget_duration ?? "—"}</td>
                <td>{b.models ? b.models.join(", ") : "all"}</td>
                <td>{new Date(b.granted_at).toLocaleString()}</td>
                <td>{b.revoked_at ? "revoked" : "active"}</td>
                <td className="actions">
                  <EditBudgetButton binding={b} onSaved={onChanged} />
                  <ConfirmButton
                    className="small danger"
                    message={`Revoke LLM access for ${b.username}? This deletes their LiteLLM user and all their keys.`}
                    confirmLabel="Revoke"
                    onConfirm={async () => {
                      await api.revokeLlmAccess(b.platform_user_id);
                    }}
                    onSuccess={onChanged}
                  >
                    Revoke
                  </ConfirmButton>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ModelsTable({ models }: { models: LlmModel[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Model id</th>
            <th>Owned by</th>
          </tr>
        </thead>
        <tbody>
          {models.length === 0 ? (
            <tr>
              <td colSpan={2} className="center-msg">
                No models available (LiteLLM may be unreachable).
              </td>
            </tr>
          ) : (
            models.map((m) => (
              <tr key={m.id}>
                <td>
                  <code>{m.id}</code>
                </td>
                <td>{m.owned_by ?? "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function GrantModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [users, setUsers] = useState<UserPublic[]>([]);
  const [userId, setUserId] = useState<number | "">("");
  const [maxBudget, setMaxBudget] = useState("10");
  const [budgetDuration, setBudgetDuration] = useState("1d");
  const [modelsStr, setModelsStr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState<{ id: number; plaintext: string; username: string } | null>(null);

  useEffect(() => {
    api
      .listUsers({ limit: 200 })
      .then((res) => setUsers(res.users.filter((u) => u.status === "active")))
      .catch(() => {
        /* best-effort */
      });
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const models = modelsStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.grantLlmAccess({
        platformUserId: Number(userId),
        maxBudget: Number(maxBudget) || 0,
        budgetDuration: budgetDuration || null,
        models: models.length > 0 ? models : null,
      });
      setIssuedKey({ id: res.key.id, plaintext: res.key.plaintext, username: res.binding.username });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to grant access");
    } finally {
      setBusy(false);
    }
  };

  if (issuedKey) {
    return (
      <Modal title="LLM access granted" onClose={onClose}>
        <p>
          Initial virtual key for <strong>{issuedKey.username}</strong>. Copy it now — the platform will not show it in
          full again.
        </p>
        <pre className="key-reveal">{issuedKey.plaintext}</pre>
        <ModalActions>
          <button className="primary" onClick={onSaved}>
            Done
          </button>
        </ModalActions>
      </Modal>
    );
  }

  return (
    <Modal title="Grant LLM access" onClose={onClose}>
      <div className="form-field">
        <label>Platform user</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Select user…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username} ({u.role})
            </option>
          ))}
        </select>
      </div>
      <div className="row-grid two">
        <div className="form-field">
          <label>Max budget (USD)</label>
          <input type="number" min={0} step="0.01" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Budget window</label>
          <input value={budgetDuration} onChange={(e) => setBudgetDuration(e.target.value)} placeholder="1d, 7d, 30d…" />
        </div>
      </div>
      <div className="form-field">
        <label>Allowed models (comma-separated, blank = all)</label>
        <input value={modelsStr} onChange={(e) => setModelsStr(e.target.value)} placeholder="gpt-4o, claude-sonnet" />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ModalActions>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || userId === ""} onClick={submit}>
          {busy ? "Granting…" : "Grant"}
        </button>
      </ModalActions>
    </Modal>
  );
}

function EditBudgetButton({ binding, onSaved }: { binding: LlmBinding; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="small" onClick={() => setOpen(true)}>
        Edit
      </button>
      {open && <EditBudgetModal binding={binding} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

function EditBudgetModal({
  binding,
  onClose,
  onSaved,
}: {
  binding: LlmBinding;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [maxBudget, setMaxBudget] = useState(String(binding.max_budget));
  const [budgetDuration, setBudgetDuration] = useState(binding.budget_duration ?? "");
  const [modelsStr, setModelsStr] = useState((binding.models ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const models = modelsStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await api.updateLlmBudget(binding.platform_user_id, {
        maxBudget: Number(maxBudget) || 0,
        budgetDuration: budgetDuration || null,
        models,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit budget — ${binding.username}`} onClose={onClose}>
      <div className="row-grid two">
        <div className="form-field">
          <label>Max budget (USD)</label>
          <input type="number" min={0} step="0.01" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Budget window</label>
          <input value={budgetDuration} onChange={(e) => setBudgetDuration(e.target.value)} placeholder="1d, 7d, 30d…" />
        </div>
      </div>
      <div className="form-field">
        <label>Allowed models (comma-separated, blank = all)</label>
        <input value={modelsStr} onChange={(e) => setModelsStr(e.target.value)} />
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
