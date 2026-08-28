import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useConsoleLang } from "../i18n";
import { useAuth } from "../auth/AuthContext";

// Admin sees the global dashboard; regular users see their own scoped summary.
// Both shapes are normalized here so the rendering code is shared.
interface DashView {
  primaryCount: number;
  primaryLabel: string;
  running: number;
  failures24h: number;
  containersByStatus: Record<string, number>;
  meta: string;
}

export function Dashboard() {
  const { t } = useConsoleLang();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [view, setView] = useState<DashView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const v = isAdmin
          ? await loadAdmin()
          : await loadUser();
        if (!cancelled) {
          setView(v);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load dashboard");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAdmin]);

  if (loading && !view) return <div className="center-msg">Loading dashboard…</div>;
  if (error && !view) return <div className="error-banner">{error}</div>;
  if (!view) return null;

  const statusEntries = Object.entries(view.containersByStatus).filter(([, v]) => v > 0);

  return (
    <>
      <div className="page-header">
        <h1>{t("Dashboard")}</h1>
        <span className="muted">{view.meta}</span>
      </div>

      <div className="card-grid">
        <div className="stat-card">
          <div className="label">{view.primaryLabel}</div>
          <div className="value">{view.primaryCount}</div>
        </div>
        <div className="stat-card">
          <div className="label">Running containers</div>
          <div className="value">{view.running}</div>
        </div>
        <div className="stat-card">
          <div className="label">Failures (24h)</div>
          <div className={`value ${view.failures24h > 0 ? "danger" : ""}`}>{view.failures24h}</div>
        </div>
      </div>

      <div className="page-header">
        <h1 style={{ fontSize: 16 }}>{t("Containers by status")}</h1>
      </div>
      {statusEntries.length === 0 ? (
        <div className="center-msg">{t("No containers yet.")}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <tbody>
              {statusEntries.map(([status, count]) => (
                <tr key={status}>
                  <td style={{ width: 160 }}>
                    <span className={`badge ${status}`}>{t(status)}</span>
                  </td>
                  <td style={{ textAlign: "right", color: "var(--text)" }}>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

async function loadAdmin(): Promise<DashView> {
  const d = await api.dashboard();
  return {
    primaryCount: d.users,
    primaryLabel: "Users",
    running: d.runningContainers,
    failures24h: d.recentFailures24h,
    containersByStatus: d.containersByStatus,
    meta: `${d.executor} · ${d.dialect} · global view`,
  };
}

async function loadUser(): Promise<DashView> {
  const d = await api.meDashboard();
  return {
    primaryCount: d.myContainers,
    primaryLabel: "My containers",
    running: d.runningContainers,
    failures24h: d.recentFailures24h,
    containersByStatus: d.containersByStatus,
    meta: "your resources",
  };
}
