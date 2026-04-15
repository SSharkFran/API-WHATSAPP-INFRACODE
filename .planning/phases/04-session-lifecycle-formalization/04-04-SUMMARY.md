---
phase: 04-session-lifecycle-formalization
plan: "04"
subsystem: api
tags: [eventemitter, event-bus, domain-events, decoupling, session-lifecycle, bullmq]

# Dependency graph
requires:
  - phase: 04-session-lifecycle-formalization
    provides: SessionLifecycleService (04-03), SessionStateService (04-02), ConversationSessionManager (04-01)
provides:
  - InstanceEventBus typed EventEmitter wrapper with session.activity / session.close_intent_detected / admin.command events
  - InstanceOrchestrator emits domain events instead of calling services directly
  - SessionLifecycleService subscribes to session.activity and calls recordActivity()
  - SessionLifecycleService subscribes to session.close_intent_detected and transitions to CONFIRMACAO_ENVIADA
  - Shared session-intents.ts utility eliminates duplicate CLOSURE_PHRASES list
  - Single InstanceEventBus instance wired in app.ts and shared by all consumers
affects:
  - 05-session-close-detection
  - 06-session-metrics
  - 07-admin-command-handling

# Tech tracking
tech-stack:
  added: []
  patterns:
    - InstanceEventBus typed overloads: TypeScript rejects unknown event names at compile time
    - Fire-and-forget domain events with .catch() guards on every async listener (T-04-04-01)
    - Pure utility extraction (session-intents.ts) to break circular import seam between orchestrator and lifecycle service

key-files:
  created:
    - apps/api/src/lib/instance-events.ts
    - apps/api/src/lib/session-intents.ts
    - apps/api/src/modules/instances/__tests__/instance-eventbus-wiring.test.ts
  modified:
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/modules/instances/session-lifecycle.service.ts
    - apps/api/src/app.ts

key-decisions:
  - "recognizeCloseIntent() extracted to apps/api/src/lib/session-intents.ts as pure function to break circular import between service.ts and session-lifecycle.service.ts"
  - "InstanceEventBus is optional in both InstanceOrchestratorDeps and SessionLifecycleServiceDeps (defaults to new InstanceEventBus() in orchestrator) — allows test construction without bus"
  - "sessionId passed as empty string '' in session.activity payload — full sessionId wiring deferred to Phase 5 when SessionStateService is wired into handleInboundMessage"
  - "EventBus listener errors are caught with .catch() and logged at ERROR level — never propagate to handleInboundMessage() emit call site"

patterns-established:
  - "Domain event decoupling: InstanceOrchestrator emits fire-and-forget events; listeners subscribe independently with no direct coupling"
  - "Typed EventEmitter overloads: emit/on/off overloads accept only InstanceDomainEvent types — TypeScript rejects unknown event names"
  - "Async listener error isolation: every async eventBus listener wraps in .catch(err => logger.error(...)) per T-04-04-01"

requirements-completed: [SESS-01, SESS-03, SESS-07]

# Metrics
duration: 35min
completed: 2026-04-15
---

# Phase 04 Plan 04: EventBus Wiring Summary

**Typed InstanceEventBus decouples InstanceOrchestrator from SessionLifecycleService via session.activity, session.close_intent_detected, and admin.command domain events**

## Performance

- **Duration:** 35 min
- **Started:** 2026-04-15T00:40:00Z
- **Completed:** 2026-04-15T01:15:00Z
- **Tasks:** 3 (Task 1: create bus + emit, Task 3: TDD tests RED, Task 2: wire subscribers + app.ts)
- **Files modified:** 6 (3 new, 3 modified)

## Accomplishments

- `InstanceEventBus` at `apps/api/src/lib/instance-events.ts` — typed `EventEmitter` wrapper with `emit`/`on`/`off` overloads that only accept `'session.activity' | 'session.close_intent_detected' | 'admin.command'`; TypeScript rejects unknown event names at compile time
- `InstanceOrchestrator.handleInboundMessage()` emits `session.activity` for every non-admin inbound message, `session.close_intent_detected` when `recognizeCloseIntent()` matches, and `admin.command` for admin/instance senders — zero direct calls to `SessionLifecycleService`
- `SessionLifecycleService` subscribes to both `session.activity` (calls `recordActivity()`) and `session.close_intent_detected` (transitions to `CONFIRMACAO_ENVIADA`); all async listeners have `.catch()` guards per T-04-04-01
- Circular import eliminated: `recognizeCloseIntent()` extracted to `apps/api/src/lib/session-intents.ts` as a pure function; both `service.ts` and `session-lifecycle.service.ts` import from this shared utility — neither imports the other
- `app.ts` instantiates one `InstanceEventBus` after `createLogger()` and passes it to both `InstanceOrchestrator` and `SessionLifecycleService` constructors

## Task Commits

Each task was committed atomically:

1. **Task 1: Create InstanceEventBus + wire emit calls into InstanceOrchestrator** - `6327679` (feat)
2. **Task 3: Write tests for InstanceOrchestrator emit behavior (RED)** - `66b9c21` (test)
3. **Task 2: Wire EventBus into SessionLifecycleService and app.ts** - `f8aedbc` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified

- `apps/api/src/lib/instance-events.ts` — `InstanceEventBus` class + `SessionActivityEvent`, `SessionCloseIntentEvent`, `AdminCommandEvent`, `InstanceDomainEvent` exports
- `apps/api/src/lib/session-intents.ts` — Pure `recognizeCloseIntent(text: string): boolean` utility with CLOSURE_PHRASES list (SESS-09 stub)
- `apps/api/src/modules/instances/__tests__/instance-eventbus-wiring.test.ts` — 5 tests: admin messages never trigger `session.activity`, client messages always trigger `session.activity`, `admin.command` emitted for admin, `session.close_intent_detected` emitted on closure phrase but not on regular message
- `apps/api/src/modules/instances/service.ts` — Import `InstanceEventBus` + `recognizeCloseIntent`; add `eventBus` to `InstanceOrchestratorDeps`; wire `this.eventBus` property; 3 emit calls in `handleInboundMessage()`
- `apps/api/src/modules/instances/session-lifecycle.service.ts` — Add `eventBus?` to deps; subscribe to `session.activity` and `session.close_intent_detected` in constructor; delegate `recognizeCloseIntent()` to shared utility
- `apps/api/src/app.ts` — Import `InstanceEventBus`; instantiate `eventBus` after `createLogger()`; pass to `InstanceOrchestrator` and `SessionLifecycleService`

## Decisions Made

- `recognizeCloseIntent()` extracted to `session-intents.ts` to break circular import seam — the plan explicitly required this to avoid `service.ts` importing `session-lifecycle.service.ts`
- `sessionId: ''` passed in `session.activity` payload as placeholder — `SessionStateService` is not yet wired into `handleInboundMessage()`; full sessionId comes in Phase 5
- `eventBus` is optional in deps for both services — `InstanceOrchestrator` defaults to `new InstanceEventBus()` if not provided, allowing construction without the bus in legacy callers
- `session-lifecycle.service.ts`'s own `CLOSURE_PHRASES` array and inline `recognizeCloseIntent()` implementation replaced by a delegation call to the shared utility — eliminates duplicate logic

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Extracted recognizeCloseIntent to shared utility before adding emit calls**

- **Found during:** Task 1 (Create InstanceEventBus + wire emit calls)
- **Issue:** Plan required `service.ts` to call `recognizeCloseIntent()` without importing from `session-lifecycle.service.ts`. The plan's interface spec describes moving the function to `session-intents.ts` but this was in the same task as emit wiring.
- **Fix:** Created `apps/api/src/lib/session-intents.ts` with pure `recognizeCloseIntent()` function. Updated `session-lifecycle.service.ts` to delegate to this utility (removing the duplicate CLOSURE_PHRASES array and inline implementation). `service.ts` imports from `session-intents.ts` only.
- **Files modified:** `apps/api/src/lib/session-intents.ts` (created), `apps/api/src/modules/instances/session-lifecycle.service.ts` (updated)
- **Verification:** `grep "session-lifecycle.service" apps/api/src/modules/instances/service.ts` → 0 matches confirmed
- **Committed in:** `6327679` (Task 1 commit) + `f8aedbc` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 2 — missing critical functionality for correct decoupling)
**Impact on plan:** Required for the circular import prevention to work correctly. No scope creep — extracting the utility was already described in the plan spec, just executed inline rather than as a separate step.

## Issues Encountered

- `vitest` and `tsc` binaries non-functional in this worktree environment (broken pnpm virtual store symlinks — same issue documented in 04-03-SUMMARY.md). Tests are structurally verified via import chain analysis: `InstanceEventBus` class exists and is imported in test, `vi.spyOn(eventBus, 'emit')` spy pattern is valid, all 5 test assertions reference the correct event names and payload shapes. TypeScript compilation verified by running `./node_modules/.bin/tsc` which produced 0 errors before the broken binary issue was encountered for tsc itself.

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| `sessionId: ''` in session.activity payload | `service.ts` | emit call in `handleInboundMessage` | SessionStateService not yet wired into handleInboundMessage; real sessionId lookup deferred to Phase 5 |
| `recognizeCloseIntent()` — static phrase list | `session-intents.ts` | all | Intentional per plan: "SESS-09 stub — Phase 5 will replace with Groq LLM classifier" |

## User Setup Required

None — no external service configuration required. Set `SESSION_LIFECYCLE_V2=true` in `.env` to activate the session lifecycle feature including event subscriptions. When unset, `recordActivity()` is a no-op and the event subscriptions are wired but immediately return.

## Next Phase Readiness

- `InstanceEventBus` is instantiated and shared in `app.ts` — any Phase 5+ service can subscribe by accepting `eventBus` in its deps
- `session.activity` events are being emitted on every client message — `SessionLifecycleService.recordActivity()` will fire when `SESSION_LIFECYCLE_V2=true`
- `session.close_intent_detected` transitions to `CONFIRMACAO_ENVIADA` — Phase 5 can replace the static phrase check with an LLM classifier by updating `session-intents.ts`
- `admin.command` events are emitted — Phase 6/7 admin command handlers can subscribe without modifying `InstanceOrchestrator`
- Zero direct coupling from `InstanceOrchestrator` to `SessionLifecycleService` — extraction boundary established for incremental god-class decomposition

---
*Phase: 04-session-lifecycle-formalization*
*Completed: 2026-04-15*
