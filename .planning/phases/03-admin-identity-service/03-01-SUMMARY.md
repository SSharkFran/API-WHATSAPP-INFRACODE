---
phase: 03-admin-identity-service
plan: "01"
subsystem: instances
tags: [tdd, refactor, admin-identity, service-extraction]
dependency_graph:
  requires: []
  provides: [AdminIdentityService, AdminIdentityContext, AdminIdentityInput]
  affects: [apps/api/src/modules/instances/service.ts]
tech_stack:
  added: []
  patterns: [pure-computation-service, constructor-injection, TDD]
key_files:
  created:
    - apps/api/src/modules/instances/admin-identity.service.ts
    - apps/api/src/modules/instances/__tests__/admin-identity.service.test.ts
  modified:
    - apps/api/src/modules/instances/service.ts
decisions:
  - AdminIdentityService is a pure computation service (no I/O, no constructor params) — async escalation resolution stays in handleInboundMessage() and is passed as escalationConversationId input field
  - matchedVerifiedAdminPhone recomputed after service call from verifiedAdminPhonesForMatch for downstream logging/fallback usage, avoiding leaking internal service state
  - adminCandidatePhones array construction kept in handleInboundMessage() as input preparation — only detection logic moved to service
metrics:
  duration: "~30 minutes"
  completed: "2026-04-13"
  tasks_completed: 2
  files_modified: 3
---

# Phase 03 Plan 01: AdminIdentityService Extraction Summary

**One-liner:** Extracted inline admin detection block (~120 lines) from InstanceOrchestrator into pure-computation AdminIdentityService with TDD (5 tests green).

## What Was Built

`AdminIdentityService` is a new pure-computation service that encapsulates all admin identity logic previously inline in `handleInboundMessage()`. It exposes a single `resolve(input: AdminIdentityInput): AdminIdentityContext` method that returns a typed struct with 10 identity flags/fields.

The seven phone/JID helper methods (`buildPhoneMatchVariants`, `phonesMatch`, `matchesAnyExpectedPhones`, `buildJidMatchVariants`, `jidsMatch`, `matchesAnyExpectedJids`, `findMatchingExpectedPhone`) were moved from `InstanceOrchestrator` to `AdminIdentityService` as public methods, enabling their reuse from the three other call sites (`linkAprendizadoContinuoAdminAlias`, `tryVerifyAprendizadoContinuoAdmin`) via `this.adminIdentityService.*()`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write failing tests (RED) | 860d5d2 | `__tests__/admin-identity.service.test.ts` |
| 2 | Create service + wire into service.ts (GREEN) | 130a363 | `admin-identity.service.ts`, `service.ts` |

## TDD Flow

- **RED:** 5 tests fail with `Cannot find module '../admin-identity.service.js'`
- **GREEN:** All 5 tests pass after service creation and extraction

## Test Scenarios Covered

1. **ADM-01** — Admin phone matches via `adminCandidatePhones` (module null): `isAdmin=true`
2. **ADM-02a** — Module null: admin still detected via candidate phones
3. **ADM-02b** — Module disabled (`isEnabled=false`): admin still detected via candidate phones
4. **Pitfall D** — `fromMe=true`: `isVerifiedAdmin=false` even when phone matches (bot echo guard preserved)
5. **ADM-03** — `@lid` JID with no phone candidates: `isAdmin=false` (no false positive)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] Recompute matchedVerifiedAdminPhone after service call**
- **Found during:** Task 2 — TypeScript check
- **Issue:** `matchedVerifiedAdminPhone` was referenced at lines 2800 and 3030 of service.ts for fallback phone and logging, but was no longer defined after removing the inline block
- **Fix:** Added `verifiedAdminPhonesForMatch` array and `matchedVerifiedAdminPhone = this.adminIdentityService.findMatchingExpectedPhone(...)` immediately after the service call
- **Files modified:** `apps/api/src/modules/instances/service.ts`
- **Commit:** 130a363

**2. [Rule 1 - Bug] verifiedAdminJids reference removed from warn log**
- **Found during:** Task 2 — TypeScript check (line 3180 `Cannot find name 'verifiedAdminJids'`)
- **Issue:** Warning log referenced `verifiedAdminJids` which was removed from scope
- **Fix:** Removed `verifiedAdminJids` from the warn log (kept `verifiedAdminPhones` as `verifiedAdminPhonesForMatch`)
- **Files modified:** `apps/api/src/modules/instances/service.ts`
- **Commit:** 130a363

## Verification

```
pnpm test -- admin-identity   → 5/5 passing
pnpm tsc --noEmit             → 0 new errors introduced (pre-existing unrelated errors only)
grep "adminIdentityService.resolve" service.ts  → 1 match (line 2125)
grep "const isAdminSender = Boolean" service.ts → 0 matches (inline block removed)
```

## Known Stubs

None — all AdminIdentityContext fields are fully computed from real inputs.

## Self-Check: PASSED

- `apps/api/src/modules/instances/admin-identity.service.ts` — FOUND
- `apps/api/src/modules/instances/__tests__/admin-identity.service.test.ts` — FOUND
- Commit `860d5d2` (RED tests) — FOUND
- Commit `130a363` (GREEN service) — FOUND
