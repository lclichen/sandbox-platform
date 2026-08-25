import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth, PasswordChangeRequiredError } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";

export function Login() {
  const { loginWithPassword, loginWithToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Redirect back to the originally-requested page after login.
  const dest = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/";

  const [tab, setTab] = useState<"password" | "token" | "register">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // R1: whether the deployment allows self-registration (drives the extra tab).
  const [registerMode, setRegisterMode] = useState<"off" | "open" | "approval">("off");
  // R9: login succeeded but the account owes a password change — collect the
  // new password before entering the console.
  const [needsPasswordChange, setNeedsPasswordChange] = useState(false);

  useEffect(() => {
    api
      .authConfig()
      .then((c) => setRegisterMode(c.registerMode))
      .catch(() => setRegisterMode("off"));
  }, []);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginWithPassword(username.trim(), password);
      navigate(dest, { replace: true });
    } catch (err) {
      if (err instanceof PasswordChangeRequiredError) {
        setNeedsPasswordChange(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Login failed");
      }
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

        {needsPasswordChange ? (
          <ForcePasswordChange
            username={username.trim()}
            currentPassword={password}
            onDone={async (newPassword) => {
              setNeedsPasswordChange(false);
              setPassword(newPassword);
              // change-password revoked all sessions; sign in again with the
              // new password and enter the console.
              try {
                await loginWithPassword(username.trim(), newPassword);
                navigate(dest, { replace: true });
              } catch {
                setTab("password");
              }
            }}
          />
        ) : (
          <>
            <div className="tabs">
              <button
                type="button"
                className={tab === "password" ? "active" : ""}
                onClick={() => setTab("password")}
              >
                Password
              </button>
              <button type="button" className={tab === "token" ? "active" : ""} onClick={() => setTab("token")}>
                Access token
              </button>
              {registerMode !== "off" && (
                <button type="button" className={tab === "register" ? "active" : ""} onClick={() => setTab("register")}>
                  Register
                </button>
              )}
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
            ) : tab === "token" ? (
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
            ) : null}

            {tab === "register" && registerMode !== "off" && (
              <RegisterForm
                mode={registerMode}
                onRegistered={() => {
                  // Keep the register tab mounted so its inline success notice
                  // stays visible; the user switches back to Password to sign in.
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** R9: shown when login succeeded but the account owes a password change. */
function ForcePasswordChange({
  username,
  currentPassword,
  onDone,
}: {
  username: string;
  currentPassword: string;
  onDone: (newPassword: string) => void | Promise<void>;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api.changeMyPassword(currentPassword, newPassword);
      await onDone(newPassword);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Password change failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p className="muted" style={{ marginTop: 0 }}>
        Welcome, {username}. This account must set a new password before continuing.
      </p>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-field">
        <label htmlFor="np">New password (min 8 chars)</label>
        <input
          id="np"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoFocus
          autoComplete="new-password"
        />
      </div>
      <div className="form-field">
        <label htmlFor="np2">Confirm new password</label>
        <input
          id="np2"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <button type="submit" className="primary" disabled={busy || newPassword.length < 8 || newPassword !== confirm} style={{ width: "100%" }}>
        {busy ? "Saving…" : "Set new password & sign in"}
      </button>
    </form>
  );
}

/** R1: self-registration form, only mounted when REGISTER_MODE != off. */
function RegisterForm({ mode, onRegistered }: { mode: "open" | "approval"; onRegistered: (msg: string | null) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.register({
        username: username.trim(),
        password,
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setSuccess(
        mode === "approval"
          ? "Registration received — an administrator must approve it before you can sign in."
          : "Account created — you can sign in now.",
      );
      onRegistered(res.message ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  if (success) {
    return (
      <div style={{ paddingTop: 12 }}>
        <p style={{ color: "var(--success, #4caf50)" }}>{success}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ paddingTop: 12 }}>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-field">
        <label htmlFor="ru">Username</label>
        <input id="ru" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      </div>
      <div className="form-field">
        <label htmlFor="rp">Password (min 8 chars)</label>
        <input
          id="rp"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div className="form-field">
        <label htmlFor="re">Email (optional)</label>
        <input id="re" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </div>
      <button type="submit" className="primary" disabled={busy || !username || password.length < 8} style={{ width: "100%" }}>
        {busy ? "Registering…" : mode === "approval" ? "Request account" : "Create account"}
      </button>
    </form>
  );
}
