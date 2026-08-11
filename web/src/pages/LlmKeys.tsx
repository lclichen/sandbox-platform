import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { LlmEndpoint, LlmModel, LlmMyStatus, LlmVirtualKey } from "../api/types";
import { ConfirmButton } from "../components/ConfirmDialog";

export function LlmKeys() {
  const [status, setStatus] = useState<LlmMyStatus | null>(null);
  const [keys, setKeys] = useState<LlmVirtualKey[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [endpoint, setEndpoint] = useState<LlmEndpoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, k, m, e] = await Promise.all([
        api.getMyLlmStatus(),
        api.listMyLlmKeys(),
        api.getMyLlmModels().catch(() => ({ models: [] })),
        api.getLlmEndpoint(),
      ]);
      setStatus(s);
      setKeys(k.keys);
      setModels(m.models);
      setEndpoint(e);
      setDisabled(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setDisabled(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to load LLM data");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (disabled) {
    return (
      <>
        <div className="page-header">
          <h1>LLM keys</h1>
        </div>
        <div className="error-banner">LLM integration is not enabled on this platform.</div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <div className="page-header">
          <h1>LLM keys</h1>
        </div>
        <p className="center-msg">Loading…</p>
      </>
    );
  }

  // Not granted access.
  if (!status?.binding) {
    return (
      <>
        <div className="page-header">
          <h1>LLM keys</h1>
        </div>
        <div className="info-banner">
          You have not been granted LLM access. Contact an administrator to request it.
        </div>
      </>
    );
  }

  const spend = status.litellm?.spend ?? 0;
  const budget = status.binding.max_budget;
  const pct = budget > 0 ? Math.min(100, (spend / budget) * 100) : 0;

  return (
    <>
      <div className="page-header">
        <h1>LLM keys</h1>
        <button className="small" onClick={load}>
          Refresh
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card-grid">
        <div className="card">
          <div className="card-label">Current spend</div>
          <div className="card-value">
            ${spend.toFixed(4)} <span className="muted">/ ${budget.toFixed(2)}</span>
          </div>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
          {status.binding.budget_duration && (
            <div className="muted">resets every {status.binding.budget_duration}</div>
          )}
        </div>
        <div className="card">
          <div className="card-label">Endpoint</div>
          <div className="card-value mono">
            <code>{endpoint?.baseUrl ?? "—"}</code>
          </div>
          <div className="muted small">{endpoint?.instructions}</div>
        </div>
        <div className="card">
          <div className="card-label">Allowed models</div>
          <div className="card-value">
            {status.binding.models ? status.binding.models.join(", ") : "all"}
          </div>
          <div className="muted small">{models.length} models available via LiteLLM</div>
        </div>
      </div>

      <div className="page-header" style={{ marginTop: 24 }}>
        <h2>My virtual keys</h2>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Budget</th>
              <th>Models</th>
              <th>Created</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={7} className="center-msg">
                  No keys. Ask an administrator to issue one.
                </td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>
                    <code className="muted">{k.key_prefix}…</code>
                  </td>
                  <td>{k.max_budget != null ? `$${k.max_budget.toFixed(2)}` : "—"}</td>
                  <td>{k.models ? k.models.join(", ") : "all"}</td>
                  <td>{new Date(k.created_at).toLocaleString()}</td>
                  <td>{k.revoked_at ? "revoked" : "active"}</td>
                  <td className="actions">
                    {k.revoked_at ? (
                      <button className="small" disabled title="Revoked">
                        Reveal
                      </button>
                    ) : (
                      <RevealButton id={k.id} name={k.name} />
                    )}
                    {!k.revoked_at && (
                      <ConfirmButton
                        className="small danger"
                        message={`Revoke key "${k.name}"? Any client using it will stop working immediately.`}
                        confirmLabel="Revoke"
                        onConfirm={async () => {
                          await api.revokeMyLlmKey(k.id);
                        }}
                        onSuccess={load}
                      >
                        Revoke
                      </ConfirmButton>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RevealButton({ id, name }: { id: number; name: string }) {
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.revealMyLlmKey(id);
      setPlaintext(res.plaintext);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to reveal key");
    } finally {
      setBusy(false);
    }
  };

  if (plaintext) {
    return (
      <div className="reveal-inline">
        <div className="reveal-pop">
          <div className="muted small">{name} — copy now, won&apos;t be cached:</div>
          <pre className="key-reveal">{plaintext}</pre>
          <button className="small" onClick={() => setPlaintext(null)}>
            Close
          </button>
        </div>
        <button className="small" onClick={() => setPlaintext(null)}>
          Hide
        </button>
      </div>
    );
  }

  return (
    <>
      <button className="small" disabled={busy} onClick={reveal}>
        {busy ? "…" : "Reveal"}
      </button>
      {error && <span className="muted small error">{error}</span>}
    </>
  );
}
