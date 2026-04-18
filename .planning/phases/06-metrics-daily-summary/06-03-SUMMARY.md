---
phase: 06-metrics-daily-summary
plan: 03
subsystem: daily-summary
tags: [metrics, daily-summary, session-metrics, refactoring, MET-04, MET-06]
dependency_graph:
  requires:
    - 06-01 (ConversationSession table with session metrics columns)
  provides:
    - DailySummaryService (standalone, testable service for daily WhatsApp summary)
    - Session metrics section in daily summary (MET-06)
    - Continuation rate in summary (MET-04)
  affects:
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/app.ts
tech_stack:
  added:
    - DailySummaryService class (new file)
  patterns:
    - Forward reference closure pattern for circular dep (dailySummaryService ↔ instanceOrchestrator)
    - Redis dedup guard before any DB query (T-06-03-01 mitigation)
    - Positional SQL params ($1, $2) for $queryRawUnsafe calls (T-06-03-02 mitigation)
    - vi.mock of module-runtime.ts to avoid @infracode/types build dependency in tests
key_files:
  created:
    - apps/api/src/modules/instances/daily-summary.service.ts
    - apps/api/src/modules/instances/__tests__/daily-summary.service.test.ts
  modified:
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/app.ts
decisions:
  - Forward reference closure chosen over setOrchestrator() injection — sendMessage closure only called at runtime (scheduler tick), construction is safe
  - sendAutomatedTextMessage made public to allow DailySummaryService closure access (was private, public wrapper existed but lacked metadata param)
  - vi.mock of module-runtime.ts in tests avoids @infracode/types build requirement (pre-existing infrastructure constraint)
metrics:
  duration: ~13 minutes
  completed: 2026-04-18
  tasks_completed: 2
  files_created: 2
  files_modified: 2
---

# Phase 6 Plan 03: DailySummaryService Extraction and Session Metrics Summary

Extracted `runDailySummaryForAllInstances()` from `InstanceOrchestrator` into a standalone `DailySummaryService`, enriched the daily summary with session-level metrics (MET-06) including continuation rate (MET-04), and wired the new service in `app.ts`.

## What Was Built

### Task 1 — TDD RED+GREEN: DailySummaryService with tests

Created `daily-summary.service.ts` with:
- `sendForAllInstances(workers: Map<string, unknown>)` — main scheduler entry point, preserves all original logic (Redis dedup guard, module enabled check, hour gate, admin phone resolution)
- `buildSessionMetricsSummary(tenantId, instanceId)` — queries `ConversationSession` for today's metrics, returns formatted string section with session counts, avg duration, and continuation rate (MET-04)
- Redis dedup key `daily-summary:sent:{tenantId}:{instanceId}:{today}` checked BEFORE any DB query (T-06-03-01 mitigation)
- SQL uses positional params `$1`, `$2` — instanceId from server-internal workers Map (T-06-03-02 mitigation)

Created `daily-summary.service.test.ts` with 5 tests:
- Test 1: sends summary when module enabled and past sendHour (generateDailySummary called, sendMessage called, Redis dedup key set)
- Test 2: no-op when both resumoDiario and aprendizadoContinuo disabled
- Test 3: skips when Redis dedup key already set
- Test 4: skips when current UTC hour is before sendHour
- Test 5: buildSessionMetricsSummary produces text with "Taxa de continuação: 80.0%" given timedOut=2, totalClosed=10

All 5 tests GREEN.

**Commits:** `dc27cc2`

### Task 2 — Wire DailySummaryService in service.ts and app.ts

Modified `service.ts`:
- Added import `DailySummaryService` from `./daily-summary.service.js`
- Added `dailySummaryService: DailySummaryService` to `InstanceOrchestratorDeps` interface
- Added `private readonly dailySummaryService: DailySummaryService` class field
- Assigned in constructor: `this.dailySummaryService = deps.dailySummaryService`
- Replaced entire `runDailySummaryForAllInstances()` body with one-liner: `await this.dailySummaryService.sendForAllInstances(this.workers)`
- Removed `dailySummarySentDates` Map (moved to DailySummaryService)
- Made `sendAutomatedTextMessage` public (needed by DailySummaryService closure)

Modified `app.ts`:
- Added import `DailySummaryService`
- Constructed `dailySummaryService` before `instanceOrchestrator` using forward reference closure pattern
- Passed `dailySummaryService` to `new InstanceOrchestrator({...})`

**Commit:** `ee2d2cb`

## Test Results

```
daily-summary.service.test.ts  5/5 PASS
```

Other test failures in worktree are pre-existing (all fail with `Cannot find package '@infracode/types'` — TypeScript workspace package not built in worktree environment, documented in 06-01 summary as pre-existing).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] sendAutomatedTextMessage was private**
- **Found during:** Task 2
- **Issue:** `DailySummaryService.sendMessage` closure needs to call `instanceOrchestrator.sendAutomatedTextMessage(...)` which was `private`. The existing public wrapper `sendAutomatedTextMessagePublic` lacked the `metadata` parameter needed for `{ action: "daily_summary", kind: "chatbot" }`.
- **Fix:** Changed `private async sendAutomatedTextMessage` to `public async sendAutomatedTextMessage` — the method is already internally used throughout the class; making it public for the controlled closure is correct.
- **Files modified:** `apps/api/src/modules/instances/service.ts`
- **Commit:** `ee2d2cb`

**2. [Rule 2 - Missing critical functionality] @infracode/types not built — module-runtime mock needed in tests**
- **Found during:** Task 1 (first test run)
- **Issue:** `module-runtime.ts` imports `@infracode/types` which is a workspace package not built in the worktree. Direct import caused all tests to fail with `Cannot find package '@infracode/types'`.
- **Fix:** Added `vi.mock("../../chatbot/module-runtime.js", ...)` at top of test file with typed mock references for `sanitizeChatbotModules`, `getResumoDiarioModuleConfig`, `getAprendizadoContinuoModuleConfig`. Tests configure these mocks per-test via `mockReturnValue`.
- **Files modified:** `apps/api/src/modules/instances/__tests__/daily-summary.service.test.ts`
- **Commit:** `dc27cc2`

## Known Stubs

None — all code paths are functional. Session metrics query uses real SQL against `ConversationSession` table added in 06-01 migration 038.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns introduced. All security mitigations from plan's threat model applied:

| Threat ID | Status |
|-----------|--------|
| T-06-03-01 | Mitigated — Redis dedup key checked BEFORE any DB query or generateDailySummary call |
| T-06-03-02 | Mitigated — instanceId from workers Map (server-internal), passed as positional param $1 |
| T-06-03-03 | Accepted — admin phone from tenant's own chatbot config, no cross-tenant leak possible |
| T-06-03-04 | Accepted — Redis dedup key serves as audit trail; Pino warn on failure |

## Self-Check: PASSED

Files exist:
- `apps/api/src/modules/instances/daily-summary.service.ts` — FOUND
- `apps/api/src/modules/instances/__tests__/daily-summary.service.test.ts` — FOUND

Commits exist:
- `dc27cc2` (Task 1 — DailySummaryService + tests) — FOUND
- `ee2d2cb` (Task 2 — wiring) — FOUND

Verification checks:
- `grep -n "sendForAllInstances" service.ts` → line 366 one-liner — PASS
- `grep -c "dailySummarySentDates" service.ts` → 0 — PASS
- `grep -n "DailySummaryService" app.ts` → import + construction — PASS
- `grep -n "Taxa de continuação" daily-summary.service.ts` → line 186 — PASS
- 5 tests GREEN — PASS
