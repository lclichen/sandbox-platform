# LiteLLM Proxy (AI Gateway) for AgentSandbox

This directory deploys a [LiteLLM proxy](https://docs.litellm.ai/) that the
AgentSandbox platform integrates with to provide:

- **User mapping** — each platform user granted LLM access gets a matching
  LiteLLM user with a USD budget.
- **Virtual-key management** — the platform issues per-user LiteLLM virtual
  keys (stored reversibly encrypted) so users can drive LLM traffic directly.
- **Model catalogue** — `GET /v1/models` on the proxy lists every configured
  model; the platform surfaces this in the admin UI.
- **Usage tracking** — spend, tokens, and budgets are tracked by LiteLLM; the
  platform reads them via `/spend/logs` and `/global/spend/report`.

The platform acts as a **management proxy**: it provisions users/keys/budgets
and displays usage, but LLM traffic (chat completions, messages) flows directly
from clients/containers to this proxy — the platform never relays it.

## Architecture

```
platform (Express :3000)  ──master key──►  LiteLLM management API (:4000)
  create user / key / budget                  /user/*  /key/*  /spend/*

client / container  ──virtual key (sk-...)──►  LiteLLM LLM traffic (:4000)
                                               /v1/chat/completions  /v1/messages
```

Two independent data stores:
- **Platform DB** (sqlite/postgres) — `llm_user_bindings`, `llm_virtual_keys`.
- **LiteLLM DB** (postgres, dedicated) — `LiteLLM_UserTable`,
  `LiteLLM_VerificationToken`, `LiteLLM_SpendLogs`, etc.

They are intentionally **not shared**: the platform talks to LiteLLM over HTTP,
never to its DB.

## Quick start (Docker, recommended on Windows)

Native Python LiteLLM is fragile under Windows' asyncio event loop, so Docker
is the supported path.

```bash
cd sandbox-platform/litellm

# 1. Generate secrets and copy env files.
cp .env.example .env
# Edit .env:
#   LITELLM_MASTER_KEY=$(openssl rand -hex 24)   # prefix with 'sk-'
#   LITELLM_SALT_KEY=$(openssl rand -hex 32)
#   LITELLM_PG_PASSWORD=<something-strong>

# 2. Add your model providers to config.yaml (see comments there).

# 3. Start LiteLLM + its Postgres.
docker compose up -d

# 4. Verify it's live.
curl http://localhost:4000/health/liveliness
```

Then wire the platform to it. In `sandbox-platform/.env`:

```ini
LLM_ENABLED=true
LITELLM_MASTER_KEY=sk-...           # the SAME value as litellm/.env
LLM_ENCRYPTION_KEY=<openssl rand -hex 32>
LITELLM_BASE_URL=http://localhost:4000
LITELLM_PUBLIC_BASE_URL=http://localhost:4000   # or a host-reachable URL for containers
```

Restart the platform, then visit the admin UI → **LLM** to grant a user
access, and **LLM keys** to view your own keys/usage.

## What the platform stores

| Table | Purpose |
|-------|---------|
| `llm_user_bindings` | One row per platform user granted access. Maps `platform_user_id` ↔ `litellm_user_id`, holds the budget mirror. |
| `llm_virtual_keys` | One row per LiteLLM virtual key the platform issued. Stores the key **reversibly encrypted** (AES-256-GCM) under `encrypted_key`; a short `key_prefix` is shown in lists. |

The actual budget enforcement and spend accounting live in LiteLLM — the
platform's columns are mirrors for display and re-issue.

## Using a key from a client

Once an admin grants you access, open **LLM keys** → **Reveal** to see your
virtual key plaintext (shown once). Then:

```bash
# OpenAI SDK style
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# Anthropic SDK style (note: x-api-key header, not Bearer)
curl http://localhost:4000/v1/messages \
  -H "x-api-key: sk-..." \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"hi"}],"max_tokens":100}'
```

## Operations

- **Logs**: `docker compose logs -f litellm-proxy`
- **DB access**: `docker compose exec litellm-db psql -U litellm`
- **Reset spend** (start of billing cycle): `POST /global/spend/reset` with the
  master key.
- **Upgrade**: change the image tag in `docker-compose.yml` and
  `docker compose up -d`. LiteLLM runs its own migrations on boot.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Platform `/ready` shows `litellm: down` | Proxy not started or unhealthy. `docker compose ps`, check `config.yaml` parses. |
| `401` on platform LLM endpoints | `LITELLM_MASTER_KEY` mismatch between platform `.env` and `litellm/.env`. |
| `503 llm_not_enabled` | `LLM_ENABLED` is false, or master key / encryption key missing. |
| `502 llm_error` / `400 budget_exceeded` | A user hit their LiteLLM budget. Raise it in the admin UI. |
| `429 rate_limited` | TPM/RPM limit hit on the key. Adjust in the binding or issue another key. |
| Provider 401 in LiteLLM logs | The provider API key in `config.yaml` / `.env` is missing or wrong. |
