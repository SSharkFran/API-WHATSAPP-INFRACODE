---
phase: 06-metrics-daily-summary
plan: 02
subsystem: tenant-metrics
tags: [metrics, api, panel, sql, tenant-scoped]
dependency_graph:
  requires:
    - 06-01-PLAN.md (ConversationSession columns: urgencyScore, documentCount, durationSeconds, firstResponseMs)
  provides:
    - GET /tenant/metrics/today (TodayMetricsSnapshot — 7 fields)
    - GET /tenant/metrics/queue (ActiveQueueEntry[] — urgency-sorted, limited 50)
    - getTodayMetrics() + getActiveQueue() on TenantManagementService
    - Panel page at /tenant/metrics with StatCards + queue table
    - Metrics nav item in tenant sidebar
  affects:
    - apps/api/src/modules/tenant/service.ts
    - apps/api/src/modules/tenant/routes.ts
    - apps/panel/lib/api.ts
    - apps/panel/app/(tenant)/tenant/layout.tsx
tech_stack:
  added:
    - raw SQL via $queryRawUnsafe for getTodayMetrics (two parallel queries with positional params)
    - raw SQL via $queryRawUnsafe for getActiveQueue (EXTRACT(EPOCH) for elapsed seconds)
    - UrgencyBadge React component (score >= 80 = red Alta, >= 40 = yellow Media, else Normal)
  patterns:
    - Promise.all for parallel SQL queries in getTodayMetrics
    - instanceIds resolved from platformPrisma.instance.findMany (cross-tenant safe)
    - parseInt/parseFloat with String() coercion for BigInt-safe row parsing
    - export const dynamic = "force-dynamic" on server component
key_files:
  created:
    - apps/api/src/modules/tenant/__tests__/tenant-metrics.service.test.ts
    - apps/panel/app/(tenant)/tenant/metrics/page.tsx
  modified:
    - apps/api/src/modules/tenant/service.ts
    - apps/api/src/modules/tenant/routes.ts
    - apps/panel/lib/api.ts
    - apps/panel/app/(tenant)/tenant/layout.tsx
decisions:
  - getTodayMetrics uses two parallel SQL queries (metricsRows + continuationRows) rather than one large query — cleaner separation of concerns and avoids complex GROUP BY
  - continuationRate is null (not 0) when totalClosedCount = 0 — prevents misleading 100% rate on days with no closed sessions
  - getActiveQueue limited to 50 entries via LIMIT 50 in SQL — sufficient for dashboard visibility without unbounded result sets
  - VIEWER role can see /tenant/metrics/today aggregate stats but not /tenant/metrics/queue individual sessions — queue is ADMIN/OPERATOR only per threat model T-06-02-04
metrics:
  duration: ~25 minutes
  completed: 2026-04-18
  tasks_completed: 2
  files_created: 2
  files_modified: 4
---

# Phase 6 Plan 02: Metrics API Endpoints and Panel Page Summary

Two tenant-scoped metrics endpoints backed by raw SQL, TypeScript interfaces in api.ts, and a panel page at /tenant/metrics with session statistics and urgency-sorted active queue.

## What Was Built

### Task 1 — TDD: getTodayMetrics() and getActiveQueue() service methods

**RED phase (commit `8401c36`):**
Created `apps/api/src/modules/tenant/__tests__/tenant-metrics.service.test.ts` with 4 failing test stubs:
- MET-02: numeric type coercion from PostgreSQL BigInt strings
- MET-04: continuationRate calculation from timedOut/totalClosed counts
- MET-04 edge: null continuationRate when no closed sessions
- MET-07: getActiveQueue returns array with urgencyScore and elapsedSeconds fields

**GREEN phase (commit `ccd0b78`):**
Added to `apps/api/src/modules/tenant/service.ts`:
- `export interface TodayMetricsSnapshot` (7 fields: startedCount, endedCount, inactiveCount, handoffCount, avgDurationSeconds, avgFirstResponseMs, continuationRate)
- `export interface ActiveQueueEntry` (7 fields: id, instanceId, remoteJid, contactId, startedAt, urgencyScore, elapsedSeconds)
- Helper types: `MetricsRow`, `ContinuationRow`, `ActiveQueueRow`, `emptyMetricsSnapshot()`
- `getTodayMetrics(tenantId)`: resolves instanceIds from platformPrisma, runs two parallel $queryRawUnsafe calls, returns typed snapshot
- `getActiveQueue(tenantId)`: resolves instanceIds, runs single query ordered by urgencyScore DESC then startedAt ASC, limited to 50

All 4 tests GREEN.

### Task 2 — Routes, panel page, nav link (commit `03b1aef`)

**routes.ts:** Two new GET routes:
- `GET /tenant/metrics/today` — roles: ADMIN, OPERATOR, VIEWER
- `GET /tenant/metrics/queue` — roles: ADMIN, OPERATOR (VIEWER excluded per T-06-02-04)

**api.ts:** Added `TodayMetricsSnapshot` and `ActiveQueueEntry` interfaces plus `getTenantTodayMetrics()` and `getTenantActiveQueue()` fetch functions using the existing `request<T>()` helper.

**metrics/page.tsx:** Server component (`export const dynamic = "force-dynamic"`) at `/tenant/metrics` with:
- 6 StatCards for session counts and averages (started, ended, inactive, transferred, avg duration, avg first response)
- Continuation rate section with formatted percentage or "—"
- Active queue table with remoteJid (stripped of @s.whatsapp.net), elapsed duration, UrgencyBadge
- Empty state for zero active sessions

**layout.tsx:** Added `BarChart2` to lucide-react import and `{ href: "/tenant/metrics", label: "Métricas", icon: BarChart2 }` nav item between CRM and API Keys.

Panel build succeeds with `/tenant/metrics` route listed in output.

## Test Results

```
src/modules/tenant/__tests__/tenant-metrics.service.test.ts  4/4 PASS
src/modules/instances/__tests__/session-metrics-collector.test.ts  5/5 PASS
Full run: 29 pre-existing failures (Phase 02 CRM/format-phone/run-migrations from parallel worktree) | 109 passed
```

Pre-existing failures are from Phase 02 worktree — `format-phone.ts`, `run-migrations.ts`, `lid-reconciliation` files that exist in another agent's branch but not in this worktree's base. These are out of scope.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — both endpoints query live data from `ConversationSession` via tenant-scoped prisma. The panel page calls real API endpoints (no mock fallback added for metrics, consistent with the `request<T>()` helper which throws on API errors rather than falling back to mocks).

## Threat Surface Scan

All mitigations from the plan's threat model were applied:

| Threat ID | Status |
|-----------|--------|
| T-06-02-01 | Mitigated — both endpoints use `config: { auth: "tenant" }`, instanceIds resolved from platformPrisma (never from request body) |
| T-06-02-02 | Mitigated — instanceIds passed via `$1::text[]` positional param; startOfToday is server-computed Date, never from user input |
| T-06-02-03 | Accepted — remoteJid displayed to authorized ADMIN/OPERATOR, stripped to number only (no @s.whatsapp.net suffix) |
| T-06-02-04 | Mitigated — /tenant/metrics/queue uses `tenantRoles: ["ADMIN", "OPERATOR"]` (VIEWER excluded) |

## Self-Check: PASSED

Files verified to exist:
- `apps/api/src/modules/tenant/__tests__/tenant-metrics.service.test.ts` — FOUND
- `apps/api/src/modules/tenant/service.ts` (contains getTodayMetrics + getActiveQueue) — FOUND
- `apps/api/src/modules/tenant/routes.ts` (contains /tenant/metrics/today + /tenant/metrics/queue) — FOUND
- `apps/panel/lib/api.ts` (contains TodayMetricsSnapshot + ActiveQueueEntry + fetch functions) — FOUND
- `apps/panel/app/(tenant)/tenant/metrics/page.tsx` — FOUND
- `apps/panel/app/(tenant)/tenant/layout.tsx` (contains /tenant/metrics nav item) — FOUND

Commits verified:
- `8401c36` (TDD RED stubs) — FOUND
- `ccd0b78` (service implementation GREEN) — FOUND
- `03b1aef` (routes + panel + nav) — FOUND
