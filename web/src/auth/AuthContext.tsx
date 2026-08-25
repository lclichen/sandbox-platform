/**
 * Authentication context.
 *
 * Tokens are persisted to localStorage so a page refresh keeps the session.
 * On mount, we validate the stored access token via /me; if it is expired the
 * client layer transparently refreshes once. This trades a small XSS exposure
 * (token readable by injected script) for a much better UX than re-login on
 * every refresh — acceptable for an internal admin console.
 */
import { createContext, useContext, useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import { api, setAccessToken, setRefreshToken, setOnAuthFailure, setOnTokensRefreshed } from "../api/client";

interface AuthUser {
  id: number;
  username: string;
  role: string;
}

/** Thrown when login succeeds but the account owes a first-login password
 *  change (R9); the Login page collects the new password before continuing. */
export class PasswordChangeRequiredError extends Error {
  constructor() {
    super("Password change required before using this account");
    this.name = "PasswordChangeRequiredError";
  }
}

interface AuthState {
  user: AuthUser | null;
  /** True until the initial session-restore /me check finishes. */
  initializing: boolean;
  loginWithPassword: (username: string, password: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const ACCESS_KEY = "sb_access_token";
const REFRESH_KEY = "sb_refresh_token";

function readStored(): { access?: string; refresh?: string } {
  try {
    return {
      access: localStorage.getItem(ACCESS_KEY) ?? undefined,
      refresh: localStorage.getItem(REFRESH_KEY) ?? undefined,
    };
  } catch {
    return {};
  }
}

function writeStored(access?: string, refresh?: string): void {
  try {
    if (access) localStorage.setItem(ACCESS_KEY, access);
    else localStorage.removeItem(ACCESS_KEY);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    // ignore (private mode etc.)
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  const logout = useCallback(() => {
    setUser(null);
    setAccessToken(undefined);
    setRefreshToken(undefined);
    writeStored(undefined, undefined);
  }, []);

  // Wire client callbacks once.
  useEffect(() => {
    setOnAuthFailure(() => logout());
    setOnTokensRefreshed((access, refresh) => {
      setAccessToken(access);
      setRefreshToken(refresh);
      writeStored(access, refresh);
    });
  }, [logout]);

  // Restore session on mount: if a token is stored, validate via /me.
  useEffect(() => {
    const { access, refresh } = readStored();
    if (!access) {
      setInitializing(false);
      return;
    }
    setAccessToken(access);
    setRefreshToken(refresh);
    api
      .me()
      .then((res) => setUser({ id: res.user.id, username: res.user.username, role: res.user.role }))
      .catch(() => {
        // /me failed even after a refresh attempt -> drop the session.
        logout();
      })
      .finally(() => setInitializing(false));
  }, [logout]);

  const loginWithPassword = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    if (res.user.must_change_password) {
      // Tokens ARE valid (change-password is reachable), but do not enter the
      // console until the new password is set (R9).
      setAccessToken(res.accessToken);
      setRefreshToken(res.refreshToken);
      writeStored(res.accessToken, res.refreshToken);
      throw new PasswordChangeRequiredError();
    }
    setAccessToken(res.accessToken);
    setRefreshToken(res.refreshToken);
    writeStored(res.accessToken, res.refreshToken);
    setUser({ id: res.user.id, username: res.user.username, role: res.user.role });
  }, []);

  const loginWithToken = useCallback(async (token: string) => {
    setAccessToken(token);
    const res = await api.me();
    setUser({ id: res.user.id, username: res.user.username, role: res.user.role });
    // A pasted access token has no paired refresh; don't persist it (refresh
    // wouldn't work), but keep it in memory for the session.
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, initializing, loginWithPassword, loginWithToken, logout }),
    [user, initializing, loginWithPassword, loginWithToken, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
