---
phase: 04-session-lifecycle-formalization
reviewed: 2026-04-15T00:00:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - apps/api/src/app.ts
  - apps/api/src/lib/instance-events.ts
  - apps/api/src/lib/session-intents.ts
  - apps/api/src/lib/tenant-schema.ts
  - apps/api/src/modules/instances/__tests__/conversation-session-manager.test.ts
  - apps/api/src/modules/instances/__tests__/instance-eventbus-wiring.test.ts
  - apps/api/src/modules/instances/__tests__/session-lifecycle.service.test.ts
  - apps/api/src/modules/instances/__tests__/session-state.service.test.ts
  - apps/api/src/modules/instances/conversation-session-manager.ts
  - apps/api/src/modules/instances/service.ts
  - apps/api/src/modules/instances/session-lifecycle.service.ts
  - apps/api/src/modules/instances/session-state.service.ts
  - apps/api/src/queues/queue-names.ts
  - apps/api/src/queues/session-timeout-queue.ts
  - apps/api/src/workers/session-timeout.worker.ts
  - prisma/tenant.prisma
findings:
  critical: 1
  warning: 4
  info: 5
  total: 10
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-04-15T00:00:00Z
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Summary

This phase introduces a formal session lifecycle subsystem: `SessionStateService` (Redis + Postgres dual-write), `SessionLifecycleService` (BullMQ timeout state machine), `InstanceEventBus` (typed in-process event bus), and domain event wiring in `InstanceOrchestrator`. The overall architecture is sound — the feature flag, humanTakeover short-circuit, and state machine no-ops for already-closed sessions are all correctly designed and tested.

One critical bug was found: the `SessionLifecycleService` constructor has an early `return` for `NODE_ENV=test` that also silently skips registering the `InstanceEventBus` listeners, meaning the `session.activity` and `session.close_intent_detected` subscriptions are never attached in the test environment and all tests exercising that wiring will never fire those listeners. Four warnings cover: the second-window timeout job never being scheduled, a silent Postgres skip when `sessionId` is null after Redis TTL expiry, an unguarded state transition in the close-intent handler, and an unguarded `parseInt` that can produce `NaN` for the BullMQ delay. Five info items cover console usage, duplicated interface definitions, missing Fastify decorators, schema drift in tenant.prisma, and a misleading test factory.

---

## Critical Issues

### CR-01: EventBus listeners skipped entirely when `NODE_ENV=test` due to early `return` in constructor

**File:** `apps/api/src/modules/instances/session-lifecycle.service.ts:66-119`

**Issue:** The constructor guard for the test environment (line 66–70) calls `return` immediately after setting `this.workerConnection` and `this.ownsWorkerConnection`. The comment says "In test env: reuse the provided Redis connection (no duplicate needed)" — the intent is only to skip spinning up the `BullWorker`. However, the `return` exits the constructor entirely, which also skips the `InstanceEventBus` subscription block at lines 95–119. Consequences:

1. In production (non-test), the worker is created **and** the event bus listeners are registered — correct.
2. In `NODE_ENV=test`, the event bus listeners are **never** registered, even if `deps.eventBus` is passed in. Tests that construct `SessionLifecycleService` with a real `InstanceEventBus` and then emit events to it will not trigger `recordActivity` or the `CONFIRMACAO_ENVIADA` transition.
3. The `session-lifecycle.service.test.ts` tests do not exercise the event bus path at all (they call `svc.recordActivity()` and `svc.processTimeoutJob()` directly), so this bug is not caught by the existing test suite.

**Fix:** Move the event bus subscription block outside the `NODE_ENV=test` early-return branch so it always executes:

```typescript
constructor(private readonly deps: SessionLifecycleServiceDeps) {
  this.logger = deps.logger.child({ component: "SessionLifecycleService" });
  this.enabled = deps.config.SESSION_LIFECYCLE_V2 === "true";
  this.timeoutMs = deps.config.SESSION_TIMEOUT_MS
    ? parseInt(deps.config.SESSION_TIMEOUT_MS, 10)
    : DEFAULT_TIMEOUT_MS;
  this.secondTimeoutMs = DEFAULT_SECOND_TIMEOUT_MS;

  if (deps.config.NODE_ENV === "test") {
    // Test env: reuse the provided Redis connection (no duplicate needed).
    // Do NOT return here — fall through to register event bus listeners below.
    this.workerConnection = deps.redis;
    this.ownsWorkerConnection = false;
  } else {
    this.workerConnection = deps.redis.duplicate();
    this.ownsWorkerConnection = true;

    if (this.enabled) {
      const processor = createSessionTimeoutProcessor({
        sessionStateService: deps.sessionStateService,
        instanceOrchestrator: deps.instanceOrchestrator,
        secondTimeoutMs: this.secondTimeoutMs,
        logger: this.logger,
      });
      this.timeoutWorker = new BullWorker<SessionTimeoutJobPayload>(
        QUEUE_NAMES.SESSION_TIMEOUT,
        processor,
        { autorun: true, connection: this.workerConnection as never, concurrency: 10 }
      );
    }
  }

  // Event bus subscriptions always registered regardless of NODE_ENV
  if (deps.eventBus) {
    deps.eventBus.on('session.activity', async (event) => {
      if (event.type !== 'session.activity') return;
      await this.recordActivity({ ... }).catch(err => ...);
    });
    deps.eventBus.on('session.close_intent_detected', async (event) => {
      if (event.type !== 'session.close_intent_detected') return;
      ...
    });
  }
}
```

---

## Warnings

### WR-01: `scheduleSecondTimeout` is defined but never called — second-window timeout silently never fires

**File:** `apps/api/src/modules/instances/session-lifecycle.service.ts:223-240` and `apps/api/src/workers/session-timeout.worker.ts:73`

**Issue:** After the first timeout fires (`ATIVA → CONFIRMACAO_ENVIADA` + confirmation message sent), the worker's comment on line 73 says the second-window job "is handled by `SessionLifecycleService.scheduleSecondTimeout()`". However, `scheduleSecondTimeout` is never invoked from `processTimeoutJob`, from the worker processor, or anywhere else in the reviewed codebase. Without this call, sessions stuck in `CONFIRMACAO_ENVIADA` remain open forever — the second state-machine transition (`CONFIRMACAO_ENVIADA → closeSession`) exists in the code but can never be reached unless the client sends another message that happens to reset the timer. This makes the two-window design non-functional.

**Fix:** Call `scheduleSecondTimeout` at the end of the first-timeout branch in `processTimeoutJob`:

```typescript
// In SessionLifecycleService.processTimeoutJob — first timeout branch:
await this.deps.sessionStateService.updateStatus(
  tenantId, instanceId, remoteJid, SessionStatus.CONFIRMACAO_ENVIADA
);
try {
  await this.deps.instanceOrchestrator.sendSessionMessage(
    tenantId, instanceId, remoteJid,
    "Ainda deseja continuar o atendimento? Se não houver resposta, encerraremos em breve."
  );
} catch (err) {
  logger.warn({ err, sessionId }, "[lifecycle] failed to send confirmation message — continuing");
}
// ADD: schedule the fixed second-window job
await this.scheduleSecondTimeout({ sessionId, tenantId, instanceId, remoteJid });
```

The worker processor (`session-timeout.worker.ts`) also needs access to `scheduleSecondTimeout` or must delegate back to `SessionLifecycleService`. The cleanest approach is having the worker call `processTimeoutJob` on the injected `SessionLifecycleService` instance rather than reimplementing the state machine independently (see WR-04 below).

---

### WR-02: `closeSession` silently skips the Postgres UPDATE when `sessionId` is null after Redis TTL expiry

**File:** `apps/api/src/modules/instances/session-state.service.ts:205-217`

**Issue:** `closeSession` reads `sessionId` from the Redis hash (`hash?.sessionId ?? null`). If the 24-hour Redis TTL has elapsed (or the key was never written — e.g., for sessions created before this phase was deployed), `sessionId` will be `null` and the entire `UPDATE ConversationSession` is silently skipped via the `if (sessionId)` guard. The session record in Postgres is left permanently open with no `endedAt`, `durationSeconds`, or `closedReason`. There is no warning log at this code path, so the silent skip is invisible in production monitoring.

**Fix:** Add a warning log when the Postgres update is skipped:

```typescript
if (sessionId) {
  const prisma = await this.deps.tenantPrismaRegistry.getClient(tenantId);
  await prisma.$executeRawUnsafe(`UPDATE "ConversationSession" ...`, ...);
} else {
  this.logger.warn(
    { instanceId, remoteJid, closedReason },
    "[session] closeSession: sessionId missing from Redis — Postgres record NOT updated (TTL expired or pre-migration session)"
  );
}
```

---

### WR-03: `close_intent_detected` event handler transitions to `CONFIRMACAO_ENVIADA` without first reading current state

**File:** `apps/api/src/modules/instances/session-lifecycle.service.ts:108-118`

**Issue:** The `session.close_intent_detected` listener calls `updateStatus(..., SessionStatus.CONFIRMACAO_ENVIADA)` unconditionally (only catching errors). If the session is already `ENCERRADA`, `INATIVA`, or `CONFIRMACAO_ENVIADA` at the time the event arrives, the status is overwritten anyway. This can reopen a closed session or create a duplicate `CONFIRMACAO_ENVIADA` state. The `processTimeoutJob` path correctly reads state before acting (lines 177-184), but this parallel path does not.

**Fix:** Read the current state before updating, mirroring the pattern in `processTimeoutJob`:

```typescript
deps.eventBus.on('session.close_intent_detected', async (event) => {
  if (event.type !== 'session.close_intent_detected') return;
  const state = await this.deps.sessionStateService
    .getSessionState(event.tenantId, event.instanceId, event.remoteJid)
    .catch(() => null);
  if (
    !state ||
    state.status === SessionStatus.ENCERRADA ||
    state.status === SessionStatus.INATIVA ||
    state.status === SessionStatus.CONFIRMACAO_ENVIADA
  ) {
    this.logger.debug({ sessionId: event.sessionId }, '[lifecycle] close intent: session not in ATIVA state — skip');
    return;
  }
  this.logger.info(
    { sessionId: event.sessionId, intentLabel: event.intentLabel },
    '[lifecycle] close intent detected — transitioning to CONFIRMACAO_ENVIADA'
  );
  await this.deps.sessionStateService
    .updateStatus(event.tenantId, event.instanceId, event.remoteJid, SessionStatus.CONFIRMACAO_ENVIADA)
    .catch(err => this.logger.error({ err }, '[lifecycle] error handling close_intent_detected'));
});
```

---

### WR-04: `parseInt` on `SESSION_TIMEOUT_MS` has no `NaN` guard — misconfiguration fires timeout immediately

**File:** `apps/api/src/modules/instances/session-lifecycle.service.ts:60-62`

**Issue:** `parseInt(deps.config.SESSION_TIMEOUT_MS, 10)` returns `NaN` when the env var is set to a non-numeric value (e.g. `""`, `"disabled"`, `"10m"`). `NaN` is then stored as `this.timeoutMs` and passed directly to `queue.add` as both `delay` and `deduplication.ttl`. BullMQ coerces `NaN` delay to `0`, causing the inactivity check to fire immediately on every client message rather than after 10 minutes. There is no runtime warning of the misconfiguration.

**Fix:**

```typescript
const parsed = parseInt(deps.config.SESSION_TIMEOUT_MS ?? "", 10);
this.timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
```

---

## Info

### IN-01: `PendingConversationTurnContext` interface duplicated in two files

**Files:** `apps/api/src/modules/instances/conversation-session-manager.ts:24-50` and `apps/api/src/modules/instances/service.ts:180-206`

**Issue:** An identical `PendingConversationTurnContext` interface (same fields, same types) is defined privately in both files. `service.ts` assigns values of its own version to `session.pendingContext`, which is typed using the `conversation-session-manager.ts` version. This works only through structural compatibility. If either definition drifts, the mismatch produces a confusing type error far from the source.

**Fix:** Export `PendingConversationTurnContext` from `conversation-session-manager.ts` and import it into `service.ts`.

---

### IN-02: `console.log` / `console.debug` / `console.warn` used inside `ConversationSessionManager`

**File:** `apps/api/src/modules/instances/conversation-session-manager.ts:148`, `182`, `249`, `301`, `305`

**Issue:** `ConversationSessionManager` uses bare `console.*` calls in five places (GC eviction, inactivity resets, LRU eviction). The rest of the codebase uses pino structured logging. These calls bypass log level filtering, structured metadata, and centralized log routing.

**Fix:** Accept an optional `pino.Logger` in `ConversationSessionManagerOptions` (defaults to a no-op in tests) and replace `console.*` with `this.logger.info/debug/warn`.

---

### IN-03: `sessionStateService` and `sessionLifecycleService` are not registered as Fastify decorators

**File:** `apps/api/src/app.ts:194-207`

**Issue:** Both services are constructed at application startup but never passed to `app.decorate(...)`. All comparable services (`instanceOrchestrator`, `messageService`, `webhookService`, etc.) are decorated. If a route handler needs to call `sessionStateService.setHumanTakeover` (e.g., a future REST endpoint for human takeover), there is no clean path to access it.

**Fix:** Either decorate both services now for consistency, or add a comment explicitly noting they are intentionally kept internal (accessible only through `InstanceOrchestrator` and the event bus).

---

### IN-04: `prisma/tenant.prisma` `ConversationSession` model has no `@@index` on `(instanceId, remoteJid)` and no `@relation`

**File:** `prisma/tenant.prisma:270-285`

**Issue:** The `tenant-schema.ts` DDL (lines 283-287) creates two indexes on `ConversationSession`: `(instanceId, startedAt)` and `(instanceId, remoteJid)`. The Prisma model declares neither `@@index` annotation nor an `Instance @relation`. The model and the DDL are diverged: Prisma will not know about these indexes when generating query plans, and there is no back-relation from `Instance` to `ConversationSession`.

**Fix:**

```prisma
model Instance {
  ...
  conversationSessions ConversationSession[]
}

model ConversationSession {
  ...
  instance Instance @relation(fields: [instanceId], references: [id], onDelete: Cascade)

  @@index([instanceId, startedAt])
  @@index([instanceId, remoteJid])
}
```

---

### IN-05: Test factory `makeInstance` adds fields not present in the actual `Instance` Prisma model

**File:** `apps/api/src/modules/instances/__tests__/instance-eventbus-wiring.test.ts:146-163`

**Issue:** `makeInstance` includes `tenantId`, `isEnabled`, `chatbotEnabled`, `autoStart`, and `aiBlocked`, none of which exist in `prisma/tenant.prisma`'s `Instance` model. The factory casts with `as unknown as Instance`, silently masking the discrepancy. If `handleInboundMessage` ever reads these fields they will be `undefined` in tests while having real values in production, producing false-green test coverage.

**Fix:** Remove the extra fields from `makeInstance` to match the actual model, and add a comment if any fields are intentional stubs for future model additions.

---

_Reviewed: 2026-04-15T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
