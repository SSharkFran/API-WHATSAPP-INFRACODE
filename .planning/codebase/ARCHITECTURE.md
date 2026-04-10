# Architecture

**Analysis Date:** 2026-04-10

## Pattern Overview

**Overall:** Multi-tenant SaaS monorepo with a service-layer API, background worker, and Next.js panel.

**Key Characteristics:**
- Multi-tenant isolation via PostgreSQL schemas — each tenant gets its own schema (`tenant_<id>`) within the same database
- Two separate Prisma schemas: `platform.prisma` (global users, tenants, billing) and `tenant.prisma` (per-tenant WhatsApp data)
- WhatsApp connections run as Node.js Worker Threads inside the API process (`baileys-session.worker.ts`), one thread per instance
- Async operations (message sends, webhook dispatches) go through BullMQ queues backed by Redis
- A standalone `@infracode/worker` app processes the `webhook-dispatch` BullMQ queue separately from the API

## Layers

**Configuration Layer:**
- Purpose: Load and validate all environment variables at startup
- Location: `apps/api/src/config.ts`
- Contains: Zod-validated env schema (`AppConfig` type)
- Depends on: Environment variables
- Used by: All services, injected via Fastify decorators

**Transport Layer (Fastify API):**
- Purpose: HTTP request/response handling, auth enforcement, routing
- Location: `apps/api/src/server.ts`, `apps/api/src/app.ts`, `apps/api/src/plugins/`
- Contains: Fastify instance, CORS/helmet/rate-limit setup, auth plugin, swagger plugin
- Depends on: Service layer
- Used by: External API consumers, `@infracode/panel`

**Auth Plugin:**
- Purpose: Central authentication and authorization for all routes
- Location: `apps/api/src/plugins/auth.ts`
- Contains: JWT verification, API key lookup, tenant rate-limit enforcement, scope checking
- Depends on: `lib/tokens.ts`, `lib/authz.ts`, `lib/redis-rate-limit.ts`, `PlanEnforcementService`

**Service Layer:**
- Purpose: All business logic; services receive dependencies via constructor injection
- Location: `apps/api/src/modules/*/service.ts` and `apps/api/src/modules/platform/*.service.ts`
- Contains: `AuthService`, `ChatbotService`, `InstanceOrchestrator`, `MessageService`, `WebhookService`, `TenantManagementService`, `PlanEnforcementService`, `PlatformAlertService`, `EscalationService`, `FiadoService`, `KnowledgeService`, `PersistentMemoryService`
- Depends on: Database layer, Redis, queues, other services
- Used by: Route handlers via Fastify decorators

**Database Layer:**
- Purpose: Prisma client management for platform and per-tenant schemas
- Location: `apps/api/src/lib/database.ts`
- Contains: `createPlatformPrisma()`, `TenantPrismaRegistry` (LRU cache of per-tenant Prisma clients)
- Depends on: `prisma/generated/platform-client`, `prisma/generated/tenant-client`
- Used by: All services

**WhatsApp Session Layer:**
- Purpose: Manage live WhatsApp connections via Baileys library
- Location: `apps/api/src/modules/instances/service.ts` (orchestrator), `apps/api/src/modules/instances/baileys-session.worker.ts` (worker thread)
- Contains: `InstanceOrchestrator` spawns one `Worker` thread per active instance; communication via `parentPort` message passing (RPC pattern)
- Depends on: `@whiskeysockets/baileys`, `better-sqlite3` (auth state), Redis for heartbeats
- Used by: `MessageService` for sends, chatbot pipeline for inbound routing

**Chatbot / AI Layer:**
- Purpose: Automated response generation for inbound WhatsApp messages
- Location: `apps/api/src/modules/chatbot/`
- Contains: `ChatbotService` (entry point), `OrchestratorAgent` (routes to sub-agents), sub-agents: `FaqAgent`, `EscalationAgent`, `SchedulingAgent`, `GeneralAgent`, `IntentRouter`
- Depends on: External AI APIs (Groq, Gemini, Ollama), Google Calendar (scheduling), `KnowledgeService`, `PersistentMemoryService`
- Used by: `InstanceOrchestrator` on each inbound message

**Queue Layer:**
- Purpose: Decouple async operations from the HTTP request cycle
- Location: `apps/api/src/queues/`
- Contains: `send-message` queue (message delivery with retry), `webhook-dispatch` queue (outbound webhooks)
- Depends on: Redis (BullMQ backend)
- Used by: `MessageService` enqueues sends; `WebhookService` enqueues deliveries; `@infracode/worker` consumes webhook-dispatch

## Data Flow

**Outbound Message Send (REST → WhatsApp):**

1. Client POSTs to `/instances/:id/messages/send`
2. Auth plugin validates JWT or API key; checks tenant rate limit
3. `MessageService.enqueueMessage()` creates a `Message` record (status `QUEUED`) and adds job to `send-message` BullMQ queue
4. BullMQ worker (internal to API) picks up the job and calls `InstanceOrchestrator.sendMessage()`
5. Orchestrator sends an RPC command to the Baileys worker thread for that instance
6. Worker thread delivers via WhatsApp; reports back status update events
7. Orchestrator updates `Message` record to `SENT`/`FAILED` and fires `WebhookService.enqueue()`
8. `webhook-dispatch` queue job is consumed by `@infracode/worker`, which POSTs to the tenant's webhook URL with HMAC signature

**Inbound Message (WhatsApp → Chatbot → Reply):**

1. Baileys worker thread receives a WhatsApp message; sends `inbound-message` event to parent (InstanceOrchestrator)
2. `InstanceOrchestrator` persists the `Message` record and fires a `message.inbound` webhook event
3. If chatbot is enabled, calls `ChatbotService.process()`
4. `ChatbotService` applies module rules (business hours, spam guard, whitelist), then hands off to `OrchestratorAgent`
5. `OrchestratorAgent` calls `IntentRouter` to classify intent (FAQ / ESCALATE / SCHEDULE / HANDOFF / GENERAL)
6. Routes to the appropriate sub-agent (e.g. `FaqAgent`, `SchedulingAgent`)
7. AI agent generates reply text; returned to `ChatbotService`
8. `ChatbotService` returns reply text; `InstanceOrchestrator` enqueues the outbound message

**Tenant Provisioning:**

1. Platform admin creates tenant via `PlatformAdminService`
2. `TenantPrismaRegistry.ensureSchema()` runs `CREATE SCHEMA IF NOT EXISTS tenant_<id>` and all DDL for tenant tables
3. Prisma client is created against the new schema and cached in the LRU registry

**State Management:**
- No global in-memory state for business data — all persisted in PostgreSQL
- Per-instance live state (QR codes, connection status) held in the Orchestrator's `Map<instanceId, ManagedWorker>` in-process
- Redis used for: BullMQ queue backend, per-tenant HTTP rate-limit counters, cross-process coordination

## Key Abstractions

**TenantPrismaRegistry:**
- Purpose: LRU cache of per-tenant Prisma clients (max 64, idle TTL 10 min); avoids creating a new connection pool on every request
- Location: `apps/api/src/lib/database.ts`
- Pattern: Lazy instantiation with creation locks to prevent thundering herd

**InstanceOrchestrator:**
- Purpose: Lifecycle manager for all WhatsApp instances; single source of truth for which instances are running
- Location: `apps/api/src/modules/instances/service.ts`
- Pattern: Spawns Node.js Worker Threads; uses RPC over `postMessage`/`parentPort` with pending request map and timeouts

**OrchestratorAgent:**
- Purpose: Two-level AI dispatch — fast intent classification then specialized agent
- Location: `apps/api/src/modules/chatbot/agents/orchestrator.agent.ts`
- Pattern: Chain-of-responsibility with fallback to `GeneralAgent` on any failure

**AuthContext:**
- Purpose: Normalized auth state attached to every request at `request.auth`
- Location: `apps/api/src/lib/authz.ts`
- Pattern: Actor type (`ANONYMOUS` | `PLATFORM_USER` | `TENANT_USER` | `API_KEY`), scopes array, optional tenantId/platformRole

## Entry Points

**API Server:**
- Location: `apps/api/src/server.ts`
- Triggers: `tsx watch src/server.ts` (dev), `node dist/apps/api/src/server.js` (prod)
- Responsibilities: Build Fastify app, bootstrap persisted WhatsApp instances, start HTTP listener

**Webhook Worker:**
- Location: `apps/worker/src/index.ts`
- Triggers: `tsx watch src/index.ts` (dev), process start
- Responsibilities: Consume `webhook-dispatch` BullMQ queue, deliver HTTP POSTs with retry

**Panel:**
- Location: `apps/panel/app/layout.tsx` (Next.js root)
- Triggers: `next dev` / `next start`
- Responsibilities: Serve UI; all data fetching goes through `apps/panel/lib/api.ts` or `apps/panel/lib/client-api.ts` which call the `@infracode/api` REST endpoints

## Error Handling

**Strategy:** Centralized error normalization via `normalizeError()` in the Fastify global error handler

**Patterns:**
- `ApiError` class (`apps/api/src/lib/errors.ts`) carries HTTP status code, machine-readable `publicCode`, and optional `details`
- 5xx errors logged at `error` level; 4xx at `warn` level
- Route handlers throw `ApiError` directly; Fastify catches and serializes via `setErrorHandler`
- Worker threads send typed error events back to orchestrator; orchestrator updates DB and fires alert

## Cross-Cutting Concerns

**Logging:** Pino (`apps/api/src/lib/logger.ts`); request-scoped `request.log` in routes; structured JSON in production

**Validation:** All request bodies and query params validated with Zod schemas colocated in `modules/*/schemas.ts`; Fastify type-provider-zod integrates schemas into OpenAPI docs automatically

**Authentication:** JWT access tokens (15 min TTL) + refresh tokens (14 days); API keys hashed with SHA-256 stored in `ApiKey` table; both resolved by `apps/api/src/plugins/auth.ts` before any route handler runs

**Metrics:** Prometheus-compatible metrics via `prom-client`; exposed at `GET /metrics`; `MetricsService` (`apps/api/src/lib/metrics.ts`) tracks tenant Prisma cache hits/misses/evictions and active clients

**Encryption:** AES-256-GCM symmetric encryption (`apps/api/src/lib/crypto.ts`) used for webhook secrets and AI API keys stored in DB; key comes from `API_ENCRYPTION_KEY` env var

**Audit Logging:** Every mutating route records to `PlatformAuditLog` (platform schema) or `AuditLog` (tenant schema) with HMAC signature for tamper detection (`apps/api/src/lib/audit.ts`)

---

*Architecture analysis: 2026-04-10*
