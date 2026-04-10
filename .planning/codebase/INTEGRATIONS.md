# External Integrations

**Analysis Date:** 2026-04-10

## WhatsApp Protocol

**Baileys (WhatsApp Web Multi-Device):**
- SDK/Client: `@whiskeysockets/baileys` 6.7.18
- Usage: Core product feature — each WhatsApp "instance" runs as a `Worker` thread in `apps/api/src/modules/instances/baileys-session.worker.ts`
- Auth persistence: SQLite via `better-sqlite3` (one DB file per instance, stored at `DATA_DIR/<tenant>/<instance>/`)
- Auth store wrapper: `apps/api/src/modules/instances/baileys-auth-store.ts`
- No API keys required — protocol is implemented directly without WhatsApp Business API

## AI Providers

**Groq (primary):**
- REST API: `https://api.groq.com/openai/v1/chat/completions` (OpenAI-compatible)
- Auth: `GROQ_API_KEY` env var (required), `GROQ_EXTRA_API_KEYS` for pool/rotation
- Key pool management: `apps/api/src/lib/groq-key-rotator.ts` — automatic rotation on 429 / consecutive failures
- Usage limit config: `groqUsageLimit` field on `PlatformConfig` model
- Platform default base URL stored in DB: `apps/api/src/modules/admin/service.ts` (default `"https://api.groq.com/openai/v1"`)

**Google Gemini (optional fallback):**
- Auth: `GEMINI_API_KEY` env var (optional)
- Tenant-level fallback provider, selectable per-tenant as `"gemini"`
- No dedicated SDK — called via fetch against the Gemini endpoint

**Ollama (optional fallback):**
- Connection: `OLLAMA_HOST` env var (optional, e.g. `http://my-server:11434`)
- Self-hosted LLM fallback, selectable per-tenant as `"ollama"`
- No dedicated SDK — called via fetch

**Tenant-managed AI provider:**
- Tenants can configure their own OpenAI-compatible provider (base URL + model + API key)
- Encrypted API key stored in `TenantAiProvider` model (`apps/api/src/modules/chatbot/service.ts`)
- Encryption: AES-256-GCM via `apps/api/src/lib/crypto.ts`, key from `API_ENCRYPTION_KEY`

## Data Storage

**PostgreSQL 16:**
- Primary relational database
- Two separate Prisma schemas:
  - `platform` schema — multi-tenant platform data (`prisma/platform.prisma`): Tenant, User, BillingPlan, ApiKey, AuditLog, etc.
  - Per-tenant schemas — WhatsApp instance data (`prisma/tenant.prisma`): Instance, Message, Contact, Conversation, ChatbotConfig, etc.
- ORM: Prisma Client 6.16.2 (two generated clients at `prisma/generated/platform-client/` and `prisma/generated/tenant-client/`)
- Dynamic tenant schema provisioning: `apps/api/src/lib/tenant-schema.ts` creates a schema per tenant on the fly
- Connection pooling in production: PgBouncer (`infra/docker/pgbouncer.Dockerfile`)
- Env vars:
  - `DATABASE_URL` / `DIRECT_DATABASE_URL`
  - `PLATFORM_DATABASE_URL` / `PLATFORM_DIRECT_DATABASE_URL`
  - `TENANT_DATABASE_URL` / `TENANT_DIRECT_DATABASE_URL`

**SQLite (per instance):**
- Used exclusively for Baileys WhatsApp session state (auth keys, signal state)
- One SQLite file per WhatsApp instance, located under `DATA_DIR`
- Client: `better-sqlite3` 11.10.0

**Redis 7:**
- Used for: BullMQ job queues, rate limiting (`apps/api/src/lib/redis-rate-limit.ts`), in-memory coordination
- Client: ioredis 5.7.0
- Env var: `REDIS_URL`
- Queues defined in `apps/api/src/queues/`:
  - `SEND_MESSAGE` queue — outbound WhatsApp message delivery with retry/backoff
  - `WEBHOOK` queue — outbound webhook delivery (`apps/api/src/queues/webhook-queue.ts`)

**File Storage:**
- Local filesystem only — media files and Baileys auth directories stored under `DATA_DIR` (env var, default `./apps/api/data`)
- In Docker/Railway: volume mounted at `apps/api/data`
- No cloud file storage (S3, GCS, etc.) detected

## Authentication & Identity

**Custom JWT-based auth (no third-party auth provider):**
- Implementation: `apps/api/src/lib/tokens.ts`
- Access tokens: HS256 JWT signed with `JWT_SECRET`, TTL controlled by `ACCESS_TOKEN_TTL_MINUTES`
- Refresh sessions: hashed token stored in `RefreshSession` DB table, TTL `REFRESH_TOKEN_TTL_DAYS`
- Password reset: hashed token in `PasswordResetToken` table, TTL `PASSWORD_RESET_TTL_HOURS`
- Invitations: hashed token in `Invitation` table, TTL `INVITATION_TTL_HOURS`
- 2FA: TOTP via `otpauth` library (`apps/api/src/lib/totp.ts`), secrets encrypted at rest with AES-256-GCM

**API Key auth:**
- Hashed keys stored in `ApiKey` DB table, tenant-scoped
- Scopes array on each key

**Impersonation:**
- Platform admin can impersonate tenant users via `ImpersonationSession` table

## Google Calendar

**Integration:** OAuth2 via `googleapis` 140.0.1
- Used by chatbot scheduling agent: `apps/api/src/modules/chatbot/tools/google-calendar.tool.ts`
- Credentials stored per-chatbot config (client ID, client secret, refresh token)
- Used to check availability and create calendar events from WhatsApp chatbot flows

## Email

**Status: Stub / not yet integrated**
- `EmailService` class exists at `apps/api/src/lib/mail.ts` but only logs email previews to stdout
- No SMTP library or email SaaS SDK installed
- Env var `SMTP_FROM` is declared and validated but the actual SMTP send is not implemented
- Used for: invitations, password resets — both currently log-only

## Monitoring & Observability

**Prometheus:**
- Client: `prom-client` 15.1.3
- Metrics service: `apps/api/src/lib/metrics.ts`
- Exposes: instance status gauge, message counters, webhook delivery counters, latency histograms, Prisma cache counters
- Prometheus server: `prom/prometheus:v3.5.0` in Docker Compose

**Grafana:**
- `grafana/grafana:12.1.1` in Docker Compose
- Dashboards provisioned from `infra/grafana/dashboards/`
- Admin password: `GRAFANA_ADMIN_PASSWORD` env var

**Logging:**
- pino 9.8.0 — structured JSON logs in API and Worker

## CI/CD & Deployment

**Railway:**
- Deployment configs: `apps/panel/railway.json` (panel), `docs/deployment/railway.*.env.example` (per service)
- Each service has its own Dockerfile referenced in Railway config
- Railway auto-detects `RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_VOLUME_MOUNT_PATH` — the API config (`apps/api/src/config.ts`) adapts defaults from these

**Docker Compose:**
- Dev: `infra/compose/docker-compose.dev.yml`
- Prod: `infra/compose/docker-compose.prod.yml` (includes PgBouncer, Nginx with TLS, Certbot, automated pg_dump backups)
- Monitoring-only: `infra/compose/docker-compose.monitoring.yml`

**Reverse Proxy:**
- Nginx 1.29 — terminates TLS, routes traffic between panel and API
- Config: `infra/nginx/default.conf`
- TLS: managed by Certbot (Let's Encrypt), `LETSENCRYPT_EMAIL` env var

**Backups:**
- Automated daily `pg_dump | gzip` via a sidecar container in `docker-compose.prod.yml`
- Stored in `backups/` directory, retained 14 days

## Webhooks

**Outgoing webhooks (tenant-configured):**
- Each WhatsApp instance can have a `WebhookEndpoint` configured (URL + optional HMAC secret)
- Delivered asynchronously via BullMQ webhook queue (`apps/api/src/queues/webhook-queue.ts`)
- Worker processes deliveries: `apps/worker/src/index.ts`
- HMAC signing: `WEBHOOK_HMAC_SECRET` global secret + per-endpoint secrets
- Retry with exponential backoff (5 attempts)

**Incoming webhooks:**
- None detected. The platform receives messages from WhatsApp via the Baileys long-lived socket connection, not webhooks.

## Environment Variables Summary

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Primary PostgreSQL connection |
| `PLATFORM_DATABASE_URL` | Platform schema connection |
| `TENANT_DATABASE_URL` | Tenant template schema connection |
| `DIRECT_DATABASE_URL` / variants | Direct connections bypassing PgBouncer (for migrations) |
| `REDIS_URL` | Redis connection for queues and rate limiting |
| `API_ENCRYPTION_KEY` | AES-256-GCM key for secrets at rest (min 32 chars) |
| `JWT_SECRET` | HMAC secret for access token signing |
| `WEBHOOK_HMAC_SECRET` | Global HMAC secret for outgoing webhook signatures |
| `GROQ_API_KEY` | Groq AI API key (required) |
| `GROQ_EXTRA_API_KEYS` | Additional Groq keys for pool rotation (optional) |
| `GEMINI_API_KEY` | Google Gemini fallback AI key (optional) |
| `OLLAMA_HOST` | Self-hosted Ollama endpoint (optional) |
| `SMTP_FROM` | Sender address for email (stub — not delivered yet) |
| `ROOT_DOMAIN` | Public domain for subdomain routing |
| `LETSENCRYPT_EMAIL` | Email for Let's Encrypt TLS certificates |
| `DATA_DIR` | Filesystem path for Baileys session files and media |
| `ENABLE_AUTH` | Must be `"true"` in production |
| `GRAFANA_ADMIN_PASSWORD` | Grafana dashboard admin password |

---

*Integration audit: 2026-04-10*
