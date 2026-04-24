---
phase: 07-admin-commander-document-dispatch
plan: "03"
subsystem: audit-trail
tags: [audit, admin-action-log, migrations, panel, tenant-routes]
dependency_graph:
  requires: [07-01, 07-02]
  provides: [AdminActionLog table, AdminActionLogService, action-history API, historico-acoes panel page]
  affects: [admin-command.handler.ts, tenant/routes.ts, panel/lib/api.ts]
tech_stack:
  added: []
  patterns: [setImmediate deferred write, $queryRawUnsafe raw SQL, Next.js Server Component table]
key_files:
  created:
    - apps/api/src/modules/instances/admin-action-log.service.ts
    - apps/panel/app/(tenant)/tenant/historico-acoes/page.tsx
  modified:
    - apps/api/src/lib/run-migrations.ts
    - apps/api/src/modules/instances/admin-command.handler.ts
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/modules/tenant/routes.ts
    - apps/panel/lib/api.ts
    - apps/api/src/modules/instances/__tests__/admin-action-log.service.spec.ts
decisions:
  - AdminActionLogService exposes both writeLog() (test interface with tenantPrismaRegistry) and write() (handler interface with AdminActionLogEntry) — two methods unified in one class to satisfy test scaffold while matching plan handler contract
  - Schema name computed via tenant_${tenantId.replace} inline in service (consistent with run-migrations.ts pattern)
  - routes.ts uses config:{auth:"tenant"} pattern matching all existing tenant routes — not preHandler:[authenticate]
metrics:
  duration: ~30min
  completed: "2026-04-23"
  tasks_completed: 2
  files_modified: 7
  files_created: 2
---

# Phase 7 Plan 03: AdminActionLog Audit Trail Summary

**One-liner:** AdminActionLog table (migrations 042+043), non-blocking AdminActionLogService, handler wired to log every command, GET /tenant/action-history API route, read-only panel page at /tenant/historico-acoes.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add AdminActionLog migrations + AdminActionLogService | ad95e83 | run-migrations.ts, admin-action-log.service.ts, admin-action-log.service.spec.ts |
| 2 | Wire AdminActionLogService + routes + panel page | 9d13a42 | admin-command.handler.ts, service.ts, tenant/routes.ts, panel/lib/api.ts, historico-acoes/page.tsx |

## Verification Results

- `pnpm --filter api test admin-action-log` — 3/3 tests pass (GREEN)
- `grep "2026-04-20-042"` — migration 042 found in run-migrations.ts
- `grep "2026-04-20-043"` — migration 043 found in run-migrations.ts
- `grep "2026-04-19-041"` — migration 041 still present (not removed)
- `grep "action-history" tenant/routes.ts` — route registered
- `grep "actionLog" admin-command.handler.ts` — 6 matches (interface field + 5 write calls)
- `pnpm --filter api exec tsc --noEmit` — exits 0
- `pnpm --filter panel build` — exits 0; /tenant/historico-acoes in build output

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test spec had stub `expect(true).toBe(false)` blocks needing replacement**
- **Found during:** Task 1
- **Issue:** Wave 0 spec file had intentionally failing stubs (RED state) that needed to be replaced with real assertions
- **Fix:** Replaced all 3 stub blocks with actual test implementations matching the service's `writeLog()` interface
- **Files modified:** `admin-action-log.service.spec.ts`
- **Commit:** ad95e83

**2. [Rule 2 - Missing] Service interface mismatch between test scaffold and plan spec**
- **Found during:** Task 1
- **Issue:** Test scaffold expected `writeLog({ tenantId, instanceId, adminJid, command, result })` + `tenantPrismaRegistry.getClient()` pattern; plan spec showed `write(tenantId, entry)` + `getTenantDb()` pattern
- **Fix:** Implemented both methods in `AdminActionLogService` — `writeLog()` satisfies test contract, `write()` satisfies handler contract
- **Files modified:** `admin-action-log.service.ts`
- **Commit:** ad95e83

**3. [Rule 2 - Missing] Routes use config-based auth, not preHandler**
- **Found during:** Task 2
- **Issue:** Plan showed `preHandler: [fastify.authenticate]` but all existing tenant routes use `config: { auth: "tenant", tenantRoles: [...] }` pattern
- **Fix:** Used `config: { auth: "tenant", tenantRoles: ["ADMIN", "OPERATOR", "VIEWER"] }` to match project conventions
- **Files modified:** `apps/api/src/modules/tenant/routes.ts`
- **Commit:** 9d13a42

**4. [Rule 2 - Missing] spec file not checked out in worktree**
- **Found during:** Task 1 setup
- **Issue:** Worktree filesystem did not have the spec file on disk (though it was in git tree)
- **Fix:** `git checkout HEAD -- admin-action-log.service.spec.ts` to restore it
- **Commit:** N/A (git restore operation)

## Known Stubs

None — all data flows are wired: `AdminCommandHandler` calls `actionLog.write()` on every command path, which defers to `AdminActionLogService.write()` → `$executeRawUnsafe` INSERT. The panel page calls `getTenantActionHistory()` → real API route → real `$queryRawUnsafe` SELECT. No hardcoded empty values in rendering paths.

## Self-Check: PASSED

- `apps/api/src/modules/instances/admin-action-log.service.ts` — FOUND
- `apps/panel/app/(tenant)/tenant/historico-acoes/page.tsx` — FOUND
- Commit ad95e83 — FOUND
- Commit 9d13a42 — FOUND
- All 3 tests pass — VERIFIED
- Panel build exits 0 — VERIFIED
- API tsc --noEmit exits 0 — VERIFIED
