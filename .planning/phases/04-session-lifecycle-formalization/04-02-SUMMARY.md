---
phase: 04-session-lifecycle-formalization
plan: "02"
subsystem: api
tags: [session-management, redis, postgresql, prisma, vitest, tdd, typescript]

# Dependency graph
requires:
  - phase: 04-01
    provides: "SessionStatus enum and ConversationSessionManager seam"
provides:
  - "ConversationSession PostgreSQL table in every tenant schema (via buildTenantSchemaSql ALTER TABLE pattern)"
  - "SessionStateService — Redis hash (fast path) + PostgreSQL row (durable) for session persistence"
  - "Redis key pattern: session:{tenantId}:{instanceId}:{remoteJid} with 24h TTL"
  - "isHumanTakeover() fast-path HGET check (SESS-07)"
  - "openSession() / closeSession() / updateStatus() / setHumanTakeover() public API"
  - "T-04-02-01 mitigated: remoteJid validated before use in Redis key"
  - "T-04-02-02 mitigated: humanTakeover only writable via dedicated setHumanTakeover() method"
affects:
  - 04-session-lifecycle-formalization
  - 04-03
  - 04-04

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual-layer persistence: Redis hash (fast, ephemeral) + PostgreSQL row (durable) for session state"
    - "ConversationSession table added via CREATE TABLE IF NOT EXISTS + ALTER TABLE IF NOT EXISTS guards (no migration file)"
    - "TDD: RED commit then GREEN commit per task"
    - "T-04-02-02: dedicated setHumanTakeover() enforces write-gate pattern for sensitive flag"

key-files:
  created:
    - apps/api/src/modules/instances/session-state.service.ts
    - apps/api/src/modules/instances/__tests__/session-state.service.test.ts
  modified:
    - apps/api/src/lib/tenant-schema.ts
    - prisma/tenant.prisma

key-decisions:
  - "ConversationSession added via ALTER TABLE IF NOT EXISTS guards (not a migration file) — consistent with existing pattern in buildTenantSchemaSql(); runMigrations() infrastructure never built"
  - "humanTakeover field lives ONLY in Redis hash (not in ConversationSession table) — Conversation.humanTakeover already exists; Redis field is the fast-path only"
  - "setHumanTakeover() is a dedicated method separate from updateStatus() — T-04-02-02 mitigation: prevents any general state update from accidentally writing the sensitive flag"
  - "remoteJid validated against /@(s\\.whatsapp\\.net|g\\.us)$/ pattern in redisKey() — T-04-02-01 mitigation"

patterns-established:
  - "Redis HSET for fast session reads; PostgreSQL INSERT/UPDATE for durable audit trail"
  - "Empty Redis HGETALL → null return (safe default for expired sessions)"
  - "HGET single-field for isHumanTakeover() — avoids full HGETALL on hot path"

requirements-completed:
  - SESS-02
  - SESS-06
  - SESS-07
  - SESS-08

# Metrics
duration: 35min
completed: 2026-04-15
---

# Phase 04 Plan 02: Session Lifecycle Formalization — Persistence Layer Summary

**SessionStateService with dual-layer persistence (Redis hash + PostgreSQL ConversationSession row), 10/10 tests green, remoteJid injection mitigation and humanTakeover write-gate enforced**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-04-15T01:00:00Z
- **Completed:** 2026-04-15T01:10:00Z
- **Tasks:** 2 (TDD: RED + GREEN)
- **Files modified:** 4

## Accomplishments

- Created `ConversationSession` table in every tenant schema via idempotent `CREATE TABLE IF NOT EXISTS` + two `ALTER TABLE IF NOT EXISTS` guards in `buildTenantSchemaSql()`
- Added `ConversationSession` Prisma model to `prisma/tenant.prisma` for type generation and documentation
- Implemented `SessionStateService` with 5 public methods: `openSession`, `getSessionState`, `isHumanTakeover`, `updateStatus`, `closeSession` (+ `setHumanTakeover` for threat mitigation)
- All threat mitigations from the plan's STRIDE register implemented: T-04-02-01 (remoteJid validation) and T-04-02-02 (humanTakeover write-gate)

## Task Commits

1. **Task 1: Write failing tests for SessionStateService (RED)** - `98d7e6b` (test)
2. **Task 2: Add ConversationSession table + implement SessionStateService (GREEN)** - `42a6fa2` (feat)

## Files Created/Modified

- `apps/api/src/modules/instances/session-state.service.ts` — New class: `SessionStateService` with dual-layer persistence, remoteJid validation, dedicated `setHumanTakeover()` method
- `apps/api/src/modules/instances/__tests__/session-state.service.test.ts` — 10 unit tests covering SESS-02/06/07/08 and threat mitigations with mocked Redis and Prisma
- `apps/api/src/lib/tenant-schema.ts` — Added `ConversationSession` CREATE TABLE + 2 indexes + 2 ALTER TABLE guards at end of `buildTenantSchemaSql()` array
- `prisma/tenant.prisma` — Added `ConversationSession` Prisma model (no relations, matches raw SQL schema exactly)

## Decisions Made

- `humanTakeover` lives exclusively in the Redis hash (not in `ConversationSession` table) — `Conversation.humanTakeover` already exists in PostgreSQL for durable state; the Redis field is only for the hot-path `isHumanTakeover()` check
- `setHumanTakeover()` added as a dedicated method beyond the plan spec — this is the T-04-02-02 mitigation: callers must explicitly call this separate method rather than passing `humanTakeover` through `updateStatus()`
- Prisma `ConversationSession` model has no relations defined (no `Instance` or `Conversation` relation fields) — the raw SQL uses FK constraints via `$executeRawUnsafe`; adding Prisma relations would require updating `Instance` and `Conversation` models too, which is out of scope for this plan

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added setHumanTakeover() method (T-04-02-02)**
- **Found during:** Task 2 (implementing SessionStateService)
- **Issue:** Threat model T-04-02-02 requires humanTakeover writes to be gated behind a dedicated method — implementing only `updateStatus()` would leave no enforcement mechanism
- **Fix:** Added `setHumanTakeover(tenantId, instanceId, remoteJid, value)` as a separate public method; `openSession()` writes `humanTakeover: '0'` only (initial value), `updateStatus()` never touches the field
- **Files modified:** apps/api/src/modules/instances/session-state.service.ts
- **Verification:** Tests cover isHumanTakeover() correctly; updateStatus() test verifies only `{ status }` is written
- **Committed in:** `42a6fa2` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical — threat mitigation)
**Impact on plan:** Required for T-04-02-02 compliance. No scope creep — method is lightweight and needed by plan 04-04 anyway.

## Issues Encountered

- Worktree node_modules were not set up; ran `pnpm install` to get the pnpm virtual store with vitest available at `.pnpm/vitest@3.2.4_.../vitest.mjs`. Tests run directly via that path.
- Pre-existing TypeScript errors in the codebase (missing Prisma generated files) — zero new errors introduced by this plan.

## Known Stubs

None — all fields wired to real Redis and PostgreSQL operations.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `SessionStateService` is the persistence seam Plans 04-03 and 04-04 need
- `openSession()` is ready to be called from `InstanceOrchestrator` on first inbound message (Plan 04-03)
- `isHumanTakeover()` is the fast-path check Plan 04-03 uses to route admin vs. client messages
- `closeSession()` is the durable close operation Plan 04-04 calls from session timeout BullMQ jobs

---
*Phase: 04-session-lifecycle-formalization*
*Completed: 2026-04-15*
