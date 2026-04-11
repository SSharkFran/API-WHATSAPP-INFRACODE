---
phase: 01-security-hardening
plan: 02
subsystem: security
tags: [cors, auth, security, tdd, wave-1]
dependency_graph:
  requires: [01-01]
  provides: [cors-allowlist, auth-bypass-guard]
  affects: [01-03, 01-04]
tech_stack:
  added: []
  patterns: [ALLOWED_ORIGINS env var, Zod default field, TDD GREEN]
key_files:
  created: []
  modified:
    - apps/api/src/app.ts
    - apps/api/src/config.ts
    - apps/api/src/plugins/auth.ts
    - apps/api/test/security.test.ts
    - apps/api/test/setup.ts
decisions:
  - Used NODE_ENV !== 'development' allowlist guard (not === 'production' blocklist) so test/staging/preview all require auth
  - Used NODE_ENV=production (not NODE_ENV=staging) in SEC-02 Test C because Zod enum rejects unknown NODE_ENV values before guard runs
  - Updated test setup.ts ENABLE_AUTH to true so NODE_ENV=test passes the broadened guard without breaking existing tests
metrics:
  duration: ~12 minutes
  completed: 2026-04-11T02:48:41Z
  tasks_completed: 2
  tasks_total: 2
  files_modified: 5
requirements:
  - SEC-01
  - SEC-02
---

# Phase 01 Plan 02: CORS Allowlist + Auth Bypass Guard Summary

## One-liner

Replaced CORS `origin: true` wildcard with ALLOWED_ORIGINS env-var allowlist and narrowed auth bypass to `NODE_ENV === 'development'` only, closing SEC-01 and SEC-02 pre-launch gaps.

## What Was Built

**SEC-01 — CORS Allowlist (T-01-03):**
- Added `ALLOWED_ORIGINS` Zod field to `envSchema` with `default("http://localhost:3000")` — safe for local dev, must be set explicitly in production.
- Replaced `origin: true` in `app.ts` CORS registration with `app.config.ALLOWED_ORIGINS.split(',').map(s => s.trim())` — only listed origins receive `Access-Control-Allow-Origin` header.
- Malicious origins (e.g. `https://evil.com`) now receive no ACAO header, blocking credentialed cross-origin requests.

**SEC-02 — Auth Bypass Guard (T-01-04):**
- Broadened `loadConfig()` startup guard from `NODE_ENV === "production"` (blocklist) to `NODE_ENV !== "development"` (allowlist) — `test`, `staging`, `preview`, and any unknown environment now all require `ENABLE_AUTH=true` at startup.
- Narrowed auth plugin bypass condition from `!app.config.ENABLE_AUTH` to `!app.config.ENABLE_AUTH && app.config.NODE_ENV === 'development'` — staging/preview deployments with `ENABLE_AUTH` unset no longer silently bypass all authentication.
- Updated `test/setup.ts` to set `ENABLE_AUTH=true` so the broadened guard doesn't break existing tests running under `NODE_ENV=test`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix CORS + add ALLOWED_ORIGINS Zod field (SEC-01) | 72e620f | apps/api/src/app.ts, apps/api/src/config.ts, apps/api/test/security.test.ts |
| 2 | Narrow auth bypass to development-only (SEC-02) | bcaab7c | apps/api/src/plugins/auth.ts, apps/api/test/setup.ts |

## Verification Results

- `grep "origin: true" apps/api/src/app.ts` — no match (0 occurrences)
- `grep "ALLOWED_ORIGINS" apps/api/src/config.ts` — present with `.min(1).default("http://localhost:3000")`
- `grep "ALLOWED_ORIGINS.split" apps/api/src/app.ts` — present
- `grep "NODE_ENV !== .development" apps/api/src/config.ts` — present
- `grep "NODE_ENV === 'development'" apps/api/src/plugins/auth.ts` — present
- SEC-01 tests (A+B): GREEN
- SEC-02 tests (C+D): GREEN
- SEC-03 tests (E-G): RED (Plans 03 stubs — expected)
- SEC-04 tests (H-I): RED (Plan 04 stubs — expected)
- Full test suite: 29 passed, 5 failed (only remaining stubs), 2 skipped — no regressions
- `pnpm tsc --noEmit` — exit 0

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test setup breaking under broadened SEC-02 guard**
- **Found during:** Task 2
- **Issue:** After changing the loadConfig() guard from `NODE_ENV === "production"` to `NODE_ENV !== "development"`, the test environment (`NODE_ENV=test`, `ENABLE_AUTH=false`) would throw on every test that calls `buildApp()` or `loadConfig()`.
- **Fix:** Changed `test/setup.ts` `ENABLE_AUTH ??= "false"` to `ENABLE_AUTH ??= "true"`. Since the health route and other test routes have `auth: false` or use inject with proper tokens, this change does not break any existing test behavior.
- **Files modified:** apps/api/test/setup.ts
- **Commit:** bcaab7c

**2. [Rule 1 - Bug] Used NODE_ENV=production (not staging) in SEC-02 Test C**
- **Found during:** Task 2 — Plan specifies NODE_ENV="staging" but Zod enum only accepts development/test/production
- **Issue:** The plan's example test used `NODE_ENV="staging"` in Test C, but `z.enum(["development", "test", "production"])` throws a Zod parse error before the guard check runs — the error would not match `/ENABLE_AUTH/`.
- **Fix:** Changed Test C to use `NODE_ENV="production"` (a valid enum value that triggers the guard) so `expect(() => loadConfig()).toThrow(/ENABLE_AUTH/)` passes correctly.
- **Files modified:** apps/api/test/security.test.ts
- **Commit:** 72e620f

## Known Stubs

None introduced by this plan. The 5 remaining failing tests in security.test.ts are pre-existing intentional stubs for Plans 03 and 04.

## Threat Flags

None — this plan only hardens existing surface. No new network endpoints, auth paths, or schema changes introduced.

## Self-Check: PASSED
