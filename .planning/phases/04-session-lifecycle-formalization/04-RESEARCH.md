# Phase 4: Session Lifecycle Formalization — Research

**Researched:** 2026-04-14
**Domain:** Session state machine, BullMQ deduplication, Redis/PostgreSQL persistence, EventEmitter decoupling
**Confidence:** HIGH

---

## Summary

Phase 4 extracts the informal, in-memory session bookkeeping that lives inside `InstanceOrchestrator` and replaces it with a formal state machine persisted to both Redis (live state) and PostgreSQL (`ConversationSession` table). The work is organized as four plans:

- **4.1** is a pure reorganization (no behavior change): the `conversationSessions` Map, all helper methods, and the GC interval move into a `ConversationSessionManager` class.
- **4.2** adds the `ConversationSession` DB table and Redis hash per session; the table is introduced via the `buildTenantSchemaSql` / `ALTER TABLE IF NOT EXISTS` pattern from `tenant-schema.ts`.
- **4.3** replaces the in-process `setTimeout` debounce with a BullMQ `session-timeout` queue using `deduplication.extend: true` so every new client message resets the timer in O(1) without scanning the Map.
- **4.4** introduces `InstanceEventBus` as a typed `EventEmitter` wrapper so subsequent phases (5, 6, 7) can subscribe to domain events without direct coupling to `InstanceOrchestrator`.

**Critical finding:** Phase 2 plans 02-01 through 02-04 were never completed — `run-migrations.ts` does not exist. Plan 4.2 must add `ConversationSession` via the existing raw SQL `ALTER TABLE IF NOT EXISTS` pattern in `tenant-schema.ts`, NOT via a `runMigrations()` system that does not yet exist.

**Primary recommendation:** Follow the strangler-fig pattern established in Phase 3. Extract first (4.1), persist second (4.2), replace the timer mechanism third (4.3), wire events last (4.4). Do not collapse plans — each is independently rollback-safe.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| bullmq | 5.71.0 (lock) / ^5.58.5 (package.json) | Session timeout queue with deduplication | Already installed; `deduplication.extend` available in v5+ |
| ioredis | ^5.7.0 | Redis client for session state hash | Already installed; same instance used for all Redis ops |
| node:events | built-in | EventEmitter for InstanceEventBus | Zero dependency; already imported in service.ts |
| vitest | ^3.2.4 | Test framework | Already installed; used in Phase 3 |

[VERIFIED: apps/api/package.json] [VERIFIED: node_modules/.pnpm/lock.yaml — actual resolved version 5.71.0]

### No New Dependencies Required

All four plans can be implemented with packages already installed. No `npm install` step is needed.

---

## Phase Requirements

<phase_requirements>

| ID | Description | Research Support |
|----|-------------|------------------|
| SESS-01 | Estados formais de sessão: ATIVA, AGUARDANDO_CLIENTE, CONFIRMACAO_ENVIADA, INATIVA, ENCERRADA | Plan 4.1 creates the seam; Plan 4.3 implements the state machine |
| SESS-02 | Estado de sessão persistido em Redis (TTL 24h) e PostgreSQL — não apenas em memória | Plan 4.2 Redis hash + ConversationSession table |
| SESS-03 | Timeout de 10 minutos dispara "Ainda deseja continuar?" | Plan 4.3 BullMQ timeout worker |
| SESS-04 | Timeout implementado com BullMQ deduplication `extend: true` | Plan 4.3 — confirmed API exists in installed version |
| SESS-05 | Sessão não encerrada abruptamente — sempre confirma antes | Plan 4.3 state transition ATIVA → CONFIRMACAO_ENVIADA → ENCERRADA |
| SESS-06 | humanTakeover persistido no banco — não se perde em restart | Already in Conversation table (humanTakeover BOOLEAN); Plan 4.2 adds ConversationSession.humanTakeover |
| SESS-07 | Quando humanTakeover ativo, bot para completamente | Already enforced via isAiBlocked check; Plan 4.2 adds Redis fast path |
| SESS-08 | Horário de início, fim e duração registrados | Plan 4.2 ConversationSession.startedAt/endedAt/durationSeconds |
| SESS-09 | Encerramento automático por intenção do cliente | Plan 4.3 intent hook in SessionLifecycleService (stub; full classifier in Phase 5) |

</phase_requirements>

---

## Current State of conversationSessions in service.ts

[VERIFIED: direct code inspection, all line numbers are post-Phase-3-cleanup state]

### The Map declaration (line 267)

```typescript
// service.ts line 267
private readonly conversationSessions = new Map<string, ConversationSession>();
```

### The ConversationSession interface (lines 205-213)

```typescript
// service.ts lines 205-213
interface ConversationSession extends BaseConversationSession {
  pendingInputs: string[];
  pendingContext: PendingConversationTurnContext | null;
  debounceTimer: NodeJS.Timeout | null;
  isProcessing: boolean;
  flushAfterProcessing: boolean;
  resetGeneration: number;
  lastActivityAt: Date;
}
```

`BaseConversationSession` (from `chatbot/agents/types.ts`) has two fields:

```typescript
// apps/api/src/modules/chatbot/agents/types.ts
export interface ConversationSession {
  history: ChatMessage[];
  leadAlreadySent: boolean;
}
```

So the full session entry shape is:
- `history: ChatMessage[]` — in-process conversation history
- `leadAlreadySent: boolean` — prevents double lead submission
- `pendingInputs: string[]` — batched text waiting for debounce timer
- `pendingContext: PendingConversationTurnContext | null` — context for next LLM call
- `debounceTimer: NodeJS.Timeout | null` — the timer that will be replaced by BullMQ
- `isProcessing: boolean` — guards against concurrent LLM calls for same session
- `flushAfterProcessing: boolean` — queues a follow-up turn after current one completes
- `resetGeneration: number` — incremented on clear; used to detect stale callbacks
- `lastActivityAt: Date` — used by GC and inactivity check

### Methods that manage the Map

| Method | Location | What It Does |
|--------|----------|--------------|
| `buildConversationSessionKey(instanceId, remoteJid)` | line 3370 | Returns `"${instanceId}:${remoteJid}"` |
| `getConversationSession(prisma, sessionKey, ...)` | line 3592 | Get-or-create; loads last 20 messages from DB on first access |
| `clearConversationSession(sessionKey)` | line 3374 | clears debounceTimer, increments resetGeneration, deletes from Map |
| `queueConversationTurn(session, inputText, context)` | line 3741 | Batches input, clears old timer, sets new setTimeout debounce |
| `processQueuedConversationTurn(session)` | line 3779 | Drains pendingInputs, calls LLM pipeline |

### The GC interval (lines 341-353)

```typescript
// Runs every 30 minutes
this.sessionGcInterval = setInterval(() => {
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000); // 4h cutoff
  for (const [key, session] of this.conversationSessions.entries()) {
    if (session.lastActivityAt < cutoff && !session.isProcessing && !session.debounceTimer) {
      this.conversationSessions.delete(key);
    }
  }
}, 30 * 60 * 1000);
```

This lives in `startSchedulers()` (which is called from `server.ts` after `app.listen()` per Phase 3 fix). It is stopped in `stopSchedulers()` at line 365.

### The debounce pattern (lines 3761-3776)

```typescript
// Inside queueConversationTurn()
if (session.debounceTimer) {
  clearTimeout(session.debounceTimer);
}
const responseDelayMs = resolveChatbotResponseDelayMs(context.chatbotConfig?.responseDelayMs);
session.debounceTimer = setTimeout(() => {
  session.debounceTimer = null;
  if (session.isProcessing) {
    session.flushAfterProcessing = true;
    return;
  }
  void this.processQueuedConversationTurn(session);
}, responseDelayMs);
```

**Key distinction:** `debounceTimer` is the *chatbot response delay* (default 10 seconds, configurable). It coalesces rapid client messages before sending to the LLM. The *inactivity timeout* (10 minutes, SESS-03) is a separate concern that does not yet exist as a formal timer — it is only detected reactively when the next message arrives (line 2694-2699, `sessionWillResetByInactivity` check). Plan 4.3 adds the proactive inactivity timer using BullMQ.

### humanTakeover current state

[VERIFIED: prisma/tenant.prisma lines 134-135]

`humanTakeover: Boolean @default(false)` and `humanTakeoverAt: DateTime?` already exist on the `Conversation` model in the tenant schema. The field IS already persisted to PostgreSQL. The current issue (SESS-06) is not that it is missing from the DB, but that there is no Redis fast-path check — every inbound message does a full Prisma query to check `humanTakeover` (lines 2242-2330). Plan 4.2 adds the Redis fast path: `session:{tenantId}:{instanceId}:{remoteJid}` hash with a `humanTakeover` field so the check is a single HGET.

---

## BullMQ Deduplication API Confirmation

[VERIFIED: api.docs.bullmq.io/types/v5.DeduplicationOptions.html]
[VERIFIED: docs.bullmq.io/guide/jobs/deduplication]
[VERIFIED: node_modules/.pnpm/lock.yaml — bullmq@5.71.0 installed]

### DeduplicationOptions type (v5)

```typescript
type DeduplicationOptions = {
  id: string;         // required — deduplication identifier
  ttl?: number;       // optional — TTL in milliseconds
  extend?: boolean;   // optional — "Extend ttl value"
  replace?: boolean;  // optional — "replace job record while it's in delayed state"
  keepLastIfActive?: boolean; // optional — keep last if job is currently processing
};
```

### Debounce pattern (the exact pattern Plan 4.3 must use)

```typescript
// Source: docs.bullmq.io/guide/jobs/deduplication — Debounce Mode
await sessionTimeoutQueue.add(
  'session-timeout',
  { sessionId, tenantId, instanceId, remoteJid },
  {
    deduplication: {
      id: `session-timeout:${sessionId}`,
      ttl: SESSION_TIMEOUT_MS,   // e.g. 10 * 60 * 1000 (10 minutes)
      extend: true,
      replace: true,
    },
    delay: SESSION_TIMEOUT_MS,
  }
);
```

**How it works:** When a new client message arrives, calling `queue.add()` with the same `deduplication.id` and `extend: true` resets the TTL and replaces the job data. The delayed job's execution time is pushed forward. If no new message arrives within `delay` ms, the job executes.

**O(1) guarantee:** No `Queue.remove()` + re-add dance needed. BullMQ handles deduplication at the Redis level with a single atomic operation.

**Cancellation:** To cancel the timeout when a session closes normally, use `queue.remove(deduplicationId)` or simply let the worker read current Redis state on execution — if state is `ENCERRADA`, the worker exits without sending the confirmation message.

---

## Architecture Patterns

### Plan 4.1 — ConversationSessionManager

**Recommended file:** `apps/api/src/modules/instances/conversation-session-manager.ts`

Follows the `AdminIdentityService` extraction pattern from Phase 3: a class with no external I/O dependencies that the orchestrator instantiates and holds.

```typescript
// apps/api/src/modules/instances/conversation-session-manager.ts
export class ConversationSessionManager {
  private readonly sessions = new Map<string, ConversationSession>();
  private gcInterval: NodeJS.Timeout | null = null;
  private readonly maxSessions: number;

  constructor(options?: { maxSessions?: number }) {
    this.maxSessions = options?.maxSessions ?? 500;
  }

  buildKey(instanceId: string, remoteJid: string): string { ... }
  get(key: string): ConversationSession | undefined { ... }
  getOrCreate(...): Promise<ConversationSession> { ... }
  clear(key: string): void { ... }  // clearTimeout + delete
  startGc(): void { ... }
  stopGc(): void { ... }
  clearAll(): void { ... }  // for close() — clears all timers
}
```

**Wire into InstanceOrchestrator:** `private readonly sessionManager = new ConversationSessionManager();`

**Invariant:** `InstanceOrchestrator` holds the only instance. No other class accesses the Map directly.

### Plan 4.2 — Redis Session Hash + ConversationSession Table

**Redis key pattern:** `session:{tenantId}:{instanceId}:{remoteJid}` (HSET/HGET)

Follows the `instance:{id}:admin_jid` pattern from Phase 3 (03-02). TTL of 24h set on state transition.

```typescript
// Set state
await redis.hset(`session:${tenantId}:${instanceId}:${remoteJid}`, {
  status: 'ATIVA',
  humanTakeover: '0',
  startedAt: new Date().toISOString(),
});
await redis.expire(`session:${tenantId}:${instanceId}:${remoteJid}`, 24 * 60 * 60);

// Fast-path check on inbound message
const sessionState = await redis.hgetall(`session:${tenantId}:${instanceId}:${remoteJid}`);
if (sessionState.humanTakeover === '1') { return; } // SESS-07
```

**ConversationSession table** (to be added via `buildTenantSchemaSql` ALTER TABLE pattern):

```sql
CREATE TABLE IF NOT EXISTS {schema}."ConversationSession" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL REFERENCES {schema}."Instance"("id") ON DELETE CASCADE,
  "contactId" TEXT,
  "remoteJid" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ATIVA',
  "humanTakeover" BOOLEAN NOT NULL DEFAULT FALSE,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "endedAt" TIMESTAMPTZ,
  "durationSeconds" INTEGER,
  "firstResponseMs" INTEGER,
  "handoffCount" INTEGER NOT NULL DEFAULT 0,
  "closedReason" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_{schema}_session_instance_started"
  ON {schema}."ConversationSession" ("instanceId", "startedAt");
CREATE INDEX IF NOT EXISTS "idx_{schema}_session_remote_jid"
  ON {schema}."ConversationSession" ("instanceId", "remoteJid");
```

**State enum (TypeScript, not DB enum — avoids ALTER TYPE complexity):**

```typescript
export const SessionStatus = {
  ATIVA: 'ATIVA',
  AGUARDANDO_CLIENTE: 'AGUARDANDO_CLIENTE',
  CONFIRMACAO_ENVIADA: 'CONFIRMACAO_ENVIADA',
  INATIVA: 'INATIVA',
  ENCERRADA: 'ENCERRADA',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];
```

### Plan 4.3 — SessionLifecycleService + BullMQ Timeout Queue

**Recommended files:**
- `apps/api/src/modules/instances/session-lifecycle.service.ts` — the state machine
- `apps/api/src/queues/session-timeout-queue.ts` — queue factory (follows `message-queue.ts` pattern)
- `apps/api/src/workers/session-timeout.worker.ts` — BullMQ Worker that processes jobs

**Queue factory (follows message-queue.ts pattern):**

```typescript
// apps/api/src/queues/session-timeout-queue.ts
import { Queue } from 'bullmq';
import type { Redis as IORedis } from 'ioredis';
import { QUEUE_NAMES } from './queue-names.js';

export const createSessionTimeoutQueue = (connection: IORedis): Queue =>
  new Queue(QUEUE_NAMES.SESSION_TIMEOUT, {
    connection: connection as never,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
```

**Add to QUEUE_NAMES:**

```typescript
export const QUEUE_NAMES = {
  SEND_MESSAGE: 'send-message',
  WEBHOOK_DISPATCH: 'webhook-dispatch',
  SESSION_TIMEOUT: 'session-timeout',   // NEW
} as const;
```

**Calling from SessionLifecycleService on each activity:**

```typescript
// Source: docs.bullmq.io/guide/jobs/deduplication
await this.sessionTimeoutQueue.add(
  'check-inactivity',
  { sessionId, tenantId, instanceId, remoteJid },
  {
    deduplication: {
      id: `session-timeout:${sessionId}`,
      ttl: this.timeoutMs,
      extend: true,
      replace: true,
    },
    delay: this.timeoutMs,
  }
);
```

**Worker logic (runs when timer fires):**

```typescript
// Session timeout worker
const state = await redis.hgetall(`session:${tenantId}:${instanceId}:${remoteJid}`);
if (!state || state.status === 'ENCERRADA' || state.status === 'INATIVA') {
  return; // Client already responded or session already closed
}
if (state.status === 'CONFIRMACAO_ENVIADA') {
  // Second timeout — mark INATIVA
  await transitionSession(tenantId, instanceId, remoteJid, 'INATIVA', 'timeout_no_response');
  return;
}
// First timeout — send confirmation message, transition to CONFIRMACAO_ENVIADA
await transitionSession(tenantId, instanceId, remoteJid, 'CONFIRMACAO_ENVIADA', null);
await sendAutomatedMessage(tenantId, instanceId, remoteJid, confirmationMessage);
// Re-enqueue with a fresh TTL for the second timeout window
await sessionTimeoutQueue.add('check-inactivity', jobData, {
  deduplication: {
    id: `session-timeout:${sessionId}`,
    ttl: SECOND_TIMEOUT_MS,
    extend: true,
    replace: true,
  },
  delay: SECOND_TIMEOUT_MS,
});
```

**BullMQ Worker pattern (follows MessageService exactly):**

```typescript
// Inside SessionLifecycleService constructor
if (this.config.NODE_ENV !== 'test') {
  this.workerConnection = deps.redis.duplicate(); // separate connection required
  this.timeoutWorker = new BullWorker<SessionTimeoutJobPayload>(
    QUEUE_NAMES.SESSION_TIMEOUT,
    async (job) => this.processTimeoutJob(job),
    { autorun: true, connection: this.workerConnection as never, concurrency: 10 }
  );
}
// In close():
await this.timeoutWorker?.close();
if (this.ownsWorkerConnection) await this.workerConnection.quit();
```

[VERIFIED: apps/api/src/modules/messages/service.ts lines 67-78 — exact pattern]

**Feature flag:** `SESSION_LIFECYCLE_V2=true` environment variable. When false, the old in-process debounce is the only mechanism (no BullMQ timeout). When true, BullMQ handles inactivity; debounce timer still handles chatbot response coalescing.

### Plan 4.4 — InstanceEventBus

**Recommended file:** `apps/api/src/lib/instance-events.ts`

Uses Node.js built-in `EventEmitter` with TypeScript type narrowing — no additional library needed. The pattern follows the existing `logEmitter` and `qrEmitter` already in `InstanceOrchestrator`.

```typescript
// apps/api/src/lib/instance-events.ts
import { EventEmitter } from 'node:events';

export interface SessionActivityEvent {
  type: 'session.activity';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
}

export interface SessionCloseIntentEvent {
  type: 'session.close_intent_detected';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  intentLabel: string;
}

export interface AdminCommandEvent {
  type: 'admin.command';
  tenantId: string;
  instanceId: string;
  command: string;
}

export type InstanceDomainEvent =
  | SessionActivityEvent
  | SessionCloseIntentEvent
  | AdminCommandEvent;

export class InstanceEventBus extends EventEmitter {
  emit(event: InstanceDomainEvent['type'], payload: InstanceDomainEvent): boolean {
    return super.emit(event, payload);
  }
  on(event: InstanceDomainEvent['type'], listener: (payload: InstanceDomainEvent) => void): this {
    return super.on(event, listener);
  }
}
```

**Wiring in app.ts:** `InstanceEventBus` is instantiated once in `buildApp()` and passed to `InstanceOrchestrator`, `SessionLifecycleService`, and in Phase 6 to `SessionMetricsCollector`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Distributed timer deduplication | `clearTimeout` + `Map.set` custom logic | BullMQ `deduplication.extend: true` | setTimeout does not survive process restart; BullMQ timers persist in Redis |
| Session state storage | Custom Redis string encoding | Redis HSET with named fields | HGETALL returns typed fields; HSET is atomic |
| Typed EventEmitter | Generic `EventEmitter` with untyped `emit(string, any)` | Subclass with typed `emit`/`on` overloads | TypeScript catches wrong payload shapes at compile time |
| State enum in PostgreSQL | ALTER TYPE with new enum values | String column with TypeScript const enum | Adding enum values to PG requires unsafe migrations; string column is simpler |

---

## Migration System Status — CRITICAL

[VERIFIED: code inspection — `apps/api/src/lib/run-migrations.ts` does not exist]
[VERIFIED: 02-00-SUMMARY.md — Plans 02-01 through 02-04 were scaffolded but never implemented]

**Finding:** The `runMigrations()` infrastructure described in Plan 2.4 was never built. Only the Wave 0 RED test stubs exist. The `schema_migrations` table does not exist in any tenant schema.

**Impact on Plan 4.2:** Do NOT add `ConversationSession` via a `runMigrations()` call. Instead, use the existing pattern in `buildTenantSchemaSql()`:

1. Add the `CREATE TABLE IF NOT EXISTS ... "ConversationSession"` block to `buildTenantSchemaSql()` in `tenant-schema.ts`.
2. Add the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` idempotency guards for each column (the existing pattern at lines 133-143).
3. `TenantPrismaRegistry.ensureSchema()` already calls `buildTenantSchemaSql()` on first tenant access — no other wiring needed.

This is the same approach used for `Conversation.humanTakeover` (already in tenant-schema.ts line 136) and all other incremental columns.

---

## Common Pitfalls

### Pitfall 1: Two Timeout Concepts Conflated

**What goes wrong:** Confusing the *chatbot response delay* (`debounceTimer`, default 10s, coalesces rapid messages before LLM call) with the *inactivity timeout* (10 minutes, SESS-03). They are different timers with different purposes.
**Why it happens:** Both are implemented with `setTimeout` today.
**How to avoid:** Keep `debounceTimer` in `ConversationSessionManager` (Plan 4.1). Add the BullMQ inactivity timer separately in `SessionLifecycleService` (Plan 4.3). Never use BullMQ for response coalescing — it is too slow for 10-second debounce with sub-second message bursts.
**Warning signs:** If tests show the confirmation message fires on every message rather than after silence, the timers are conflated.

### Pitfall 2: BullMQ Worker Uses Different Redis Connection Instance

**What goes wrong:** BullMQ requires `maxRetriesPerRequest: null` on the Redis connection. The existing `createRedis()` already sets this. If a separate Redis connection is created for the Worker without this option, BullMQ throws at startup.
**Why it happens:** Developers create `new IORedis(url)` directly instead of using `createRedis(config)`.
**How to avoid:** Always pass the connection from `createRedis(config)` or a new instance created with identical options. Never pass the same IORedis instance to both a Queue and a Worker (BullMQ requires separate connections per role in some versions).
**Warning signs:** `ECONNRESET` or `ERR_UNHANDLED_REDIS_COMMAND` errors on Worker startup.

### Pitfall 3: deduplication.id Must Be Globally Unique Across All Queues

**What goes wrong:** Using a short `sessionId` as `deduplication.id` collides if the same ID is used in a different queue.
**Why it happens:** Deduplication IDs are stored in a shared Redis keyspace.
**How to avoid:** Always prefix with the queue name: `session-timeout:${tenantId}:${instanceId}:${remoteJid}`.

### Pitfall 4: Redis HSET vs SET for Session State

**What goes wrong:** Using `redis.set(key, JSON.stringify(state))` means reading a full JSON blob on every fast-path check.
**Why it happens:** Simpler to serialize.
**How to avoid:** Use `redis.hset(key, { status, humanTakeover, startedAt })` and `redis.hget(key, 'humanTakeover')` for single-field reads. Only `hgetall` when you need the full state. Follow the Phase 3 pattern where `instance:{id}:admin_jid` is a simple SET — but session state has multiple fields, so HSET is correct here.

### Pitfall 5: Plan 4.1 Must Not Change Behavior

**What goes wrong:** During the extraction to `ConversationSessionManager`, a field initialization or condition is subtly changed, breaking debounce coalescing or GC.
**Why it happens:** Moving code across class boundaries tempts rewrites.
**How to avoid:** Extract with a mechanical copy-paste first (no rewrites). Run the full test suite after each extraction commit. The plan explicitly says "no behavioral change — pure reorganization."
**Warning signs:** Chatbot starts responding before `responseDelayMs` elapses, or GC starts firing on active sessions.

### Pitfall 6: Worker Must Handle Missing Session State Gracefully

**What goes wrong:** If the API restarts after enqueuing a timeout job but before creating the Redis session hash, the worker fires and finds `null` from `hgetall`.
**Why it happens:** Race between job enqueue and Redis write.
**How to avoid:** Worker checks `if (!state || !state.status)` and exits silently. The worst case is a missed inactivity message, which is safe (conservative).

### Pitfall 7: ConversationSession Table vs Conversation Table

**What goes wrong:** Confusing `Conversation` (existing — one per contact/instance, tracks CRM state, humanTakeover) with `ConversationSession` (new — one per session window, tracks lifecycle timing). They are related but distinct.
**Why it happens:** Same domain vocabulary.
**How to avoid:** `Conversation` is the CRM entity (contact relationship). `ConversationSession` is a timed window record (metrics/lifecycle). `ConversationSession` may reference `Conversation.id` as a nullable foreign key for Phase 6 metrics joins.

### Pitfall 8: Feature Flag Scope

**What goes wrong:** `SESSION_LIFECYCLE_V2=true` is set in production before staging validates that the 10-minute timeout fires exactly once and does not double-send.
**Why it happens:** Eager production deployment.
**How to avoid:** Test in staging with `SESSION_LIFECYCLE_V2=true` and `SESSION_TIMEOUT_MS=120000` (2 minutes). Verify: one confirmation message after 2 minutes silence, one INATIVA transition after 4 minutes total silence. Only then deploy to production with `SESSION_TIMEOUT_MS=600000`.

---

## Integration Points with Phase 3 Artifacts

### AdminIdentityService

`SessionLifecycleService` does NOT need `AdminIdentityService` directly. The orchestrator already resolves `isAdminOrInstanceSender` before calling the session service. Session state is only tracked for non-admin conversations. The session service receives `isAdmin: boolean` as a parameter and is a no-op when `true`.

### Redis JID Cache Pattern (03-02)

Phase 3 established: `SET instance:{id}:admin_jid {jid}` with no TTL (connection-lifecycle managed).

Phase 4 extends this with: `HSET session:{tenantId}:{instanceId}:{remoteJid} status ATIVA humanTakeover 0` with 24h TTL.

Both keys use the same `IORedis` instance injected into the orchestrator. No new Redis connection is needed.

### Pino Logger (03-04)

All new services must use `this.logger` (pino child logger with `component` label). No `console.log` anywhere. Pattern from Phase 3:

```typescript
// Correct pattern (established in 03-04)
this.logger = logger.child({ component: 'SessionLifecycleService' });
this.logger.info({ sessionId, status }, '[session] state transition');
```

---

## Recommended Project Structure (new files only)

```
apps/api/src/
├── modules/instances/
│   ├── conversation-session-manager.ts     # Plan 4.1 extraction
│   ├── session-lifecycle.service.ts        # Plan 4.3 state machine
│   └── __tests__/
│       ├── conversation-session-manager.test.ts  # Plan 4.1 unit tests
│       └── session-lifecycle.service.test.ts     # Plan 4.3 unit tests
├── queues/
│   ├── queue-names.ts                      # +SESSION_TIMEOUT
│   └── session-timeout-queue.ts            # Plan 4.3 queue factory
├── workers/
│   └── session-timeout.worker.ts           # Plan 4.3 BullMQ Worker
└── lib/
    └── instance-events.ts                  # Plan 4.4 typed EventEmitter
```

---

## Schema / Migration Concerns

### Tenant Schema (tenant.prisma + tenant-schema.ts)

The `ConversationSession` table does not exist in either `prisma/tenant.prisma` or `apps/api/src/lib/tenant-schema.ts`.

**Plan 4.2 must do three things:**

1. Add the model to `prisma/tenant.prisma` (for type generation and documentation).
2. Add the raw SQL block to `buildTenantSchemaSql()` in `tenant-schema.ts` (for runtime provisioning).
3. Add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` guards for each column (idempotency for existing schemas).

**Do NOT add `humanTakeover` to the new `ConversationSession` table from the `Conversation` table.** `Conversation.humanTakeover` stays on `Conversation` (it controls the CRM bot-block behavior). `ConversationSession.humanTakeover` would be redundant — use the Redis hash `humanTakeover` field for the fast path and `Conversation.humanTakeover` for the durable record. Keep them separate.

### Platform Schema (schema.prisma)

No changes needed. Session lifecycle is a per-tenant concern.

### Prisma Client Regeneration

After adding `ConversationSession` to `prisma/tenant.prisma`, run:

```bash
pnpm --filter @infracode/api prisma:generate
```

---

## Environment Availability

Step 2.6: SKIPPED (no new external dependencies — all required services already running: Redis via `createRedis()`, PostgreSQL via `TenantPrismaRegistry`, BullMQ already installed and wired).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^3.2.4 |
| Config file | none — runs via `vitest run` in apps/api |
| Quick run command | `pnpm --filter @infracode/api exec vitest run --reporter=verbose` |
| Full suite command | `pnpm --filter @infracode/api exec vitest run` |
| Note | Run from repo root or apps/api; repo root `pnpm vitest` does NOT work (03-00-SUMMARY.md) |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SESS-01 | SessionStatus enum values are correct | unit | `vitest run conversation-session-manager` | Wave 0 |
| SESS-02 | Redis HSET written on session open; HGETALL returns correct status | unit (mock redis) | `vitest run session-lifecycle.service` | Wave 0 |
| SESS-03 | BullMQ job enqueued with correct delay on activity | unit (mock queue) | `vitest run session-lifecycle.service` | Wave 0 |
| SESS-04 | deduplication.extend:true resets timer (mock queue spy) | unit | `vitest run session-lifecycle.service` | Wave 0 |
| SESS-05 | ATIVA → CONFIRMACAO_ENVIADA transition sends message; ENCERRADA not set directly | unit | `vitest run session-lifecycle.service` | Wave 0 |
| SESS-06 | ConversationSession table insert includes humanTakeover=false | integration | `vitest run session-lifecycle.service` | Wave 0 |
| SESS-07 | When Redis humanTakeover=1, session service returns early without processing | unit | `vitest run session-lifecycle.service` | Wave 0 |
| SESS-08 | ConversationSession.endedAt set on close; durationSeconds calculated correctly | unit | `vitest run session-lifecycle.service` | Wave 0 |
| SESS-09 | Closure keyword list triggers CONFIRMACAO_ENVIADA | unit | `vitest run session-lifecycle.service` | Wave 0 |

### Wave 0 Gaps (test files to create before implementation)

- [ ] `apps/api/src/modules/instances/__tests__/conversation-session-manager.test.ts` — Plan 4.1 unit tests (RED stubs)
- [ ] `apps/api/src/modules/instances/__tests__/session-lifecycle.service.test.ts` — Plans 4.2 + 4.3 unit tests (RED stubs)
- [ ] `apps/api/src/lib/__tests__/instance-events.test.ts` — Plan 4.4 event emission tests (RED stubs)

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | session here is a chatbot conversation, not a user session |
| V3 Session Management | no | same — not a web session |
| V4 Access Control | yes | humanTakeover flag must be writable only by admin commands or authenticated API routes |
| V5 Input Validation | yes | sessionId and remoteJid used as Redis key components — must not allow key injection |
| V6 Cryptography | no | session state does not contain secrets |

### Threat Patterns for Redis Key Construction

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Redis key injection via malformed remoteJid | Tampering | Validate remoteJid format before using as key component — only allow `@s.whatsapp.net` and `@g.us` suffixes |
| humanTakeover flag flipped by client-side manipulation | Elevation of Privilege | humanTakeover writes only from admin-authenticated code paths; never from inbound message processing |
| Stale ENCERRADA session reactivated via Redis TTL expiry | Spoofing | On TTL expiry, session state becomes null — `hgetall` returns empty; treat null as "no session" not as "ATIVA" |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 2 plans 02-01 through 02-04 were not completed; `run-migrations.ts` does not exist | Migration System Status | If wrong, Plan 4.2 should use the migration system instead of ALTER TABLE pattern — but direct file check confirms absence |
| A2 | `deduplication.extend: true` resets the delay clock (not just the TTL) | BullMQ API | If extend only resets TTL and not delay, the job may fire before the full inactivity window — must validate in staging |
| A3 | ~~BullMQ Worker for session-timeout should be registered similarly to sendMessageQueue worker~~ | RESOLVED | Worker pattern verified: MessageService owns BullWorker, uses redis.duplicate(), registered via app.ts constructor injection |

---

## Open Questions

1. **BullMQ Worker pattern — RESOLVED**
   - What we found: `MessageService` registers a `BullWorker` in its constructor using `redis.duplicate()` for the worker connection (apps/api/src/modules/messages/service.ts line 70). The worker runs in the same process as the API server.
   - Pattern: The service that owns the worker also creates and holds it. Worker connection uses `deps.redis.duplicate()` so Queue and Worker have separate connections (required by BullMQ).
   - Recommendation for Plan 4.3: `SessionLifecycleService` should own the `BullWorker` instance, create `redis.duplicate()` for the worker connection, and register it in `buildApp()` / `app.ts` alongside `MessageService`.

2. **Should ConversationSession reference Conversation.id?**
   - What we know: Both `Conversation` and `ConversationSession` are per-JID records. Phase 6 metrics will join them.
   - What's unclear: Is a FK from `ConversationSession.conversationId → Conversation.id` useful enough to add now?
   - Recommendation: Add `"conversationId" TEXT REFERENCES {schema}."Conversation"("id") ON DELETE SET NULL` as a nullable column. Cost: one extra lookup at session open. Benefit: Phase 6 metrics queries are O(1) joins.

3. **What is the second timeout window for CONFIRMACAO_ENVIADA → INATIVA?**
   - What we know: SESS-03 says 10 minutes for the first timeout. SESS-05 says "always confirm before closing."
   - What's unclear: After sending the confirmation message, how long to wait for a reply before marking INATIVA?
   - Recommendation: Default to the same 10-minute window (same BullMQ delay). Make it configurable via the same `sessaoInatividadeModule` config.

---

## Sources

### Primary (HIGH confidence)

- Direct code inspection: `apps/api/src/modules/instances/service.ts` — lines 205-213, 267, 341-353, 356-368, 3370-3392, 3592-3690, 3741-3825
- Direct code inspection: `apps/api/src/lib/tenant-schema.ts` — migration pattern, Conversation table, existing ALTER TABLE guards
- Direct code inspection: `prisma/tenant.prisma` — Conversation model with humanTakeover field (lines 134-135)
- Direct code inspection: `apps/api/package.json` — bullmq ^5.58.5
- Direct code inspection: `node_modules/.pnpm/lock.yaml` — bullmq@5.71.0 resolved
- `api.docs.bullmq.io/types/v5.DeduplicationOptions.html` — DeduplicationOptions type fields verified
- `docs.bullmq.io/guide/jobs/deduplication` — debounce mode pattern with `extend: true` and `replace: true` verified

### Secondary (MEDIUM confidence)

- Phase 3 SUMMARYs (03-01, 03-02, 03-04) — Redis key pattern, AdminIdentityService extraction model, Pino logger pattern

### Tertiary (LOW confidence)

None — all major claims verified.

### Additional Verified (added post-initial-draft)

- Direct code inspection: `apps/api/src/modules/messages/service.ts` lines 67-78 — BullMQ Worker registration pattern: `redis.duplicate()` + Worker in service constructor, registered via `buildApp()` in `app.ts`

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified from package.json and lock file
- Architecture patterns: HIGH — based on direct code inspection and Phase 3 precedent
- BullMQ deduplication API: HIGH — verified from official docs and type definitions
- Migration approach: HIGH — confirmed from direct inspection that run-migrations does not exist
- Worker wiring location: LOW — not found in inspected scope

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (BullMQ API is stable; codebase changes invalidate sooner)
