import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiKeysModal } from "./ApiKeysModal";

// Pages visible to every authenticated user.
const COMMON_NAV: Array<{ to: string; label: string }> = [
  { to: "/", label: "总览 Dashboard" },
  { to: "/containers", label: "容器 Containers" },
  { to: "/workspaces", label: "云盘 Workspaces" },
  { to: "/images", label: "镜像 Images" },
  { to: "/logs", label: "日志 Logs" },
  { to: "/llm", label: "LLM 密钥" },
];

// Admin-only management pages.
const ADMIN_NAV: Array<{ to: string; label: string }> = [
  { to: "/users", label: "用户 Users" },
  { to: "/quotas", label: "配额 Quotas" },
  { to: "/llm-admin", label: "LLM 管理" },
];

type Theme = "dark" | "light";

function initialTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const [showKeys, setShowKeys] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("amedac-console-theme", theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  const renderItem = (item: { to: string; label: string }) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) => (isActive ? "active" : "")}
    >
      {item.label}
    </NavLink>
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <svg className="brand-logo" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#2563eb" />
            <path d="M16 8 4 14l12 6 12-6z" fill="#fff" />
            <path d="M10 17.2V22c0 1.8 2.7 3.2 6 3.2s6-1.4 6-3.2v-4.8l-6 3z" fill="#fff" opacity=".85" />
          </svg>
          <div>
            <div className="brand-name">amedac.ai</div>
            <div className="brand-sub">沙盒管理台</div>
          </div>
        </div>
        <nav>
          {COMMON_NAV.map(renderItem)}
          {isAdmin && (
            <>
              <div
                style={{
                  padding: "12px 18px 4px",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: "var(--text-dim)",
                }}
              >
                Administration
              </div>
              {ADMIN_NAV.map(renderItem)}
            </>
          )}
        </nav>
        <div className="theme-toggle-row">
          <button className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "☀ 切换日间模式" : "☾ 切换夜间模式"}
          </button>
        </div>
        {user && (
          <div className="user-box">
            <div className="name">{user.username}</div>
            <div className="role">{user.role}</div>
            <button className="small" onClick={() => setShowKeys(true)} style={{ marginTop: 8, width: "100%" }}>
              My API keys
            </button>
            <button className="small" onClick={handleLogout} style={{ marginTop: 6, width: "100%" }}>
              Log out
            </button>
          </div>
        )}
      </aside>
      <main className="main">{children}</main>
      {showKeys && <ApiKeysModal onClose={() => setShowKeys(false)} />}
    </div>
  );
}
