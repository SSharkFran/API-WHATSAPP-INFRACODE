---
phase: 08-continuous-learning-polish-advanced-features
plan: "01"
subsystem: aprendizado-continuo
tags: [null-object-pattern, interface, polymorphism, graceful-degradation]
dependency_graph:
  requires: ["08-00"]
  provides: ["IAprendizadoContinuoModule interface", "DisabledAprendizadoContinuoModule", "ActiveAprendizadoContinuoModule"]
  affects: ["apps/api/src/modules/instances/service.ts", "apps/api/src/modules/chatbot/service.ts", "apps/api/src/modules/instances/admin-identity.service.ts"]
tech_stack:
  added: []
  patterns: ["Null Object Pattern", "TypeScript interface polymorphism", "TDD RED-GREEN"]
key_files:
  created:
    - apps/api/src/modules/instances/aprendizado-continuo.interface.ts
    - apps/api/src/modules/instances/aprendizado-continuo.disabled.ts
    - apps/api/src/modules/instances/aprendizado-continuo.active.ts
    - apps/api/src/modules/instances/__tests__/aprendizado-continuo.interface.test.ts
  modified:
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/modules/chatbot/service.ts
    - apps/api/src/modules/instances/admin-identity.service.ts
    - apps/api/src/modules/instances/__tests__/admin-identity.service.test.ts
decisions:
  - "Wiring site pattern: rawConfig?.isEnabled is checked exactly once per call site to create Active vs Disabled — no other code may inspect isEnabled directly"
  - "aprendizado-continuo.active.ts is a re-export shim for backward import compatibility"
  - "admin-identity.service.ts AdminIdentityInput.aprendizadoContinuoModule changed from inline shape to IAprendizadoContinuoModule | null"
metrics:
  duration: "~25 minutes"
  completed: "2026-04-24"
  tasks_completed: 2
  files_created: 4
  files_modified: 4
---

# Phase 8 Plan 01: Null Object Pattern for aprendizadoContinuo Module Summary

**One-liner:** Null Object pattern via `IAprendizadoContinuoModule` interface with `Disabled`/`Active` implementations eliminates 14 inline `isEnabled` guards from three service files.

## What Was Built

Introduced the `IAprendizadoContinuoModule` interface (APR-01) and two implementations:

- **`DisabledAprendizadoContinuoModule`** — safe no-op returns (`[]`, `false`, `null`, `""`) for all methods; used when module is off
- **`ActiveAprendizadoContinuoModule`** — delegates to the raw config, implementing `isVerified()`, `getAdminPhones()`, `getAdminJids()` with proper filtering

Removed all 14 inline `isEnabled` guard checks across three files by replacing them with polymorphic interface method calls.

## Tasks Completed

| Task | Description | Commit | Status |
|------|-------------|--------|--------|
| 1 (TDD RED) | Failing tests for IAprendizadoContinuoModule | e85321d | Done |
| 1 (TDD GREEN) | Interface + Disabled/Active implementations | e42d0f7 | Done |
| 2 | Remove 14 isEnabled guards from 3 service files | dc8aaa6 | Done |

## Verification Results

- `aprendizado-continuo.interface.test.ts`: **11 tests passed** (all 7 plan behaviors + 4 additional)
- `admin-identity.service.test.ts`: **77 tests passed** (2 updated to use interface instances)
- TypeScript build: **0 errors** in production source files

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated admin-identity.service.test.ts to use interface instances**
- **Found during:** Task 2 verification
- **Issue:** Two existing tests passed plain objects (`{isEnabled: false, ...}`) as `aprendizadoContinuoModule`, which broke when the field type changed to `IAprendizadoContinuoModule | null`
- **Fix:** Updated Scenario 2 test to use `new DisabledAprendizadoContinuoModule()` and Scenario 3 to use `new ActiveAprendizadoContinuoModule({...})`
- **Files modified:** `apps/api/src/modules/instances/__tests__/admin-identity.service.test.ts`
- **Commit:** dc8aaa6

**2. [Rule 2 - Missing functionality] Added 5th guard in chatbot/service.ts (line 2175)**
- **Found during:** Task 2 analysis
- **Issue:** Plan listed 4 guards in chatbot/service.ts but there was an additional one at line 2175 (`evaluateWithAi`) not listed
- **Fix:** Replaced with `aprendizadoContinuoModule.isVerified() && hasAdminPhone` pattern using `getAdminPhones().length > 0` for `hasAdminPhone`
- **Files modified:** `apps/api/src/modules/chatbot/service.ts`
- **Commit:** dc8aaa6

### Wiring Site Pattern Note

The plan required `rawConfig?.isEnabled` to be checked exactly once at wiring sites. There are 9 remaining `.isEnabled` references in the three files — all are wiring sites constructing `Active` vs `Disabled` instances, not guard checks. This is the correct architecture per the threat model (T-8-01-02).

## Known Stubs

None — no stub values or placeholder data in created/modified files.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes were introduced.

The threat model mitigations are fully applied:
- **T-8-01-01:** `getAdminPhones()` on Disabled returns `[]` — admin detection still works via other `adminCandidatePhones` paths
- **T-8-01-02:** Wiring site checks `rawConfig?.isEnabled` exactly once — the only place allowed to create Active instance

## Self-Check: PASSED

All created files exist on disk. All task commits verified in git log.

| Check | Result |
|-------|--------|
| aprendizado-continuo.interface.ts | FOUND |
| aprendizado-continuo.disabled.ts | FOUND |
| aprendizado-continuo.active.ts | FOUND |
| aprendizado-continuo.interface.test.ts | FOUND |
| commit e85321d (TDD RED) | FOUND |
| commit e42d0f7 (TDD GREEN) | FOUND |
| commit dc8aaa6 (guards removed) | FOUND |
