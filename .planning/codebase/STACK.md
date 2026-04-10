# Technology Stack

**Analysis Date:** 2026-04-10

## Languages

**Primary:**
- TypeScript 5.9.x — All apps and packages. Strict mode enabled across the board.

**Secondary:**
- None. No JavaScript-first files (except auto-generated Next.js configs like `next.config.mjs`).

## Runtime

**Environment:**
- Node.js 20 (Docker base image: `node:20-bookworm-slim`)
- ES Module (`"type": "module"`) used in all backend packages (`@infracode/api`, `@infracode/worker`, `@infracode/sdk-js`, `@infracode/types`, `@infracode/ui`)
- Target: ES2022 (`tsconfig.base.json`)
- Module resolution: `NodeNext`

**Package Manager:**
- pnpm 10.16.0 (declared in root `package.json` via `packageManager` field)
- Lockfile: `pnpm-lock.yaml` present at root

## Monorepo Structure

pnpm workspaces with two workspace roots:

```
apps/
  api/       → @infracode/api    (Fastify backend + WhatsApp engine)
  panel/     → @infracode/panel  (Next.js admin panel)
  worker/    → @infracode/worker (BullMQ webhook delivery worker)
packages/
  types/     → @infracode/types  (shared TypeScript types)
  ui/        → @infracode/ui     (shared React component library)
  sdk-js/    → @infracode/sdk-js (public JS SDK)
```

Internal packages are consumed via `workspace:*` references and path aliases defined in `tsconfig.base.json`.

## Frameworks

**Backend (`apps/api`):**
- Fastify 5.6.0 — HTTP server
- `@fastify/cors` 11.1.0
- `@fastify/helmet` 13.0.2
- `@fastify/rate-limit` 10.3.0
- `@fastify/sensible` 6.0.3
- `@fastify/swagger` 9.5.1 + `@fastify/swagger-ui` 5.2.3
- `@fastify/websocket` 11.2.0
- `fastify-type-provider-zod` 4.0.2 — Zod-based request/response typing for Fastify
- `fastify-plugin` 5.0.1

**Frontend (`apps/panel`):**
- Next.js 14.2.35 (App Router)
- React 18.3.1
- Tailwind CSS 3.4.17
- PostCSS 8.5.6, Autoprefixer 10.4.21
- `lucide-react` 0.544.0 (icons)
- `clsx` 2.1.1 + `tailwind-merge` 3.3.1 (used in `@infracode/ui`)

**Job Queue (`apps/worker` + `apps/api`):**
- BullMQ 5.58.5 — async job queue backed by Redis
- ioredis 5.7.0 — Redis client

**Testing (`apps/api`):**
- Vitest 3.2.4
- supertest 7.1.4 (HTTP integration testing)

## Key Dependencies

**Critical:**
- `@whiskeysockets/baileys` 6.7.18 — WhatsApp Web protocol library (core feature of the product)
- `@prisma/client` 6.16.2 / `prisma` 6.16.2 — ORM for PostgreSQL (two separate schemas: `platform` and `tenant_template`)
- `better-sqlite3` 11.10.0 — SQLite for per-instance Baileys auth state persistence
- `zod` 3.25.76 — Schema validation (used for env config, API body schemas, and Zod-Fastify type provider)
- `jose` 5.9.6 — JWT signing/verification (HS256 access tokens and refresh tokens)
- `bullmq` 5.58.5 — Message scheduling, outbound webhooks

**Infrastructure:**
- `pino` 9.8.0 — Structured JSON logging (API and Worker)
- `prom-client` 15.1.3 — Prometheus metrics exposition
- `otpauth` 9.4.1 — TOTP 2FA implementation
- `qrcode` 1.5.4 — QR code generation for WhatsApp pairing
- `mime-types` 3.0.1 — Media type detection for message attachments
- `googleapis` 140.0.1 — Google Calendar OAuth2 integration (chatbot scheduling tool)

## Build Tools

**Transpilation / Dev:**
- `tsx` 4.20.5 — Dev-mode TypeScript execution (`tsx watch src/server.ts`)
- `tsc` — Production build for `@infracode/api`, `@infracode/worker`, `@infracode/sdk-js`, `@infracode/types`, `@infracode/ui`

**Frontend Build:**
- `next build` — Panel uses the Next.js compiler directly; no separate bundler config

**Auxiliary:**
- `esbuild` — listed in `pnpm-workspace.yaml` as a native-only dependency; likely pulled by `tsx`/bundler transitively

## TypeScript Configuration

Root `tsconfig.base.json`:
- `"target": "ES2022"`, `"lib": ["ES2023", "DOM"]`
- `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`
- `"strict": true`, `"isolatedModules": true`, `"noEmitOnError": true`
- Path aliases: `@infracode/types`, `@infracode/sdk-js`, `@infracode/ui`

Each app/package extends this base with its own `tsconfig.json`.

## Configuration

**Environment:**
- All environment variables loaded and validated via Zod schema in `apps/api/src/config.ts`
- Root `.env` / `.env.example` at project root; consumed by Docker Compose via `env_file`
- Railway deployment uses service-reference variables (e.g. `${{Postgres.DATABASE_URL}}`)

**Build:**
- `infra/docker/api.Dockerfile` — multi-stage Docker build for API
- `infra/docker/panel.Dockerfile` — Next.js panel Docker build
- `infra/docker/worker.Dockerfile` — Worker Docker build
- `infra/docker/pgbouncer.Dockerfile` — PgBouncer connection pooler

## Platform Requirements

**Development:**
- Node.js 20+, pnpm 10+
- PostgreSQL 16, Redis 7 (via Docker Compose: `infra/compose/docker-compose.dev.yml`)
- ffmpeg, openssl, python3, make, g++ (native module compilation, required in Docker image)

**Production:**
- Docker Compose (`infra/compose/docker-compose.prod.yml`) with: PostgreSQL 16, Redis 7, PgBouncer, Nginx 1.29, Certbot, Prometheus, Grafana
- Alternatively deployable to Railway (see `apps/panel/railway.json` and `docs/deployment/*.env.example`)

---

*Stack analysis: 2026-04-10*
