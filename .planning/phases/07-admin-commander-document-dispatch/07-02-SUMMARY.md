---
phase: "07"
plan: "02"
subsystem: document-dispatch
tags: [document-dispatch, admin-command, pdf, base64, mime, contact-lookup]
dependency_graph:
  requires:
    - "07-01"  # AdminCommandHandler stub from Wave 1
  provides:
    - document-dispatch-pipeline  # full pipeline: lookup -> gate -> encode -> send -> event
  affects:
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/modules/instances/admin-command.handler.ts
tech_stack:
  added:
    - mime-types@3.0.2 (already in package.json, confirmed installed)
  patterns:
    - sendResponse as 4th param to dispatch() — not in deps (per-event binding)
    - stat() before readFile() — never allocate buffer for oversized files
    - base64 encoding path — file:// unsupported by resolveMediaBuffer
    - setImmediate() for non-blocking event emission
key_files:
  created:
    - apps/api/src/modules/instances/document-dispatch.service.ts
  modified:
    - apps/api/src/modules/instances/__tests__/document-dispatch.service.spec.ts
    - apps/api/src/modules/instances/admin-command.handler.ts
    - apps/api/src/modules/instances/service.ts
decisions:
  - sendResponse is the 4th param to DocumentDispatchService.dispatch() — not in DocumentDispatchDeps — binding is per-event via AdminCommandHandler.makeSendResponse(event)
  - stat() before readFile() enforced by test: readFile spy must not be called when size > 5 MB
  - getDocumentTemplates queries prisma.chatbotConfig.findFirst inline rather than a getChatbotConfig helper (no such method existed)
  - sendMessage wrapper async arrow to align Promise<void> with InstanceOrchestrator.sendMessage returning Promise<Record<string,unknown>>
metrics:
  duration: "~25 minutes"
  completed: "2026-04-23"
  tasks: 2
  files: 4
---

# Phase 7 Plan 02: Document Dispatch Pipeline Summary

**One-liner:** Full document dispatch pipeline — contact lookup with disambiguation, 5 MB size gate before buffer alloc, base64 encode, personalized caption+fileName, send via InstanceOrchestrator, document.sent event emitted.

## What Was Built

### DocumentDispatchService (new)

`apps/api/src/modules/instances/document-dispatch.service.ts`

- `dispatch(event, documentType, clientName, sendResponse)` — canonical 4-param signature
- Contact lookup via `$queryRawUnsafe` with parameterized `$1` (SQL injection safe)
- 0 contacts → "Nenhum contato encontrado" response, no file access
- 2+ contacts → numbered disambiguation list, no file access, no send
- 1 contact → proceed to file dispatch
- `stat()` called first — if size > 5_242_880 bytes: send warning, return without `readFile()`
- `readFile()` → `buffer.toString('base64')` — avoids `file://` URL limitation
- `mime.lookup(filePath)` with `'application/pdf'` fallback
- `fileName`: `{TypeCapitalized} - {clientName}.pdf`
- `caption`: template from chatbotConfig or default `"Olá {clientName}, segue o {documentType} conforme combinado."`
- `document.sent` event emitted via `setImmediate()` (non-blocking)

### AdminCommandHandler (patched)

`apps/api/src/modules/instances/admin-command.handler.ts`

- `documentDispatch` field added to `AdminCommandHandlerDeps`
- `handleDocumentCommand` now calls `this.deps.documentDispatch.dispatch(event, documentType, clientName, this.makeSendResponse(event))` — stub removed
- `handleEncerrarCommand` updated with client name acknowledgement (full wiring Phase 8)

### InstanceOrchestrator (patched)

`apps/api/src/modules/instances/service.ts`

- `DocumentDispatchService` instantiated in constructor with `getDocumentTemplates` from `chatbotConfig.findFirst`
- `AdminCommandHandler` now receives `documentDispatch` dep — previously was missing the field

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm --filter api test document-dispatch` | 5/5 passed |
| `pnpm --filter api test admin-command` | 8/8 passed |
| `npx tsc --noEmit` (files modified by this plan) | 0 errors |
| stat() before readFile() confirmed | yes — test verifies readFile not called on oversized file |
| sendResponse as 4th param | confirmed — not in DocumentDispatchDeps |
| base64 encoding path used | confirmed |
| mime.lookup used | confirmed |
| document.sent event emitted | confirmed |
| stub "Plano 7.2" removed | confirmed |

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 (TDD GREEN) | 5fea45a | feat(07-02): create DocumentDispatchService with size gate, base64 encode, personalized send |
| Task 2 | 1e9f323 | feat(07-02): wire DocumentDispatchService into AdminCommandHandler and InstanceOrchestrator |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] document-dispatch.service.spec.ts used ESM spy pattern incompatible with vitest**
- **Found during:** Task 1 RED phase
- **Issue:** The Wave 0 spec file used `vi.spyOn(fsMod, "stat")` after dynamic import of `node:fs/promises`. ESM module namespace is not configurable — vitest cannot spy on named exports this way.
- **Fix:** Rewrote spec to use `vi.mock("node:fs/promises", ...)` at module level (the correct vitest ESM pattern), with `vi.mocked(stat).mockResolvedValue(...)` per test.
- **Files modified:** `apps/api/src/modules/instances/__tests__/document-dispatch.service.spec.ts`
- **Commit:** 5fea45a (included in Task 1 commit)

**2. [Rule 3 - Blocking] mime-types@3.0.2 package directory was empty**
- **Found during:** Task 1 GREEN phase
- **Issue:** `mime-types` was listed in `package.json` at `^3.0.1` but the pnpm store entry at `mime-types@3.0.2` had no files — empty directory prevented module resolution.
- **Fix:** Ran `pnpm install --force` which repaired the store and populated the package files.
- **Commit:** Not a code change — dependency repair only.

**3. [Rule 1 - Bug] getChatbotConfig helper referenced but never existed**
- **Found during:** Task 2, service.ts wiring
- **Issue:** The plan suggested `await this.getChatbotConfig(tid, iid)` but no such method exists in InstanceOrchestrator.
- **Fix:** Inlined the query: `await prisma.chatbotConfig.findFirst({ where: { instanceId: iid } })` — same pattern used elsewhere in service.ts.
- **Files modified:** `apps/api/src/modules/instances/service.ts`
- **Commit:** 1e9f323

**4. [Rule 1 - Bug] sendMessage return type mismatch**
- **Found during:** Task 2 TypeScript check
- **Issue:** `InstanceOrchestrator.sendMessage` returns `Promise<Record<string,unknown>>` but `DocumentDispatchDeps.sendMessage` expects `Promise<void>`.
- **Fix:** Wrapped in async arrow: `async (tid, iid, payload) => { await this.sendMessage(tid, iid, payload as never); }`.
- **Files modified:** `apps/api/src/modules/instances/service.ts`
- **Commit:** 1e9f323

## Known Stubs

None — all document dispatch functionality is fully implemented. The `handleEncerrarCommand` in `admin-command.handler.ts` acknowledges the client name but full CRM lookup + session close intent is deferred to Phase 8 (per plan specification).

## Threat Flags

None — threat model items were all mitigated:
- SQL injection: `$queryRawUnsafe` uses parameterized `$1` — clientName not interpolated
- Memory spike: `stat()` before `readFile()` enforced and tested
- file:// URL: base64 path used, not URL
- Disambiguation: contacts.length > 1 returns list, no silent first-contact selection

## Self-Check: PASSED

- document-dispatch.service.ts: FOUND
- document-dispatch.service.spec.ts: FOUND
- admin-command.handler.ts: FOUND
- service.ts: FOUND
- Commit 5fea45a: FOUND
- Commit 1e9f323: FOUND
