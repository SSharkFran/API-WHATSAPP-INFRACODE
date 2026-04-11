---
phase: 01-security-hardening
plan: 01
subsystem: test-scaffolding
tags: [tdd, security, testing, wave-0]
dependency_graph:
  requires: []
  provides: [security-test-stubs]
  affects: [01-02, 01-03, 01-04]
tech_stack:
  added: []
  patterns: [vitest, expect.fail stubs, TDD RED phase]
key_files:
  created:
    - apps/api/test/security.test.ts
  modified: []
decisions:
  - Used expect.fail() stubs (not expect(true).toBe(false)) for clearer failure messages identifying which plan resolves each test
metrics:
  duration: ~8 minutes
  completed: 2026-04-11T02:44:31Z
  tasks_completed: 1
  tasks_total: 1
  files_modified: 1
requirements:
  - SEC-01
  - SEC-02
  - SEC-03
  - SEC-04
---

# Phase 01 Plan 01: Security Test Scaffolding Summary

## One-liner

9 failing TDD stubs for all security requirements (SEC-01 through SEC-04) using vitest expect.fail() with plan-specific messages.

## What Was Built

Created `apps/api/test/security.test.ts` with 9 failing test stubs covering all four security requirements for Phase 01. These stubs establish the Nyquist verification contract — each subsequent implementation plan (01-02, 01-03, 01-04) has a pre-written automated test to satisfy before the plan is considered complete.

The test file follows existing vitest patterns from `apps/api/test/app.test.ts`, imports the correct modules (`../src/app.js`, `../src/lib/crypto.js`), and uses `expect.fail()` stubs with descriptive messages indicating which plan resolves each test.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create security.test.ts with 9 failing stubs | 3951a4b | apps/api/test/security.test.ts |

## Verification Results

- `grep -c "^\s*it(" security.test.ts` = 9
- `grep -c "expect.fail" security.test.ts` = 9
- `pnpm test -- --reporter=verbose security` = 9 failed, 0 passed (RED confirmed)
- `npx tsc --noEmit` = exit 0 (no TypeScript errors)

## Test Coverage

| Requirement | Tests | Status |
|-------------|-------|--------|
| SEC-01 CORS allowlist | 2 stubs | RED |
| SEC-02 Auth bypass guard | 2 stubs | RED |
| SEC-03 aiFallbackApiKey encryption | 3 stubs | RED |
| SEC-04 DATA_DIR + query-string tokens | 2 stubs | RED |

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

All 9 tests in `apps/api/test/security.test.ts` are intentional stubs. Each stub is labeled with the plan that will implement it:
- Tests A-B (lines 8-14): resolved by Plan 01-02 (CORS fix)
- Tests C-D (lines 18-24): resolved by Plan 01-02 (auth guard fix)
- Tests E-G (lines 29-41): resolved by Plan 01-03 (encryption fix)
- Tests H-I (lines 46-52): resolved by Plan 01-04 (startup + query-string)

These stubs are the plan's deliverable, not a deficit.

## Threat Flags

None - this plan only creates test scaffolding with no new production surface.

## Self-Check: PASSED
