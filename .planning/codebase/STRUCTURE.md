# Codebase Structure

**Analysis Date:** 2026-04-10

## Directory Layout

```
infracode-whatsapp-platform/           # Monorepo root
├── apps/
│   ├── api/                           # Fastify REST API + WhatsApp engine
│   ├── panel/                         # Next.js 14 admin panel (SaaS UI)
│   └── worker/                        # BullMQ webhook dispatch worker
├── packages/
│   ├── types/                         # Shared TypeScript types
│   ├── ui/                            # Shared React UI components
│   └── sdk-js/                        # Client SDK (distributed)
├── prisma/
│   ├── platform.prisma                # Platform schema (tenants, users, billing)
│   ├── tenant.prisma                  # Tenant schema (instances, messages, chatbot)
│   ├── schema.prisma                  # (root alias)
│   ├── migrations/                    # Prisma migration history
│   └── generated/
│       ├── platform-client/           # Generated Prisma client for platform DB
│       └── tenant-client/             # Generated Prisma client for tenant DB
├── infra/
│   ├── compose/                       # Docker Compose files
│   ├── docker/                        # Dockerfiles
│   ├── grafana/                       # Grafana dashboards
│   ├── nginx/                         # Nginx config
│   └── pgbouncer/                     # PgBouncer config
├── scripts/
│   └── with-root-env.mjs              # Helper: run child process with root .env
├── package.json                       # Root pnpm workspace
├── pnpm-workspace.yaml                # Workspace members: apps/*, packages/*
├── tsconfig.base.json                 # Shared TS base config
├── pnpm-lock.yaml
├── install.sh
├── DEPLOY.md
└── README.md
```

## Directory Purposes

**`apps/api/`:**
- Purpose: Core backend — Fastify HTTP API, WhatsApp instance lifecycle, chatbot AI, BullMQ producers
- Entry point: `apps/api/src/server.ts`
- Key subdirectories:
  - `src/modules/` — Feature modules (auth, admin, chatbot, instances, messages, crm, tenant, webhooks, privacy, platform)
  - `src/lib/` — Shared utilities (auth, crypto, database, errors, logger, metrics, phone, redis, tokens)
  - `src/plugins/` — Fastify plugins (`auth.ts`, `swagger.ts`)
  - `src/queues/` — BullMQ queue factories (`message-queue.ts`, `webhook-queue.ts`)
  - `src/routes/` — Central route registration (`index.ts`)
  - `src/config.ts` — Zod-validated environment config
  - `src/scripts/` — One-off scripts (e.g. `seed-platform-owner.ts`)
  - `prisma/` — Symlink/reference to workspace prisma schemas

**`apps/panel/`:**
- Purpose: Next.js 14 App Router frontend for platform admins and tenant users
- Entry point: `apps/panel/app/layout.tsx`
- Key subdirectories:
  - `app/(auth)/` — Login route group
  - `app/(dashboard)/` — Shared dashboard routes (instances overview)
  - `app/(super-admin)/admin/` — Platform admin routes (tenants, billing, settings)
  - `app/(tenant)/tenant/` — Tenant-scoped routes (instances, chatbot, api-keys, crm, onboarding)
  - `components/` — Feature-grouped React components (admin, auth, dashboard, instances, layout, navigation, tenant, ui)
  - `lib/api.ts` — Server-side API client (uses session cookie)
  - `lib/client-api.ts` — Client-side API fetch wrapper
  - `lib/session.ts` / `lib/server-session.ts` — Session management
  - `lib/client-panel-config.ts` — Runtime config for client components

**`apps/worker/`:**
- Purpose: Standalone BullMQ worker that consumes the `webhook-dispatch` queue and delivers HTTP POSTs to tenant webhook URLs
- Entry point: `apps/worker/src/index.ts` (single file, no module structure)

**`packages/types/`:**
- Purpose: Shared TypeScript type definitions consumed by both API and panel
- Entry point: `packages/types/src/index.ts`
- Exports: `InstanceStatus`, `MessageDirection`, `MessageStatus`, `MessageType`, `InstanceSummary`, `InstanceHealthReport`, `WebhookConfig`, `PaginatedResult`, `SendMessagePayload`, chatbot types, etc.

**`packages/ui/`:**
- Purpose: Shared React component library for the panel
- Entry point: `packages/ui/src/index.ts`
- Exports: `Button`, `Badge`, `Card`, `Dialog`, `Input`, `cn()` utility
- Built with Tailwind CSS + Radix-style patterns

**`packages/sdk-js/`:**
- Purpose: JavaScript/TypeScript client SDK for API consumers (external)
- Entry point: `packages/sdk-js/src/index.ts`
- Built and distributed separately

**`prisma/`:**
- Purpose: Database schemas and generated clients
- Two schemas kept separate: `platform.prisma` (global) and `tenant.prisma` (per-tenant)
- Generated clients output to `prisma/generated/platform-client/` and `prisma/generated/tenant-client/`
- Tenant schemas are provisioned at runtime via raw SQL (`apps/api/src/lib/tenant-schema.ts`), not via `prisma migrate`

## Key File Locations

**Entry Points:**
- `apps/api/src/server.ts` — API process bootstrap
- `apps/api/src/app.ts` — Fastify app factory (service wiring)
- `apps/worker/src/index.ts` — Webhook worker process
- `apps/panel/app/layout.tsx` — Next.js root layout

**Configuration:**
- `apps/api/src/config.ts` — All API env vars (Zod schema)
- `pnpm-workspace.yaml` — Monorepo workspace members
- `tsconfig.base.json` — Shared TypeScript base
- `apps/api/prisma/` — Links to workspace `prisma/` schemas

**Core Logic:**
- `apps/api/src/routes/index.ts` — Registers all route modules
- `apps/api/src/plugins/auth.ts` — Auth/authz hook (runs on every request)
- `apps/api/src/lib/database.ts` — `TenantPrismaRegistry` (multi-tenant DB client cache)
- `apps/api/src/lib/tenant-schema.ts` — Tenant schema provisioning SQL
- `apps/api/src/lib/authz.ts` — Roles and scopes definitions
- `apps/api/src/modules/instances/service.ts` — `InstanceOrchestrator`
- `apps/api/src/modules/instances/baileys-session.worker.ts` — Baileys worker thread
- `apps/api/src/modules/chatbot/service.ts` — `ChatbotService`
- `apps/api/src/modules/chatbot/agents/orchestrator.agent.ts` — AI intent routing

**Testing:**
- `apps/api/src/` — Vitest tests colocated with source (look for `*.test.ts` files)
- Config: `apps/api/` (Vitest defaults; no dedicated config file detected)

## Naming Conventions

**Files:**
- Services: `<noun>.service.ts` (e.g. `escalation.service.ts`, `plan-enforcement.service.ts`)
- Routes: `routes.ts` within each module directory
- Schemas: `schemas.ts` within each module directory (Zod schemas for request/response)
- Agents: `<name>.agent.ts` (e.g. `faq.agent.ts`, `scheduling.agent.ts`)
- Tools: `<name>.tool.ts` (e.g. `google-calendar.tool.ts`)
- Lib utilities: `<noun>.ts` in `src/lib/` (e.g. `crypto.ts`, `tokens.ts`)

**Directories:**
- Module directories: lowercase noun (e.g. `auth/`, `instances/`, `chatbot/`)
- Panel route groups: Next.js route group convention `(group-name)/`

## Where to Add New Code

**New API Feature Module:**
- Create directory: `apps/api/src/modules/<feature>/`
- Add files: `routes.ts`, `service.ts`, `schemas.ts`
- Register routes in: `apps/api/src/routes/index.ts`
- Inject service in: `apps/api/src/app.ts` (constructor + `app.decorate()`)
- Add decorator type in: `apps/api/src/types/fastify.d.ts`

**New Chatbot Agent:**
- Create: `apps/api/src/modules/chatbot/agents/<name>.agent.ts`
- Add intent to `IntentRouter`: `apps/api/src/modules/chatbot/agents/intent-router.ts`
- Add case to `OrchestratorAgent`: `apps/api/src/modules/chatbot/agents/orchestrator.agent.ts`
- Add agent types if needed: `apps/api/src/modules/chatbot/agents/types.ts`

**New Chatbot Module (runtime feature flag):**
- Add config schema: `apps/api/src/modules/chatbot/schemas.ts`
- Add runtime handler: `apps/api/src/modules/chatbot/module-runtime.ts`
- Add DB column to `ChatbotConfig` in: `prisma/tenant.prisma` AND `apps/api/src/lib/tenant-schema.ts` (raw SQL)

**New Shared Type:**
- Add to: `packages/types/src/index.ts`

**New Panel Page:**
- Add `page.tsx` under appropriate route group in `apps/panel/app/`
- Add component in matching `apps/panel/components/<feature>/` directory
- API calls go through `apps/panel/lib/api.ts` (server) or `apps/panel/lib/client-api.ts` (client)

**New UI Component:**
- Add to: `packages/ui/src/components/<name>.tsx`
- Export from: `packages/ui/src/index.ts`

**Database Schema Change (platform):**
- Edit `prisma/platform.prisma`
- Run: `pnpm prisma:push:platform` or `prisma migrate dev`
- Regenerate client: `pnpm prisma:generate`

**Database Schema Change (tenant):**
- Edit `prisma/tenant.prisma` (Prisma type reference)
- Add `ALTER TABLE` statements to `apps/api/src/lib/tenant-schema.ts` (applied at runtime)
- Regenerate client: `pnpm prisma:generate`

## Special Directories

**`prisma/generated/`:**
- Purpose: Auto-generated Prisma clients
- Generated: Yes (by `prisma generate`)
- Committed: Yes (required for deployment without a generate step)

**`apps/panel/.next/`:**
- Purpose: Next.js build output
- Generated: Yes
- Committed: No

**`infra/`:**
- Purpose: Infrastructure-as-code for production deployment (Docker, Nginx, PgBouncer, Grafana)
- Generated: No
- Committed: Yes

**`backups/`:**
- Purpose: Backup artifacts
- Generated: Yes (runtime)
- Committed: No (likely gitignored)

---

*Structure analysis: 2026-04-10*
