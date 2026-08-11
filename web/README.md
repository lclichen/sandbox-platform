# sandbox-platform-web

React SPA admin console for the sandbox platform. Build output is served by the
platform itself (`express.static('web/dist')` + SPA fallback), so a single
`npm start` of the platform exposes both the API and the UI on the same origin
— no CORS, no separate web server.

## Develop

```bash
# Terminal 1: run the platform backend on :3000
cd sandbox-platform
npm run migrate && npm start

# Terminal 2: run the SPA dev server on :5173 (proxies /api -> :3000)
cd sandbox-platform/web
npm install
npm run dev
```

Open http://localhost:5173. Hot reload is enabled; API calls are proxied to the
backend so cookies/fetch work without CORS.

## Build for production

```bash
cd sandbox-platform/web
npm run build      # outputs to web/dist/
```

Then start the platform from the parent directory — it auto-detects `web/dist`
and serves it:

```bash
cd sandbox-platform
npm start          # UI at http://localhost:3000, API at /api/v1/*
```

If `web/dist` is absent, the platform still runs API-only and non-API GETs
return a hint to build the UI.

## Authentication

- **Password tab**: username + password against `POST /api/v1/auth/login`.
- **Access token tab**: paste a JWT (e.g. copied from a CLI login or the
  pi-sandbox-extension config); validated via `GET /api/v1/auth/me`.

Tokens are persisted to `localStorage` so a page refresh keeps the session
(see `src/auth/AuthContext.tsx`). This is a deliberate trade-off favoring UX
over XSS hardening for an internal admin console; production deployments
should add a strict CSP (the platform already sets one via Helmet). On a 401
the client silently refreshes once using the cached refresh token; if that
fails it clears the tokens and redirects to the login screen.

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Dashboard — counts, container-status breakdown, 30s auto-refresh |
| `/users` | User CRUD, password reset, enable/disable, quota assignment (admin) |
| `/quotas` | Resource quota tier CRUD (admin) |
| `/images` | Base image catalogue CRUD (tags, default resources) |
| `/containers` | All containers (admin view); start/stop/destroy; expandable snapshots with restore/delete |
| `/workspaces` | Persistent per-user workspaces; file browser, upload/download, sync seed source |
| `/logs` | Operation audit log with multi-field filters and pagination |
| `/llm-admin` | LLM (LiteLLM) access bindings, budgets, model catalogue (admin) |
| `/llm` | Personal LLM virtual keys: spend, reveal/revoke, direct endpoint (any user) |

## Tech

- Vite 5 + React 18 + TypeScript (strict)
- react-router-dom 6 (client routing + auth guard)
- No UI framework, no state library — self-contained components and a single
  global stylesheet keep the bundle small (~62 KB gzipped JS).
