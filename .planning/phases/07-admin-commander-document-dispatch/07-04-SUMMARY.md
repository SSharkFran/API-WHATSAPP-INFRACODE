---
phase: "07"
plan: "04"
subsystem: admin-commander
tags: [status-query, admin-commands, instance-health, metrics]
dependency_graph:
  requires:
    - "07-01"  # AdminCommandHandler skeleton
    - "07-02"  # DocumentDispatchService
    - "07-03"  # AdminActionLogService
  provides:
    - StatusQueryService with live data aggregation
    - Real /status and /resumo responses via WhatsApp
  affects:
    - apps/api/src/modules/instances/service.ts (StatusQueryService instantiation)
tech_stack:
  added: []
  patterns:
    - Dependency injection via StatusQueryDeps interface
    - Promise.all with individual .catch() for parallel data fetch with graceful degradation
    - TDD (RED-GREEN) for StatusQueryService
key_files:
  created:
    - apps/api/src/modules/instances/status-query.service.ts
    - apps/api/src/modules/instances/__tests__/status-query.service.spec.ts
  modified:
    - apps/api/src/modules/instances/admin-command.handler.ts
    - apps/api/src/modules/instances/service.ts
decisions:
  - "Used Conversation.count(lastMessageAt >= today) instead of non-existent ConversationMetric model — aligned with existing status_instancia tool pattern"
  - "Changed getInstanceStatus dep signature to accept (tenantId, instanceId) to enable buildWorkerKey lookup in InstanceOrchestrator"
  - "Mapped uppercase InstanceStatus enum (CONNECTED/DISCONNECTED) to lowercase StatusSnapshot literals"
metrics:
  duration: "~60 minutes"
  completed_date: "2026-04-24"
  tasks_completed: 2
  files_created: 2
  files_modified: 2
---

# Phase 07 Plan 04: Status Query Service & Command Stubs Replacement Summary

**One-liner:** StatusQueryService with parallel data fetch (instance health + active sessions + today's messages + last summary timestamp) wired into AdminCommandHandler replacing all Plan 7.1 stubs.

## What Was Built

### StatusQueryService (`status-query.service.ts`)

A new service that aggregates instance health data from multiple sources in parallel:

- `getSnapshot(tenantId, instanceId)` — fetches all 4 data points via `Promise.all` with individual `.catch()` fallbacks (single slow query cannot block the entire response)
- `formatStatusMessage(snapshot)` — returns pt-BR WhatsApp message with connection emoji, active session count, today's message count, last summary timestamp
- `formatResumoMessage(snapshot)` — returns pt-BR daily summary format for `/resumo` command

### AdminCommandHandler stubs replaced

Both stub implementations from Plan 7.1 were removed:

- `handleStatusCommand` — now calls `deps.statusQuery.getSnapshot()` + `formatStatusMessage()`
- `handleResumoCommand` — now calls `deps.statusQuery.getSnapshot()` + `formatResumoMessage()`

All placeholder text ("Plano 7.4", "será implementado") eliminated.

### InstanceOrchestrator wiring (service.ts)

`StatusQueryService` instantiated in constructor with real data deps:

- `getInstanceStatus` — reads `workers` Map via `buildWorkerKey(tenantId, instanceId)` then maps `CONNECTED`/`DISCONNECTED` enum to lowercase
- `getActiveSessionCount` — `ConversationSession.count({ endedAt: null, instanceId })`
- `getTodayMessageCount` — `Conversation.count({ lastMessageAt: { gte: today }, instanceId })`
- `getLastSummaryAt` — Redis GET `instance:{instanceId}:last_summary_at`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ConversationMetric model does not exist in schema**
- **Found during:** Task 2 wiring
- **Issue:** Plan referenced `ConversationMetric` table for `getTodayMessageCount` but this model does not exist in `tenant.prisma`. The plan's context note was aspirational.
- **Fix:** Used `Conversation.count({ lastMessageAt: { gte: today } })` — same data source as the existing `status_instancia` tool in AdminCommandService
- **Files modified:** `apps/api/src/modules/instances/service.ts`
- **Commit:** 6ec1cdd

**2. [Rule 1 - Bug] getInstanceStatus signature required tenantId for worker key lookup**
- **Found during:** Task 2 wiring
- **Issue:** Plan's `StatusQueryDeps.getInstanceStatus` only accepted `instanceId`, but `InstanceOrchestrator.workers` is keyed by `buildWorkerKey(tenantId, instanceId)` — impossible to look up without tenantId
- **Fix:** Changed `getInstanceStatus` dep signature to `(tenantId: string, instanceId: string)` and updated `getSnapshot()` call accordingly
- **Files modified:** `apps/api/src/modules/instances/status-query.service.ts`
- **Commit:** 6ec1cdd

**3. [Rule 1 - Bug] InstanceStatus enum is uppercase; StatusSnapshot uses lowercase**
- **Found during:** Task 2 TypeScript check
- **Issue:** `ManagedWorker.currentStatus` is `InstanceStatus` ("CONNECTED" | "DISCONNECTED" | ...) but `StatusSnapshot.instanceStatus` uses lowercase strings
- **Fix:** Explicit mapping `if (s === 'CONNECTED') return 'connected'` in closure
- **Files modified:** `apps/api/src/modules/instances/service.ts`
- **Commit:** 6ec1cdd

**4. [Rule 1 - Bug] TenantPrisma type does not expose conversationSession**
- **Found during:** Task 2 TypeScript check
- **Issue:** TypeScript strict mode rejected `prisma.conversationSession` because the TenantPrisma type didn't expose the model at the type level
- **Fix:** Used `(prisma as unknown as { conversationSession: ... }).conversationSession.count(...)` cast — safe because `ConversationSession` is confirmed to exist in `tenant.prisma`
- **Files modified:** `apps/api/src/modules/instances/service.ts`
- **Commit:** 6ec1cdd

## Test Results

| Suite | Tests | Result |
|-------|-------|--------|
| admin-command.handler.spec.ts | 8 | PASS |
| status-query.service.spec.ts | 14 | PASS |
| **Total** | **22** | **PASS** |

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 5424b87 | test | TDD RED — failing tests for StatusQueryService |
| 5717ad5 | feat | StatusQueryService implementation (TDD GREEN) |
| 6ec1cdd | feat | Wire StatusQueryService into AdminCommandHandler; replace stubs |

## Known Stubs

None — all stubs from Plan 7.1 replaced with real implementations.

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns introduced. `StatusSnapshot` fields are limited to: instanceStatus, activeSessionCount, todayMessageCount, lastSummaryAt — no config keys, connection strings, or internal errors exposed. Threat model mitigations from plan confirmed implemented.

## Self-Check: PASSED

- `apps/api/src/modules/instances/status-query.service.ts` — EXISTS
- `apps/api/src/modules/instances/__tests__/status-query.service.spec.ts` — EXISTS
- Commits 5424b87, 5717ad5, 6ec1cdd — FOUND in git log
- `grep "export class StatusQueryService"` — MATCH
- `grep "export interface StatusSnapshot"` — MATCH
- `grep "formatStatusMessage\|formatResumoMessage"` — 2 MATCHES
- `grep "Promise.all"` — MATCH
- `grep "Plano 7.4\|será implementado" admin-command.handler.ts` — NO MATCH (stubs removed)
- `grep "statusQuery" admin-command.handler.ts` — 5 MATCHES
- TypeScript compile (production code) — ZERO ERRORS
