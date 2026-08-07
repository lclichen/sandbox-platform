import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";

export function Login() {
  const { loginWithPassword, loginWithToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Redirect back to the originally-requested page after login.
  const dest = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/";

  const [tab, setTab] = useState<"password" | "token">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginWithPassword(username.trim(), password);
      navigate(dest, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const submitToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginWithToken(token.trim());
      navigate(dest, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Token validation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Sandbox Platform</h1>
        <p className="subtitle">Admin console</p>

        <div className="tabs">
          <button type="button" className={tab === "password" ? "active" : ""} onClick={() => setTab("password")}>
            Password
          </button>
          <button type="button" className={tab === "token" ? "active" : ""} onClick={() => setTab("token")}>
            Access token
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {tab === "password" ? (
          <form onSubmit={submitPassword}>
            <div className="form-field">
              <label htmlFor="u">Username</label>
              <input
                id="u"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
              />
            </div>
            <div className="form-field">
              <label htmlFor="p">Password</label>
              <input
                id="p"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <button type="submit" className="primary" disabled={busy || !username || !password} style={{ width: "100%" }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitToken}>
            <div className="form-field">
              <label htmlFor="t">Paste an access token (JWT)</label>
              <textarea
                id="t"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={4}
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                style={{ fontFamily: "monospace", fontSize: 11 }}
              />
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              Get one from a successful password login, or from the pi extension config.
            </p>
            <button type="submit" className="primary" disabled={busy || !token.trim()} style={{ width: "100%" }}>
              {busy ? "Validating…" : "Verify & sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
