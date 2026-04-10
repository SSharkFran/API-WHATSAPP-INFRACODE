# Architecture Patterns: WhatsApp SaaS CRM Platform

**Domain:** Multi-tenant WhatsApp automation SaaS
**Researched:** 2026-04-10
**Overall confidence:** HIGH (based on codebase direct inspection + verified patterns)

---

## Recommended Component Boundaries

The `InstanceOrchestrator` currently owns seven distinct responsibilities. Each maps to a future service with a clear boundary:

| Proposed Service | Responsibility | Communicates With |
|-----------------|----------------|-------------------|
| `InstanceWorkerManager` | Worker thread lifecycle, RPC, QR/status events | `WorkerThread`, `WebhookService` |
| `ConversationSessionManager` | In-memory session cache, debounce timer, history hydration | `InstanceWorkerManager`, `SessionStateRepository` |
| `AdminIdentityService` | Single-source admin phone resolution for all tenants/instances | `ChatbotModuleRuntime`, any service needing admin detection |
| `SessionLifecycleService` | Formal state transitions (`ativa → aguardando_cliente → encerrada`), timeout scheduling | `ConversationSessionManager`, `BullMQ`, `SessionStateRepository` |
| `SessionMetricsCollector` | Emit `session.*` domain events; write `ConversationMetric` rows | Internal `EventEmitter`, `TenantPrisma` |
| `ModuleRuntime` (exists, extend) | Module config parsing, guard functions; null-safe for disabled modules | Used by all of the above |
| `InstanceOrchestrator` (rump) | Route inbound messages to the above; own only worker lifecycle | All extracted services |

The key insight is that the orchestrator should become a thin coordinator: it receives inbound message events, resolves admin identity once, hands the session to `ConversationSessionManager`, and delegates lifecycle decisions to `SessionLifecycleService`. It should not contain any state-transition logic itself.

---

## Session State Machine Architecture

### Formal States

```
ATIVA
  ↓ (client says "obrigado" / "era só isso" / intent = ENCERRAMENTO)
CONFIRMACAO_ENVIADA
  ↓ (client confirms)        ↓ (timeout 10 min, no reply)
ENCERRADA               INATIVA
  ↑ (new message from client — reopen)
ATIVA
```

The `AGUARDANDO_CLIENTE` state (bot sent reply, waiting for next client input) does not need a separate name in the persistent state machine; it is the default state when `status = ATIVA` and no inactivity timer is running. Add it only if explicit queuing logic is needed.

### Persistence Layer: Hybrid Redis + PostgreSQL

**Use Redis for live session state.** Write the current state enum and last-activity timestamp to a Redis hash keyed `session:{tenantId}:{instanceId}:{remoteJid}`. TTL = 24 hours. This is fast to read on every inbound message without a DB round-trip.

**Use PostgreSQL for durable session records.** On session open (first message), insert a `ConversationSession` row with `startedAt`, `instanceId`, `contactId`. On session close or transition to `INATIVA`, write `endedAt`, `closedReason`, `durationSeconds`, `handoffCount`, `firstResponseMs`. This is the audit trail and the source for metrics aggregation.

**Never use in-memory Map for state transitions.** The current `conversationSessions` Map is acceptable for debounce timers and pending inputs (things that are intrinsically transient), but not for the formal lifecycle status. A process restart silently loses all in-flight state. Move the `status` field to Redis; keep the debounce timer and `pendingInputs` in the Map with the same key.

```typescript
// Redis hash per session
interface RedisSessionState {
  status: "ATIVA" | "CONFIRMACAO_ENVIADA" | "INATIVA" | "ENCERRADA";
  startedAt: string;           // ISO
  lastActivityAt: string;      // ISO
  firstResponseSentAt: string | null;
  handoffCount: string;        // Redis stores strings
  timeoutJobId: string | null; // BullMQ job ID for cancellation
}
```

### BullMQ Integration for Timeouts

Use a dedicated `session-timeout` BullMQ queue. When transitioning to `CONFIRMACAO_ENVIADA`, enqueue a delayed job with a `delay` of 10 minutes (configurable via `sessaoInatividade` module):

```typescript
const job = await sessionTimeoutQueue.add(
  "check-inactivity",
  { tenantId, instanceId, remoteJid, expectedStatus: "CONFIRMACAO_ENVIADA" },
  { delay: timeoutMs, jobId: `session-timeout:${tenantId}:${instanceId}:${remoteJid}` }
);
await redis.hset(sessionKey, "timeoutJobId", job.id);
```

When a new message arrives and the session is `CONFIRMACAO_ENVIADA`, cancel the pending job using the deterministic `jobId`:

```typescript
const job = await sessionTimeoutQueue.getJob(jobId);
if (job) await job.remove();
```

The worker for this queue reads the current Redis state. If the status is still `CONFIRMACAO_ENVIADA` (no client reply arrived), it transitions to `INATIVA` and writes the `ConversationSession.endedAt`. If the status changed (client replied), it does nothing and exits.

**Critical note:** BullMQ's `changeDelay` method only works on jobs in the `delayed` state. The pattern above using a deterministic `jobId` and `job.remove()` followed by a new `add()` is more reliable than `changeDelay` when the session is reset by a new message.

---

## Admin Identity Layer

### The Core Problem

Admin detection is currently performed inline inside `handleInboundMessage` (approximately lines 2049–2171 of `service.ts`). It involves 9 candidate phone arrays, 5 JID normalization paths, Redis escalation lookups, and quoted-message parsing — all mixed into the message processing path. The result is `isAdminSender`, `isAdminOrInstanceSender`, `isVerifiedAprendizadoContinuoAdminSender`, and `canProcessAprendizadoContinuoReply` — four partially overlapping booleans with subtle semantic differences.

### Recommended: `AdminIdentityService`

Extract the entire block into a dedicated service. It takes the raw event, the resolved module config, and JID normalization context. It returns a single `AdminIdentityContext` object:

```typescript
interface AdminIdentityContext {
  isAdmin: boolean;              // any admin match
  isVerifiedAdmin: boolean;      // aprendizadoContinuo verified
  isInstanceSelf: boolean;       // echo from own number
  isAdminSelfChat: boolean;      // admin messaging own number
  canReceiveLearningReply: boolean;
  matchedAdminPhone: string | null;
  escalationConversationId: string | null;
}
```

All downstream logic (`ConversationSessionManager`, `SessionLifecycleService`, chatbot routing) consumes only this struct — no raw JID comparisons. This eliminates the "admin treated as client" bug class because there is exactly one place where admin identity is resolved.

### Storage and Cache

The verified admin phones for a tenant+instance come from the `aprendizadoContinuo` module config stored in the `ChatbotConfig.modules` JSON column. The `AdminIdentityService` receives the already-parsed module config; it does not query the DB itself. Cache at the call site using the already-loaded chatbot config per message.

For the module to be truly optional: if `aprendizadoContinuo` is disabled or unverified, `AdminIdentityService` falls back to matching against `platformConfig.adminAlertPhone` and `chatbotConfig.leadsPhoneNumber` only. No verified admin phones exist. The `isVerifiedAdmin` flag is `false`. Downstream code treats the message as client without special admin paths.

---

## Metrics Collection Architecture

### Requirements

- Capture: session start time, end time, duration, first response time, handoff count, document sends, inactivity-timeout count
- Must not block the message processing pipeline
- Must survive process restart (no in-memory accumulation)

### Recommended: Domain Event → Async DB Write

Use an internal `EventEmitter` on `SessionMetricsCollector`. The orchestrator (or `SessionLifecycleService`) emits typed events at each state transition. The collector listens and writes to `ConversationMetric` rows in the tenant DB asynchronously:

```typescript
type SessionEvent =
  | { type: "session.opened"; tenantId: string; instanceId: string; contactId: string; at: Date }
  | { type: "session.first_response"; sessionId: string; responseMs: number }
  | { type: "session.handoff"; sessionId: string; at: Date }
  | { type: "session.closed"; sessionId: string; reason: "client" | "inactivity" | "manual"; at: Date }
  | { type: "document.sent"; sessionId: string; at: Date };
```

The collector uses `process.nextTick()` or `setImmediate()` to defer DB writes, ensuring the event loop is not blocked during message processing.

Do not use a time-series database (InfluxDB, TimescaleDB). The existing PostgreSQL schema with a `ConversationMetric` table is sufficient for the required aggregations (daily counts, averages by instance). Prometheus metrics (via the existing `prom-client`) are appropriate for operational counters (messages/sec, active sessions), not for per-session business metrics.

### Schema Addition

```sql
-- In tenant schema
CREATE TABLE "ConversationMetric" (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "instanceId"      TEXT NOT NULL REFERENCES "Instance"("id"),
  "contactId"       TEXT NOT NULL,
  "startedAt"       TIMESTAMPTZ NOT NULL,
  "endedAt"         TIMESTAMPTZ,
  "durationSeconds" INTEGER,
  "firstResponseMs" INTEGER,
  "handoffCount"    INTEGER NOT NULL DEFAULT 0,
  "documentCount"   INTEGER NOT NULL DEFAULT 0,
  "closedReason"    TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON "ConversationMetric"("instanceId", "startedAt");
```

The daily summary and CRM dashboard queries run against this table. No aggregation service is needed yet.

---

## Safe Extraction Order for InstanceOrchestrator

This is a strangler-fig approach: extract one capability at a time, leaving the orchestrator's public API unchanged, routing internally to the new service.

### Phase 1 (Early): Admin Identity Service

**What to extract:** Lines 2049–2171 of `service.ts` — the admin detection block.

**Why first:** It has no state, only pure computation over inputs already available at the call site. Extraction is a lift-and-shift with no behavioral change. It immediately fixes the admin-as-client bug by centralizing and making the logic unit-testable.

**Interface:**

```typescript
class AdminIdentityService {
  resolve(params: {
    event: InboundMessageWorkerEvent;
    aprendizadoContinuoModule: AprendizadoContinuoModuleConfig | null;
    platformConfig: { adminAlertPhone: string | null };
    chatbotConfig: { leadsPhoneNumber: string | null };
    instanceOwnPhone: string | null;
    contactFields: Record<string, unknown>;
    escalationService: EscalationService;
  }): Promise<AdminIdentityContext>;
}
```

**Risk:** Low. This is pure computation; if the extraction is wrong, tests will catch it. Add unit tests for the four key scenarios (verified admin, unverified admin, client, instance self-echo) before extracting.

### Phase 2 (Early): ConversationSessionManager (in-memory only)

**What to extract:** The `conversationSessions` Map, `getConversationSession()`, `clearConversationSession()`, `buildConversationSessionKey()`, debounce timer management, and the GC interval.

**Why second:** It has no external dependencies beyond the Map itself and the DB call in `getConversationSession()`. Extracting it creates a clean seam for the session state machine.

**Interface:**

```typescript
class ConversationSessionManager {
  get(sessionKey: string): ConversationSession | undefined;
  getOrCreate(params: { prisma; sessionKey; instanceId; remoteJid; leadAlreadySent; inactivityMs }): Promise<ConversationSession>;
  clear(sessionKey: string): void;
  setDebounceTimer(sessionKey: string, timer: NodeJS.Timeout): void;
  clearDebounceTimer(sessionKey: string): void;
  startGc(intervalMs: number): void;
  stopGc(): void;
}
```

**Risk:** Low-medium. The debounce timer logic is tightly coupled to the flush logic in the orchestrator. The extraction boundary must preserve the `isProcessing`/`flushAfterProcessing` contract exactly.

### Phase 3 (Mid): SessionLifecycleService + Redis State + BullMQ Timeout Queue

**What to extract:** The formal lifecycle state machine — transition logic for opening, confirmation, inactivity, closure. Introduce the Redis state hash and the `session-timeout` BullMQ queue here.

**Why third:** Requires `ConversationSessionManager` to be extracted first (Phase 2). This phase adds new behavior (formal states, persistent Redis, timeout jobs), not just a refactor of existing code. It is the most complex extraction.

**Dependencies added:** `IORedis`, new `session-timeout` BullMQ queue.

**Risk:** Medium. State transition logic is currently implicit (checking `awaitingAdminResponse`, `awaitingLeadExtraction`, `humanTakeover` booleans inline). Making it explicit as a state machine can expose edge cases. Do it behind a feature flag initially: if `SESSION_LIFECYCLE_V2=true`, use the new service; otherwise, fall through to existing code. Remove the flag once stable.

### Phase 4 (Mid): SessionMetricsCollector

**What to extract:** The `SessionEvent` emitter, `ConversationMetric` writes, and the daily summary aggregation query.

**Why fourth:** Requires the `ConversationSession` DB record from Phase 3 to exist before it can write metrics. Low risk — purely additive.

**Risk:** Low. Additive behavior; no existing code is replaced, only augmented.

### Phase 5 (Late): aprendizadoContinuo Module Isolation

**What to extract:** All verification flow (PENDING → VERIFIED → admin identity confirmed), the daily summary sender, and the learning reply processor out of the orchestrator into a standalone `ContinuousLearningService`.

**Why last:** Most deeply entangled with orchestrator message processing. Requires all of Phases 1–4 to be stable first. The `AdminIdentityService` (Phase 1) already decouples the identity detection; this phase moves the learning reply processing and daily summary out of the scheduler intervals.

**Risk:** High. The learning flow touches 15+ distinct code paths. Extract under full test coverage of the existing behavior before touching. Use the Null Object pattern for the disabled case: `ContinuousLearningService.disabled()` returns a no-op instance implementing the same interface.

---

## Module System (Feature Flags) Architecture

### Current State

The `aprendizadoContinuo` module is configured via the `modules` JSONB column on `ChatbotConfig`. The `module-runtime.ts` file provides getter functions (`getAprendizadoContinuoModuleConfig`) that parse and validate the JSON. The orchestrator calls these getters inline and checks `module?.isEnabled` before entering module-specific paths.

The problem is that `isEnabled=false` doesn't mean the code is skipped — there are 20+ places in the orchestrator that still compute module config even when disabled, and a few that have implicit fallback behavior (e.g., treating the configured phone as admin even when `verificationStatus !== "VERIFIED"`).

### Recommended: Null Object Pattern for Module Contracts

Define a typed interface for each module's behavior contract. The disabled case returns a no-op implementation of the same interface:

```typescript
interface IAprendizadoContinuoModule {
  isEnabled(): boolean;
  isVerified(): boolean;
  getAdminPhones(): string[];
  getAdminJids(): string[];
  processLearningReply(params: LearningReplyParams): Promise<void>;
  shouldSendDailySummary(now: Date): boolean;
  buildDailySummary(params: SummaryParams): Promise<string | null>;
}

class DisabledAprendizadoContinuoModule implements IAprendizadoContinuoModule {
  isEnabled() { return false; }
  isVerified() { return false; }
  getAdminPhones() { return []; }
  getAdminJids() { return []; }
  async processLearningReply() { /* no-op */ }
  shouldSendDailySummary() { return false; }
  async buildDailySummary() { return null; }
}
```

`AdminIdentityService.resolve()` accepts `IAprendizadoContinuoModule` and calls `getAdminPhones()` — it never checks `isEnabled` directly. When the module is disabled, the phones list is empty, and admin detection falls back to `platformConfig.adminAlertPhone` only.

This approach eliminates all `if (module?.isEnabled)` guards scattered across the orchestrator. The orchestrator always calls the interface; the disabled implementation does nothing.

### Module Registration Pattern

In `app.ts`, during service construction:

```typescript
const aprendizadoContinuoModule = chatbotConfig.modules?.aprendizadoContinuo?.isEnabled
  ? new ActiveAprendizadoContinuoModule(chatbotConfig, ...)
  : new DisabledAprendizadoContinuoModule();
```

Inject via the existing constructor dependency injection pattern already used in `InstanceOrchestrator`.

---

## Data Flow: Session State and Metrics

```
Baileys Worker Thread
  │ inbound-message event
  ▼
InstanceOrchestrator.handleInboundMessage()
  │
  ├─► AdminIdentityService.resolve()          ← Phase 1 extraction
  │     └─ returns AdminIdentityContext
  │
  ├─► ConversationSessionManager.getOrCreate() ← Phase 2 extraction
  │     └─ returns ConversationSession (in-memory)
  │
  ├─► SessionLifecycleService.transition()    ← Phase 3 (new behavior)
  │     ├─ reads Redis session state
  │     ├─ computes new state
  │     ├─ writes Redis session state
  │     ├─ schedules/cancels BullMQ timeout job
  │     └─ emits SessionEvent
  │
  ├─► SessionMetricsCollector (listener)      ← Phase 4 extraction
  │     └─ writes ConversationMetric row (async, deferred)
  │
  └─► ChatbotService.process()               ← unchanged
        └─ returns reply text
              │
              └─► InstanceOrchestrator.enqueueOutboundMessage()
```

The orchestrator's `handleInboundMessage` becomes a coordinator that calls services in sequence. No business logic lives in the orchestrator itself.

---

## Which Phase Addresses Which Architectural Concern

| Phase | Concern | Extraction | Risk |
|-------|---------|------------|------|
| Phase 1 (early) | Admin identity bugs | `AdminIdentityService` | Low |
| Phase 1 (early) | Security: CORS, API key encryption | Not extraction — direct fixes | None |
| Phase 2 (early) | Session memory leak (unbounded Map) | `ConversationSessionManager` with bounded GC | Low |
| Phase 3 (mid) | Session lifecycle formalization | `SessionLifecycleService` + Redis + BullMQ | Medium |
| Phase 3 (mid) | Timeout/inactivity behaviors (`sessaoInatividade`) | Part of `SessionLifecycleService` | Medium |
| Phase 4 (mid) | Metrics collection | `SessionMetricsCollector` + `ConversationMetric` table | Low |
| Phase 4 (mid) | Daily summary data accuracy | Aggregation over `ConversationMetric` | Low |
| Phase 5 (late) | Module system isolation | Null Object pattern for `aprendizadoContinuo` | High |
| Phase 5 (late) | Daily summary sender extraction | Part of `ContinuousLearningService` | Medium |

**Quick wins that are not extractions and can happen any time:**

- Fix the `conversationSessions` debounce timer not cleared on `close()` (one-line fix, see CONCERNS.md)
- Add `stopSchedulers()` to `onClose` hook
- Fix worker crash not updating instance status to `DISCONNECTED`
- Replace all `console.log/warn/error` in the orchestrator with the Pino logger

These should be done before any structural extraction to reduce noise in future diffs.

---

## Anti-Patterns to Avoid

### 1. Big-Bang Rewrite of InstanceOrchestrator

Do not rename/replace the class in one PR. Extract one service per phase. The orchestrator's public API must remain unchanged at every step. Routes and tests should not change when a service is extracted.

### 2. Storing Session Status Only In-Memory

The current `conversationSessions` Map does not survive API restart. Storing `status` in Redis with TTL is mandatory before deploying the lifecycle feature. Any solution that relies on the Map surviving a deploy is incorrect.

### 3. Blocking the Message Pipeline for Metrics

Do not write `ConversationMetric` rows synchronously inside `handleInboundMessage`. Use `setImmediate()` or the `EventEmitter` pattern to defer DB writes. A slow DB write during a message burst will cause queue buildup.

### 4. Duplicating Admin Phone Detection

The current pattern of computing `isAdminSender` in multiple places (orchestrator, escalation service, daily summary sender) must stop. After `AdminIdentityService` is extracted (Phase 1), no other service may resolve admin identity independently. All must call `AdminIdentityService`.

### 5. Checking `module?.isEnabled` In Business Logic

After the Null Object pattern is adopted (Phase 5), no service should check `isEnabled` at runtime. The disabled implementation handles the no-op. Code that checks `isEnabled` directly is coupling business logic to configuration.

---

## Scalability Considerations

| Concern | Now (prototype) | At 100 tenants | At 1,000 tenants |
|---------|-----------------|----------------|------------------|
| Session state | In-memory Map per process | Redis hash (handles fine) | Redis cluster sharded by tenantId |
| Timeout jobs | `setInterval` GC in orchestrator | BullMQ delayed queue (handles fine) | No change needed |
| Metrics writes | None | `ConversationMetric` append-only (fine) | Partition by `instanceId`, consider batching |
| Admin identity | Inline computation | Extracted service, stateless (fine) | No change needed; it's stateless |
| Worker threads | One per instance | No change | Consider process-per-tenant isolation |

The Redis hybrid for session state is the only infrastructure change needed before 100 tenants. The rest scales with the existing PostgreSQL + Redis stack.

---

## Sources

- BullMQ delayed jobs and `changeDelay`: https://docs.bullmq.io/guide/jobs/delayed
- BullMQ timeout job patterns: https://docs.bullmq.io/patterns/timeout-jobs
- State machines for messaging bots: https://developer.vonage.com/en/blog/state-machines-for-messaging-bots
- Strangler fig pattern: https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-decomposing-monoliths/strangler-fig.html
- Redis session management: https://redis.io/solutions/session-management/
- Codebase direct inspection: `apps/api/src/modules/instances/service.ts` (5,150 lines)
- Codebase direct inspection: `apps/api/src/modules/chatbot/module-runtime.ts`
- `.planning/codebase/CONCERNS.md` — technical debt and risk audit
