---
phase: 07-admin-commander-document-dispatch
plan: "01"
subsystem: admin-command-routing
tags: [admin, event-bus, command-handler, refactor]
dependency_graph:
  requires:
    - 07-00 (test scaffolds — admin-command.handler.spec.ts)
    - phase-04 (InstanceEventBus domain events infrastructure)
    - phase-03 (AdminIdentityService — gates isAdminOrInstanceSender check)
  provides:
    - AdminCommandHandler class (universal admin command entry point)
    - admin.command event bus subscription wired
    - Legacy inline adminCommandService call removed from service.ts
  affects:
    - apps/api/src/modules/instances/service.ts (constructor + legacy removal)
    - apps/api/src/modules/instances/admin-command.handler.ts (new file)
tech_stack:
  added: []
  patterns:
    - Event bus subscriber pattern (setImmediate + .catch for async safety)
    - Console-wrapper logger shim (AdminCommandHandlerLogger minimal interface)
    - Tier 1/2 command routing (prefix regex → adminCommandService LLM fallback)
key_files:
  created:
    - apps/api/src/modules/instances/admin-command.handler.ts
    - apps/api/src/modules/instances/__tests__/admin-command.handler.spec.ts
  modified:
    - apps/api/src/modules/instances/service.ts
decisions:
  - Used minimal AdminCommandHandlerLogger interface instead of pino.Logger to avoid requiring logger dep in InstanceOrchestratorDeps (InstanceOrchestrator uses console.* throughout — no pino logger stored)
  - setImmediate wraps async handle() call to keep eventBus.emit() synchronous — matches existing pattern in SessionMetricsCollector
  - Stub bodies for /status, /resumo, /contrato, /proposta, /encerrar in this plan — real implementations in Plans 7.4 and 7.2 respectively
  - Wave 0 spec file (admin-command.handler.spec.ts) created alongside implementation since Plan 00 had not run before Plan 01 in this wave
metrics:
  duration: ~25 minutes
  completed: 2026-04-23T23:45:40Z
  tasks_completed: 2
  files_created: 2
  files_modified: 1
---

# Phase 7 Plan 01: AdminCommandHandler — Universal Command Entry Point Summary

AdminCommandHandler subscribes to the admin.command event bus, routes /status /resumo /contrato /proposta /encerrar via prefix regex (Tier 1), and falls through to AdminCommandService.handleCommand() for free-text (Tier 2 LLM); legacy restricted inline handler removed from service.ts.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create AdminCommandHandler with Tier 1/2 routing + spec scaffold | ae11a8a | admin-command.handler.ts, admin-command.handler.spec.ts |
| 2 | Wire AdminCommandHandler into InstanceOrchestrator; remove legacy call | 065b7db | service.ts, admin-command.handler.ts |

## What Was Built

### AdminCommandHandler (`admin-command.handler.ts`)

New file implementing the universal admin command subscriber:

- **Constructor**: subscribes to `admin.command` event on `InstanceEventBus`; wraps handler in `setImmediate(() => void this.handle(event).catch(...))` to keep emit synchronous and prevent unhandled rejections from propagating
- **Tier 1 routing** (no Groq call):
  - `/status` → `handleStatusCommand()` (stub — Plan 7.4)
  - `/resumo` → `handleResumoCommand()` (stub — Plan 7.4)
  - `/contrato [name]` → `handleDocumentCommand(event, 'contrato', name)` (stub — Plan 7.2)
  - `/proposta [name]` → `handleDocumentCommand(event, 'proposta', name)` (stub — Plan 7.2)
  - `/encerrar [name]` → `handleEncerrarCommand(event, name)` (stub — Plan 7.2)
- **Tier 2**: unmatched free-text → `adminCommandService.handleCommand()` (existing LLM pipeline)
- **makeSendResponse()**: creates per-event response closure using injected `sendAutomatedTextMessage`
- **AdminCommandHandlerLogger**: minimal interface (`.warn()` only) — accepts pino.Logger or console shims

### service.ts Changes

- Added `import { AdminCommandHandler } from './admin-command.handler.js'` at line 58
- Added `private readonly adminCommandHandler: AdminCommandHandler` field
- Constructor instantiates handler after `this.eventBus` assigned; passes console-wrapper logger shim (InstanceOrchestrator stores no pino.Logger)
- **Removed** entire legacy block (55 lines, former lines 3404–3459): `if (finalInputText && isVerifiedAprendizadoContinuoAdminSender) { await this.adminCommandService.handleCommand(...) }` — this restricted handler only fired for `isVerifiedAprendizadoContinuoAdminSender`; the event bus emit at line 2414 already fires for ALL `isAdminOrInstanceSender`

### Test Scaffold (`admin-command.handler.spec.ts`)

8 test stubs covering CMD-01, CMD-02, CMD-06, DOC-01..DOC-04:

1. `/status` routes without calling `AdminCommandService` (CMD-01)
2. `/contrato [name]` routes to document dispatch (CMD-02)
3. Free-text routes to `adminCommandService.handleCommand` (CMD-06)
4. `document.sent` event emitted after dispatch (DOC-04)
5. `mime.lookup` used for mimeType (DOC-01)
6. `readFile` + base64 for local path (DOC-01)
7. File > 5 MB aborts + alerts admin (DOC-02)
8. Disambiguation when multiple contacts match (DOC-03)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] AdminCommandHandler logger type mismatch**
- **Found during:** Task 2 (wiring into InstanceOrchestrator)
- **Issue:** Plan specified `logger: pino.Logger` in `AdminCommandHandlerDeps`, but `InstanceOrchestrator` uses `console.*` throughout and has no `this.logger` field
- **Fix:** Replaced `pino.Logger` with `AdminCommandHandlerLogger` minimal interface (`warn(obj, msg?)` overloads); constructor passes a console-wrapper literal satisfying that interface
- **Files modified:** `admin-command.handler.ts`, `service.ts`
- **Commit:** 065b7db

**2. [Rule 2 - Missing prerequisite] Wave 0 test scaffold not present**
- **Found during:** Task 1 start (Plan 00 had not executed before Plan 01 in this parallel wave)
- **Issue:** `admin-command.handler.spec.ts` referenced in plan's TDD flow did not exist
- **Fix:** Created the spec file with all 8 required stubs as part of Task 1 commit
- **Files modified:** `admin-command.handler.spec.ts`
- **Commit:** ae11a8a

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| `handleStatusCommand` returns placeholder text | admin-command.handler.ts | 88 | Real implementation in Plan 7.4 (StatusQueryService) |
| `handleResumoCommand` returns placeholder text | admin-command.handler.ts | 95 | Real implementation in Plan 7.4 (StatusQueryService) |
| `handleDocumentCommand` returns placeholder text | admin-command.handler.ts | 103 | Real implementation in Plan 7.2 (DocumentDispatchService) |
| `handleEncerrarCommand` returns placeholder text | admin-command.handler.ts | 112 | Real implementation in Plan 7.2 |
| `sendMessageToClient: async () => false` in Tier 2 | admin-command.handler.ts | 83 | Wired in Plan 7.2 |

These stubs are intentional — each is a protected method that Plans 7.2 and 7.4 will override or replace with real implementations. The routing logic (Tier 1/2) is fully functional; only the leaf handlers are stubbed.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. `AdminCommandHandler` subscribes to an internal in-process event bus only — no external surface. The event is already gated by `isAdminOrInstanceSender` (AdminIdentityService) at the emit site in `service.ts:2414`.

## Self-Check: PASSED

- FOUND: `apps/api/src/modules/instances/admin-command.handler.ts`
- FOUND: `apps/api/src/modules/instances/__tests__/admin-command.handler.spec.ts`
- FOUND: commit ae11a8a (feat(07-01): create AdminCommandHandler...)
- FOUND: commit 065b7db (feat(07-01): wire AdminCommandHandler...)
