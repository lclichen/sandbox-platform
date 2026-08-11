import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Users } from "./pages/Users";
import { Quotas } from "./pages/Quotas";
import { Images } from "./pages/Images";
import { Containers } from "./pages/Containers";
import { Logs } from "./pages/Logs";
import { Workspaces } from "./pages/Workspaces";
import { LlmAdmin } from "./pages/LlmAdmin";
import { LlmKeys } from "./pages/LlmKeys";

/** Route guard: redirect to /login when not authenticated. */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, initializing } = useAuth();
  const location = useLocation();
  // While restoring the session, render nothing to avoid a login flash.
  if (initializing) return null;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

/** Route guard: admin-only. Non-admins are redirected to /. */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  const { user, initializing } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={user && !initializing ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route index element={<Dashboard />} />
                {/* admin-only */}
                <Route
                  path="users"
                  element={
                    <RequireAdmin>
                      <Users />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="quotas"
                  element={
                    <RequireAdmin>
                      <Quotas />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="llm-admin"
                  element={
                    <RequireAdmin>
                      <LlmAdmin />
                    </RequireAdmin>
                  }
                />
                {/* available to all authenticated users */}
                <Route path="images" element={<Images />} />
                <Route path="containers" element={<Containers />} />
                <Route path="workspaces" element={<Workspaces />} />
                <Route path="logs" element={<Logs />} />
                <Route path="llm" element={<LlmKeys />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
