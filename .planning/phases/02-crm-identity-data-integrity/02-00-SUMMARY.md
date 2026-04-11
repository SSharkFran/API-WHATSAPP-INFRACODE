---
phase: 02-crm-identity-data-integrity
plan: 00
subsystem: testing
tags: [vitest, crm, wave-0, red, migrations]
dependency_graph:
  requires:
    - 01-security-hardening
  provides:
    - phase-2-red-test-scaffolds
    - targeted-crm-wave-0-verification-baseline
  affects:
    - 02-01
    - 02-02
    - 02-03
    - 02-04
tech_stack:
  added: []
  patterns:
    - workspace-scoped Vitest execution in the API package
    - Wave 0 RED placeholder tests with TODO import markers
key_files:
  created:
    - apps/api/src/modules/crm/__tests__/lid-normalization.test.ts
    - apps/api/src/modules/crm/__tests__/format-phone.test.ts
    - apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts
    - apps/api/src/lib/__tests__/run-migrations.test.ts
  modified: []
decisions:
  - Keep production imports commented with TODO markers so Wave 0 tests cannot trigger live DB or queue behavior yet.
  - Verify through the API workspace because the repo root does not expose a vitest binary.
metrics:
  duration: ~8 minutes
  started: 2026-04-11T20:24:30Z
  completed: 2026-04-11T20:32:34Z
  tasks_completed: 2
  tasks_total: 2
  files_modified: 4
requirements:
  - CRM-01
  - CRM-02
  - CRM-03
  - CRM-04
  - CRM-05
  - CRM-06
---

# Phase 02 Plan 00: Wave 0 RED Scaffold Summary

## One-liner

Four failing Vitest scaffold files now exist for Phase 2 CRM identity, display normalization, batching, and tenant migration behaviors.

## What Was Built

- Created `lid-normalization.test.ts` with seven RED stubs covering LID normalization, rawJid fallback, and reconciliation behavior names from `02-VALIDATION.md`.
- Created `format-phone.test.ts` with eight RED stubs derived from the `02-UI-SPEC.md` output contract, including the commented import link to `../../../lib/format-phone`.
- Created `crm-contacts-batch.test.ts` with three RED stubs for the N+1 replacement and memory matching behavior.
- Created `run-migrations.test.ts` with six RED stubs plus the commented import link to `../run-migrations`.
- Verified each task-specific test pair fails intentionally, then verified all four files fail together as the Wave 0 baseline.
- Left production code untouched, matching the plan's Wave 0 constraint.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create LID normalization and formatPhone test stubs | 74e52c2 | apps/api/src/modules/crm/__tests__/lid-normalization.test.ts, apps/api/src/modules/crm/__tests__/format-phone.test.ts |
| 2 | Create CRM contacts batch and run-migrations test stubs | 44a8fee | apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts, apps/api/src/lib/__tests__/run-migrations.test.ts |

## Verification Results

- File existence checks passed for all four expected Wave 0 files.
- `lid-normalization.test.ts` contains 7 `expect(true).toBe(false)` placeholders.
- `run-migrations.test.ts` contains 6 `it()` blocks.
- Targeted Task 1 verification failed as expected: 2 files failed, 15 tests failed.
- Targeted Task 2 verification failed as expected: 2 files failed, 9 tests failed.
- Combined plan verification failed as expected: 4 files failed, 24 tests failed.

## Files Created

- `apps/api/src/modules/crm/__tests__/lid-normalization.test.ts` - RED stubs for CRM-01 LID ingestion and reconciliation behaviors.
- `apps/api/src/modules/crm/__tests__/format-phone.test.ts` - RED stubs for the `formatPhone()` UI contract and import path marker for Plan 2.2.
- `apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts` - RED stubs for the CRM contacts batching fix in Plan 2.3.
- `apps/api/src/lib/__tests__/run-migrations.test.ts` - RED stubs for migration tracking and per-tenant failure isolation in Plan 2.4.

## Decisions Made

- Used commented import lines instead of live imports in the new stub files so the RED scaffold preserves the intended module links without executing production code early.
- Kept the new tests under `apps/api/src/.../__tests__` exactly where the plan specified, even though the repo also has older `apps/api/test` coverage, because these behaviors are phase-local scaffolds for upcoming implementation plans.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Switched verification to workspace-scoped Vitest execution**
- **Found during:** Task 1 verification
- **Issue:** The plan's generic root command `pnpm vitest run` is not available in this monorepo. `pnpm vitest --version` from the repo root fails with `Command "vitest" not found`.
- **Fix:** Ran verification with `pnpm --filter @infracode/api exec vitest run ...` from `apps/api`, which uses the API package's installed Vitest binary.
- **Files modified:** none
- **Verification:** Targeted Task 1, Task 2, and combined four-file runs all produced the expected FAIL output.
- **Committed in:** n/a (verification-only adjustment)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope change. The adjustment only changed how verification was invoked in this workspace.

## Issues Encountered

- The repo root does not expose a direct `vitest` binary through `pnpm`. Verification had to run through the `@infracode/api` workspace package.

## Known Stubs

- `apps/api/src/modules/crm/__tests__/lid-normalization.test.ts:8` - Intentional RED placeholder assertions for Plan 2.1 to turn green.
- `apps/api/src/modules/crm/__tests__/format-phone.test.ts:10` - Intentional RED placeholder assertions for Plan 2.2 to turn green.
- `apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts:9` - Intentional RED placeholder assertions for Plan 2.3 to turn green.
- `apps/api/src/lib/__tests__/run-migrations.test.ts:10` - Intentional RED placeholder assertions for Plan 2.4 to turn green.

## Threat Flags

None - this plan only adds inert test scaffolds with TODO import markers and no runtime integration.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans `02-01` through `02-04` can now turn these tests green against pre-existing RED files.
- Future executors should keep using the API workspace for targeted Vitest runs unless the root workspace gains a direct `vitest` binary.

## Self-Check: PASSED

- [x] `.planning/phases/02-crm-identity-data-integrity/02-00-SUMMARY.md` exists.
- [x] `apps/api/src/modules/crm/__tests__/lid-normalization.test.ts` exists.
- [x] `apps/api/src/modules/crm/__tests__/format-phone.test.ts` exists.
- [x] `apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts` exists.
- [x] `apps/api/src/lib/__tests__/run-migrations.test.ts` exists.
- [x] Commit `74e52c2` exists for Task 1.
- [x] Commit `44a8fee` exists for Task 2.
