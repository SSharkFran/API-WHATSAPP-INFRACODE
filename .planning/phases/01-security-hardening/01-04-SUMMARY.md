---
phase: 01-security-hardening
plan: 04
subsystem: security
tags: [query-string, data-dir, startup-assertion, tdd, wave-1, sec-04]
dependency_graph:
  requires: [01-01, 01-02, 01-03]
  provides: [query-string-token-removal, data-dir-startup-assertion]
  affects: []
tech_stack:
  added: []
  patterns: [isWebSocketUpgrade guard, path.sep cross-platform comparison, process.exit assertion, vi.spyOn process.exit mock]
key_files:
  created: []
  modified:
    - apps/api/src/plugins/auth.ts
    - apps/api/src/app.ts
    - apps/api/test/security.test.ts
    - apps/api/test/setup.ts
decisions:
  - Used path.sep (not hardcoded '/') for cross-platform DATA_DIR assertion — Windows uses backslash separators
  - Used console.error (not createLogger) in DATA_DIR fatal block — logger requires Fastify context not yet created
  - Updated test/setup.ts DATA_DIR to /tmp/infracode-test-sessions (Option B) so assertion doesn't fire in all tests
  - isWebSocketUpgrade check uses request.headers.upgrade?.toLowerCase() === 'websocket' to preserve browser WS client auth
metrics:
  duration: ~12 minutes
  completed: 2026-04-11T03:00:21Z
  tasks_completed: 2
  tasks_total: 2
  files_modified: 4
requirements:
  - SEC-04
---

# Phase 01 Plan 04: Query-String Token Removal + DATA_DIR Assertion Summary

## One-liner

HTTP query-string token acceptance removed from auth plugin (WebSocket upgrade preserved); DATA_DIR startup assertion with cross-platform path.sep comparison blocks insecure deployments at boot.

## What Was Built

**SEC-04 — Query-String Token Removal (T-01-12):**
- Added `isWebSocketUpgrade` detection in `auth.ts` onRequest hook: `request.headers.upgrade?.toLowerCase() === 'websocket'`
- Bearer token fallback narrowed: `readBearerToken(authorization) ?? (isWebSocketUpgrade ? query?.accessToken : undefined)`
- API key fallback narrowed: `request.headers["x-api-key"]?.toString() ?? (isWebSocketUpgrade ? query?.apiKey : undefined)`
- HTTP requests with only `?accessToken=` or `?apiKey=` now return 401 UNAUTHENTICATED ("Credenciais ausentes")
- WebSocket upgrade requests still accept query-string tokens — browser WS clients cannot send custom headers in all environments

**SEC-04 — DATA_DIR Startup Assertion (T-01-13, T-01-14):**
- Added `import { resolve, sep } from 'node:path'` to app.ts
- Pre-startup assertion runs before any Fastify/service instantiation: `resolve(config.DATA_DIR)` vs `resolve(process.cwd())`
- Cross-platform comparison uses `path.sep` (backslash on Windows, forward slash on Unix) — not hardcoded '/'
- Condition: `dataDir.startsWith(projectRoot + sep) || dataDir === projectRoot` → `process.exit(1)`
- Fatal message emitted via `console.error` as JSON (logger not yet constructed at assertion point)
- Updated `test/setup.ts` `DATA_DIR` from `"./apps/api/data"` to `"/tmp/infracode-test-sessions"` so normal tests pass

**Git verification:** `git ls-files apps/api/data/` returns empty — no session files tracked.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Remove HTTP query-string token acceptance (SEC-04 Test I) | 8ec5a7d | apps/api/src/plugins/auth.ts, apps/api/test/security.test.ts |
| 2 | DATA_DIR startup assertion + update test setup (SEC-04 Test H) | 21d7924 | apps/api/src/app.ts, apps/api/test/setup.ts |

## Verification Results

- `grep "isWebSocketUpgrade" apps/api/src/plugins/auth.ts` — present (line 70)
- `grep "request.headers.upgrade" apps/api/src/plugins/auth.ts` — present
- `grep "query?.accessToken" apps/api/src/plugins/auth.ts` — inside WebSocket ternary only (no unconditional fallback)
- `grep "resolve.*DATA_DIR" apps/api/src/app.ts` — present (line 54)
- `grep "dataDir.startsWith" apps/api/src/app.ts` — present (line 57)
- `grep "process.exit" apps/api/src/app.ts` — present in assertion block (line 72)
- `grep "DATA_DIR" apps/api/test/setup.ts` — `/tmp/infracode-test-sessions` (outside repo)
- `git ls-files apps/api/data/` — empty (no tracked session files)
- SEC-04 Test H (startup assertion): GREEN
- SEC-04 Test I (query-string rejection): GREEN
- All 9 security tests: GREEN (SEC-01: 2, SEC-02: 2, SEC-03: 3, SEC-04: 2)
- Full test suite: 34 passed, 2 skipped, 0 failed
- `pnpm tsc --noEmit` — exit 0

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Used path.sep instead of hardcoded '/' for cross-platform DATA_DIR assertion**
- **Found during:** Task 2 — testing the assertion on Windows
- **Issue:** The plan specified `dataDir.startsWith(projectRoot + '/')`, but Windows `path.resolve()` returns backslash-separated paths. The assertion `startsWith(projectRoot + '/')` never fired on Windows because `\` != `/`.
- **Fix:** Changed to `dataDir.startsWith(projectRoot + sep)` using `path.sep` imported from `node:path`. Both Unix (`/`) and Windows (`\`) now work correctly.
- **Files modified:** apps/api/src/app.ts
- **Commit:** 21d7924

**2. [Rule 1 - Bug] Replaced createLogger with console.error in the DATA_DIR fatal block**
- **Found during:** Task 2 — test H still failing after assertion fired
- **Issue:** The plan suggested `app.log.fatal(...)` but at assertion time there is no Fastify app instance yet. The plan's alternative used `createLogger(config)` which creates a pino logger. This worked at the code level but during the test the `process.exit` mock threw an error that was caught by pino's internal transport, causing a secondary Fastify error "Cannot read properties of undefined (reading 'family')" instead of propagating "process.exit called".
- **Fix:** Replaced `createLogger(config)` + `logger.fatal(...)` with `console.error(JSON.stringify({level:'fatal',...}))`. The fatal message is still emitted to stderr as JSON (grep-able in production), but the code path has no Fastify/pino dependencies that can interfere with the `process.exit` mock's thrown error.
- **Files modified:** apps/api/src/app.ts
- **Commit:** 21d7924

## Known Stubs

None — all SEC-04 functionality is fully implemented and tested. Phase 1 (all 4 plans) is complete.

## Threat Flags

None — this plan only narrows existing auth surface and adds a startup gate. No new network endpoints, auth paths, file access patterns, or schema changes introduced.

## Self-Check: PASSED

- [x] `apps/api/src/plugins/auth.ts` exists and contains `isWebSocketUpgrade`
- [x] `apps/api/src/app.ts` exists and contains `dataDir.startsWith(projectRoot`
- [x] `apps/api/test/security.test.ts` exists and contains SEC-04 tests
- [x] `apps/api/test/setup.ts` updated with `/tmp/infracode-test-sessions`
- [x] Commit 8ec5a7d exists (Task 1)
- [x] Commit 21d7924 exists (Task 2)
- [x] All 9 security tests GREEN
- [x] Full test suite: 34 passed, 0 failed
- [x] `git ls-files apps/api/data/` returns empty
