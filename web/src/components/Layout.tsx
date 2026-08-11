import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiKeysModal } from "./ApiKeysModal";

// Pages visible to every authenticated user.
const COMMON_NAV: Array<{ to: string; label: string }> = [
  { to: "/", label: "Dashboard" },
  { to: "/containers", label: "Containers" },
  { to: "/workspaces", label: "Workspaces" },
  { to: "/images", label: "Images" },
  { to: "/logs", label: "Logs" },
  { to: "/llm", label: "LLM keys" },
];

// Admin-only management pages.
const ADMIN_NAV: Array<{ to: string; label: string }> = [
  { to: "/users", label: "Users" },
  { to: "/quotas", label: "Quotas" },
  { to: "/llm-admin", label: "LLM" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";
  const [showKeys, setShowKeys] = useState(false);

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
        <div className="brand">Sandbox Platform</div>
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
