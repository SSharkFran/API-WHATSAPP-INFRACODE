---
phase: 04-session-lifecycle-formalization
plan: "01"
subsystem: api
tags: [session-management, refactoring, lru, typescript, vitest, tdd]

# Dependency graph
requires: []
provides:
  - "ConversationSessionManager class owning all in-process session state"
  - "SessionStatus const enum (ATIVA, AGUARDANDO_CLIENTE, CONFIRMACAO_ENVIADA, INATIVA, ENCERRADA)"
  - "ConversationSession interface exported from conversation-session-manager.ts"
  - "LRU cap of 500 sessions with idle-only eviction policy"
  - "clearAll() for teardown; startGc/stopGc for scheduler lifecycle"
affects:
  - 04-session-lifecycle-formalization

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Strangler-fig extraction: new class introduced, service.ts delegates via this.sessionManager"
    - "LRU eviction with guard: isProcessing sessions are never evicted (T-04-01-01)"
    - "TDD: RED commit then GREEN commit per task"

key-files:
  created:
    - apps/api/src/modules/instances/conversation-session-manager.ts
    - apps/api/src/modules/instances/__tests__/conversation-session-manager.test.ts
  modified:
    - apps/api/src/modules/instances/service.ts

key-decisions:
  - "ConversationSession interface and PendingConversationTurnContext copied verbatim into conversation-session-manager.ts to avoid circular imports between service.ts and the manager"
  - "queueConversationTurn and processQueuedConversationTurn stay on InstanceOrchestrator — they need orchestrator this-context (LLM call, sendMessage); they operate on the session object passed by reference"
  - "SessionStatus implemented as const object (not TS enum) for runtime value access without emitting boilerplate"
  - "clearAll() is called before worker teardown in close(), after stopSchedulers() — ensures no orphaned debounce timers survive shutdown"

patterns-established:
  - "Manager pattern for InstanceOrchestrator extraction: each domain (session, admin identity) gets its own focused class"
  - "Threat mitigations as first-class unit tests: T-04-01-01 (never evict processing), T-04-01-02 (bounded map) verified by Tests 7 and 8"

requirements-completed:
  - SESS-01

# Metrics
duration: 30min
completed: 2026-04-15
---

# Phase 04 Plan 01: Session Lifecycle Formalization — Manager Extraction Summary

**ConversationSessionManager extracted from InstanceOrchestrator's 5k-line god-class with LRU cap 500, SessionStatus enum, and full teardown safety — zero behavioral regression, 8/8 tests green**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-04-15T00:38:00Z
- **Completed:** 2026-04-15T00:53:00Z
- **Tasks:** 2 (TDD: RED + GREEN)
- **Files modified:** 3

## Accomplishments

- Created `conversation-session-manager.ts` with `ConversationSessionManager` class and `SessionStatus` enum; class owns the sessions `Map` exclusively
- Wired manager into `InstanceOrchestrator`: all 15 session access points replaced with `this.sessionManager.*` calls; `conversationSessions` property and 3 standalone methods removed from service.ts
- LRU eviction policy: cap of 500, evicts oldest idle session on every `set()` call; never evicts `isProcessing=true` sessions (T-04-01-01); warns when no idle candidate found

## Task Commits

1. **Task 1: Write failing unit tests for ConversationSessionManager (RED)** - `39a161f` (test)
2. **Task 2: Create ConversationSessionManager + wire into service.ts (GREEN)** - `6d8c9e4` (feat)

## Files Created/Modified

- `apps/api/src/modules/instances/conversation-session-manager.ts` — New class: `ConversationSessionManager`, `ConversationSession` interface, `SessionStatus` const enum, `getOrCreate()`, `clear()`, `clearAll()`, `startGc()`, `stopGc()`, `evictIfNeeded()`
- `apps/api/src/modules/instances/__tests__/conversation-session-manager.test.ts` — 8 unit tests covering all behaviors and threat mitigations
- `apps/api/src/modules/instances/service.ts` — Removed: `conversationSessions` Map, `sessionGcInterval` field, `buildConversationSessionKey`, `clearConversationSession`, `getConversationSession`, inline `ConversationSession` interface. Added: `sessionManager` field, delegate calls throughout

## Decisions Made

- `PendingConversationTurnContext` duplicated in conversation-session-manager.ts to avoid a circular import with service.ts — the interface is internal to the session creation flow
- `queueConversationTurn` and `processQueuedConversationTurn` intentionally kept on `InstanceOrchestrator` because they need `this.sendMessage`, `this.processConversationTurn`, etc. They receive the `ConversationSession` object by reference
- `SessionStatus` as const object (`as const`) rather than TypeScript enum — avoids enum emit, works at runtime without compilation artifacts, same usage pattern

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Worktree had no node_modules; ran `pnpm install` in worktree to get vitest binary available at `node_modules/.pnpm/vitest@.../vitest.mjs`. Tests run directly via that path.
- Pre-existing TypeScript errors in the codebase (missing Prisma generated files) exist across many files including service.ts — zero new errors introduced by this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `ConversationSessionManager` is the seam Plans 4.2, 4.3, and 4.4 need to build on
- Session state is now mockable/replaceable in isolation — Plan 4.2 can add Redis persistence by extending the manager
- `SessionStatus` enum is ready for Plan 4.3 (closure detection) to use for state transitions

---
*Phase: 04-session-lifecycle-formalization*
*Completed: 2026-04-15*
