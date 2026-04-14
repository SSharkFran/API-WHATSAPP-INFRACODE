---
phase: 03
plan: 04
subsystem: api-core
tags: [logging, lifecycle, refactor, cleanup]
dependency_graph:
  requires: [03-01, 03-02, 03-03]
  provides: [structured-logging, scheduler-lifecycle, clean-service]
  affects: [apps/api/src/modules/instances/service.ts, apps/api/src/modules/chatbot/service.ts, apps/api/src/app.ts, apps/api/src/server.ts]
tech_stack:
  added: []
  patterns: [pino-structured-logging, fastify-lifecycle-hooks, prisma-worker-exit-update]
key_files:
  created: []
  modified:
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/modules/chatbot/service.ts
    - apps/api/src/app.ts
    - apps/api/src/server.ts
decisions:
  - "Worker exit DB update uses promise chain (not async/await) because exit callbacks cannot be async"
  - "UTF-8 corruption on line ~4887 was already resolved by Task 1 logger replacement, not a separate fix"
  - "Dead code block was 299 lines (not 80 as estimated in plan) - entire /* */ block from lines 3349-3647 deleted"
metrics:
  duration_minutes: 45
  completed: "2026-04-14"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 4
requirements: [ADM-01]
---

# Phase 03 Plan 04: Housekeeping — Logging, Lifecycle, and Dead Code Summary

Five housekeeping fixes applied to reduce diff noise and improve operational reliability across the admin identity service phase.

## What Was Built

**Pino structured logger replacing console.* in InstanceOrchestrator and ChatbotService.** Both classes now emit structured JSON logs via `this.logger` (a pino child logger with `component` label), with metadata objects as first arg per Pino convention. Zero console.log/warn/error remain in either service.

**Scheduler lifecycle corrected.** `startSchedulers()` moved from `buildApp()` (before `listen()`) to `server.ts` after `await app.listen()` succeeds. `stopSchedulers()` added as first call in the `onClose` hook — runs before `instanceOrchestrator.close()` to prevent orphaned timers on shutdown.

**Worker exit handler now updates PostgreSQL.** When a worker exits with `code !== 0`, the instance row is updated to `status: "DISCONNECTED"` and `lastError` set. Uses a `.then().catch()` chain (exit callbacks cannot be async).

**299-line dead code block deleted.** The commented-out `/* ... */` block between lines 3349 and 3647 of service.ts (estimated 80 lines in plan, actual 299) was fully removed.

**UTF-8 corruption fixed.** The `"[lead] erro na extraÃ§Ã£o:"` corruption was replaced by `this.logger.error({ err: error }, "[lead] erro na extracao")` as part of Task 1 logger replacement.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | `abda1e8` | Replace console.* with Pino structured logger (82 in service.ts, 38 in chatbot/service.ts) |
| Task 2 | `777b407` | Fix scheduler lifecycle, delete 299-line dead code, fix worker exit handler |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing message string in worker.on("exit") warn log**
- **Found during:** Task 2 — inspecting the exit handler that was converted from console.warn in Task 1
- **Issue:** The replacement converted `console.warn("[orchestrator] worker da instancia encerrado", {...})` to `this.logger.warn({...})` but dropped the message string (second arg)
- **Fix:** Added `"[orchestrator] worker da instancia encerrado"` as second argument to the warn call
- **Files modified:** apps/api/src/modules/instances/service.ts
- **Commit:** 777b407

**2. [Scope note] Dead code block was 299 lines, not ~80 as estimated**
- **Found during:** Task 2 — reading lines 3349-3647 to find exact `/* */` boundaries
- **Issue:** Plan estimated 80 lines of commented-out code; actual block was 299 lines (full pipeline duplication)
- **Fix:** Deleted entire block as intended — no partial removal
- **Files modified:** apps/api/src/modules/instances/service.ts
- **Commit:** 777b407

## Known Stubs

None — all changes are structural (logging replacement, lifecycle fix, dead code removal). No data flows to UI.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes introduced.

## Self-Check: PASSED

- FOUND: apps/api/src/modules/instances/service.ts
- FOUND: apps/api/src/modules/chatbot/service.ts
- FOUND: apps/api/src/app.ts
- FOUND: apps/api/src/server.ts
- FOUND commit: abda1e8
- FOUND commit: 777b407
