# sandbox-platform

A centralized, cloud-native sandbox management platform built around
[Apptainer](https://apptainer.org) (Singularity). It provisions per-user
development containers with persistent overlay layers, exposes a REST API for
the `pi-sandbox-extension` to route coding-agent tool calls into those
containers, and provides admin controls for users, quotas, images, and audit
logs.

This implements the architecture described in
`../Apptainer驱动的云原生沙盒：从架构设计到企业级部署的实践蓝图.md`:
control plane (Express + services), execution plane (pluggable
`SandboxExecutor`), and infrastructure (sqlite3 / postgresql backing store with
backup and migration tooling).

## Features

- **Dual database backends** — sqlite3 (development / small deployments) and
  postgresql (production), behind one abstraction. One schema, one set of
  migrations, both dialects.
- **Pluggable executors** — `MockExecutor` (local-filesystem stand-in, works on
  win32), `SshExecutor` (preferred production path), and `ApptainerCliExecutor`
  (fallback when SSH is unavailable). Selectable via config with automatic
  fallback.
- **Field recovery** — "pseudo-snapshots" by copying the persistent overlay, as
  recommended in the architecture blueprint. Stop -> snapshot overlay ->
  destroy -> restore from snapshot.
- **Admin surface** — users, resource quotas, image catalogue, operation audit
  logs, and a dashboard summary.
- **Tool relay** — `POST /api/v1/containers/:id/tools/{read,write,edit,bash,...}`
  endpoints that the `pi-sandbox-extension` calls to run pi's built-in tools
  inside a container.
- **Web admin console** — a React SPA (`web/`) served by the platform at the
  same origin; see `web/README.md`. Covers dashboard, users, quotas, images,
  containers, workspaces, logs, and LLM management.
- **LLM gateway integration (optional)** — when `LLM_ENABLED=true`, manages
  LiteLLM proxy users/virtual-keys/budgets and exposes spend reporting. See
  `litellm/README.md`.
- **Backup & cross-database migration** — portable JSON archives; copy data
  between sqlite and postgresql in either direction.

## Quick start (sqlite + Mock executor)

```bash
npm install --ignore-scripts
cp .env.example .env            # adjust JWT_SECRET
npm run migrate                 # creates schema + seeds admin/quotas/images
npm start                       # listens on http://0.0.0.0:3000
```

Smoke test:

```bash
curl -s http://localhost:3000/health
# {"status":"ok","dialect":"sqlite","executor":"mock"}

curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme123"}'   # -> { accessToken, refreshToken, user }
```

## Production (postgresql + real executor)

```bash
export DB_DIALECT=postgresql
export DATABASE_URL=postgresql://user:pass@db:5432/sandbox_platform
export EXECUTOR_KIND=ssh
export SSH_HOST=compute-node.corp.com
export SSH_USERNAME=apptainer
export SSH_PRIVATE_KEY_PATH=/etc/sandbox/ssh_key
export JWT_SECRET=$(openssl rand -hex 32)
npm run migrate && npm start
```

Switching executors requires only changing `EXECUTOR_KIND`; the factory probes
availability and falls back (`ssh -> apptainer-cli -> mock`) so a misconfigured
host never hard-fails.

## Database backup & migration

```bash
# Backup current DB to backups/backup-<timestamp>.json (portable archive).
npm run backup

# Restore an archive into the configured DB (schema must exist).
npm run restore -- --in backups/backup-....json

# Copy data from one DB to another (sqlite <-> postgresql, either direction).
npm run migrate-db -- \
  --from sqlite:./data/sandbox.db \
  --to "postgresql://user:pass@host:5432/sandbox_platform"
```

The archive format decodes JSON columns to logical values on read and re-encodes
for the target dialect on write, so a backup taken on sqlite restores cleanly
into postgresql.

## API overview

All routes under `/api/v1`. Bearer token auth via `POST /auth/login`, or a
long-lived API key (`sk_...`) via `X-API-Key` / `Authorization: Bearer`.

| Area | Endpoint | Who |
|------|----------|-----|
| Auth | `POST /auth/login` `/refresh` `/logout`, `GET /auth/me`, CRUD `/auth/api-keys` | any |
| Containers | `POST/GET /containers`, `/:id/start\|stop\|connect`, `DELETE /:id` | owner |
| Snapshots | `POST/GET /containers/:id/snapshots`, `/:sid/restore`, `DELETE /:sid` | owner |
| Tools | `POST /containers/:id/tools/{read,write,edit,bash,grep,find}`, `GET .../{access,stat,ls}`, `GET .../bash/stream` (SSE) | owner |
| Workspaces | `GET/POST/PATCH/DELETE /workspaces`, `GET/POST/DELETE /:id/files`, `GET /:id/files/content`, `POST /:id/dirs` | owner |
| Images | `GET /images` (public) | any |
| Logs | `GET /logs` (own only) | owner |
| LLM (self) | `GET /llm/me`, `GET/DELETE /llm/me/keys/:id`, `POST /llm/me/keys/:id/reveal`, `GET /llm/me/usage\|endpoint\|models` | owner |
| Admin users | `GET/POST/PATCH/DELETE /admin/users`, `POST /:id/password` | admin |
| Admin quotas | `GET/POST/PATCH/DELETE /admin/quotas` | admin |
| Admin images | `GET/POST/PATCH/DELETE /admin/images` | admin |
| Admin containers | `GET /admin/containers`, `GET /admin/dashboard` | admin |
| Admin logs | `GET /admin/logs` (filters: userId, action, resourceType, resourceId, status) | admin |
| Admin LLM | `GET/POST/PATCH/DELETE /admin/llm/bindings`, `GET /admin/llm/bindings/:userId/usage`, `GET /admin/llm/keys\|models` | admin |
| Ops | `GET /health`, `GET /ready`, `GET /metrics` (Prometheus) | any |

LLM routes return `503 llm_not_enabled` when `LLM_ENABLED=false`.

Request bodies are validated with zod; errors return
`{ code, message, details? }` with appropriate HTTP status.

## Project layout

```
src/
  config.ts              env-driven configuration
  app.ts                 Express assembly + error handler
  index.ts               HTTP server entry (runs migrations on startup)
  db/                    driver.ts (sqlite+pg abstraction), migrate.ts, migrations/
  auth/                  jwt.ts, password.ts, middleware.ts (requireAuth/requireAdmin)
  executors/             types.ts, mock/ssh/apptainer-cli executors, factory.ts
  services/              user/quota/image/container/snapshot/log/tools services
  routes/                routers + audit middleware + zod schemas
scripts/                 migrate.ts, backup.ts, restore.ts, migrate-db.ts
litellm/                 LiteLLM proxy deployment (docker-compose, config.yaml)
test/                    vitest E2E (170+ tests, MockExecutor-backed)
```

## Testing

```bash
npm test    # 170+ tests, fully offline, win32-compatible (Mock executor)
```

Tests cover: auth + RBAC, user/quota/image CRUD, MockExecutor lifecycle,
container lifecycle + snapshots + ownership isolation + quota enforcement, tool
relay (read/write/edit/bash/ls/grep/find), audit logging + dashboard, and
backup/restore/migrate round-trips. The postgres driver is exercised at type
level; live pg verification is a deployment-time step.

## Notes & limitations (MVP)

- Single execution node; the executor abstraction leaves room for a scheduler.
- Auth is built-in JWT (refresh rotation). Keycloak/LDAP/SCIM integration is
  out of scope but the auth layer is the integration point.
- LLM integration is optional and off by default; enabling it requires a
  separate LiteLLM proxy deployment (see `litellm/`).
- The `bash` tool relay returns buffered output; a low-latency SSE stream
  endpoint (`/tools/bash/stream`) exists for terminal-style clients.
