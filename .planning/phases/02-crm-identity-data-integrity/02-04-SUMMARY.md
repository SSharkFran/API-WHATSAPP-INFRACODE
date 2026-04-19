---
phase: 02-crm-identity-data-integrity
plan: "04"
subsystem: api-migrations
tags: [migrations, tenant-schema, versioning, startup]
dependency_graph:
  requires: [02-00]
  provides: [versioned-tenant-schema-migrations, run-migrations-function]
  affects: [all-subsequent-phases-adding-tenant-columns]
tech_stack:
  added: []
  patterns: [schema_migrations-table, idempotent-migration-runner, D-MIGRATION-FAIL]
key_files:
  created: []
  modified:
    - apps/api/src/lib/run-migrations.ts
    - apps/api/src/lib/tenant-schema.ts
    - apps/api/src/lib/__tests__/run-migrations.test.ts
    - apps/api/src/app.ts
    - apps/api/src/lib/database.ts
decisions:
  - "D-MIGRATION-FAIL: failing tenant migrations log structured error and are skipped — API startup continues"
  - "MIGRATIONS[] ordered by version string ascending — lexicographic order guarantees apply order"
  - "schema name validated via /^tenant_[a-z0-9_]+$/i before SQL execution to prevent injection (T-02-04-01)"
metrics:
  duration_minutes: 15
  completed_date: "2026-04-19"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
---

# Phase 02 Plan 04: Per-Tenant Schema Migration Tracking Summary

**One-liner:** Versioned schema migration system using `schema_migrations` table, converting 37 ALTER TABLE statements to 41 MIGRATIONS[] entries, with idempotent startup runner and per-tenant error isolation.

## What Was Built

### Task 1: runMigrations() and MIGRATIONS array (TDD GREEN)

`apps/api/src/lib/run-migrations.ts` was already implemented (from a prior execution). This task:

1. **Turned the test file GREEN** — `apps/api/src/lib/__tests__/run-migrations.test.ts` had 6 RED stubs; replaced them with real assertions using a mock `pino.Logger` (avoiding runtime pino import in worktree context).

2. **Stripped ALTER TABLE from tenant-schema.ts** — removed all 37 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements from `buildTenantSchemaSql()`. The baseline now returns only `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements. A comment documents: "ALTER TABLE migrations are now managed via run-migrations.ts MIGRATIONS[]."

3. **MIGRATIONS[] has 41 entries** covering:
   - 10 Conversation table columns (001–010)
   - 23 ChatbotConfig table columns (011–033)
   - 1 TenantKnowledge column (034)
   - 4 ConversationSession columns (035–038)
   - 3 Contact columns for rawJid support (039–041)

The `runMigrations()` function:
- Creates `schema_migrations` table if absent
- Fetches applied versions into a Set
- Skips already-applied migrations (idempotent)
- Returns `"success"` | `"skipped"` | `"failed"`
- Catches errors per-migration, logs `{ tenantId, migration, error }` at Pino error level
- Never throws — per D-MIGRATION-FAIL decision

### Task 2: Wire into API startup (already implemented)

`apps/api/src/app.ts` already had the startup loop (from prior execution):
- Fetches all tenants via `platformPrisma.tenant.findMany()`
- Calls `runMigrations()` for each tenant
- Logs summary: `{ migrations: [{ tenantId, status }] }`
- Warns on failed tenants without exiting
- Skipped in `NODE_ENV=test`

`apps/api/src/lib/database.ts` `ensureSchema()` already calls `runMigrations()` after the CREATE TABLE baseline (for lazy tenant provisioning).

## Test Results

```
apps/api/src/lib/__tests__/run-migrations.test.ts
  runMigrations
    ✓ returns 'success' when all migrations applied without error
    ✓ returns 'skipped' when all migrations already applied
    ✓ catches per-tenant error and returns 'failed' without throwing
    ✓ logs structured { tenantId, migration, error } at error level on failure
    ✓ applies only unapplied migrations (version tracking)
    ✓ creates schema_migrations table if absent before reading applied versions

Test Files: 1 passed (1)
Tests: 6 passed (6)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test used real pino import which fails in worktree context**
- **Found during:** Task 1 GREEN phase
- **Issue:** `import pino from "pino"` in test file failed with `ERR_MODULE_NOT_FOUND` because the worktree has no local `node_modules`; pino is in `apps/api/node_modules` of the main project
- **Fix:** Replaced real pino import with `import type pino from "pino"` and created a `makeLogger()` factory that returns a `vi.fn()`-backed mock compatible with the `pino.Logger` interface
- **Files modified:** `apps/api/src/lib/__tests__/run-migrations.test.ts`
- **Commit:** d77e866

**2. [Rule 1 - Bug] Test filter for "applies only unapplied migrations" undercounted**
- **Found during:** Task 1 first GREEN run
- **Issue:** Filter checked `sql.includes("CREATE INDEX")` but migration 040 uses `CREATE UNIQUE INDEX` (substring doesn't match)
- **Fix:** Added `sql.includes("CREATE UNIQUE INDEX")` to the filter
- **Files modified:** `apps/api/src/lib/__tests__/run-migrations.test.ts`
- **Commit:** d77e866

**3. [Note] Task 2 was already implemented**
- `app.ts` and `database.ts` already had `runMigrations()` integrated from a prior execution
- No new commit needed for Task 2 — verified criteria all pass (3 lines in app.ts, 2 lines in database.ts, summary log present, no throw/exit near migration block)

## Threat Mitigations Applied

| Threat | Mitigation |
|--------|-----------|
| T-02-04-01 (SQL Injection) | Schema name validated via `/^tenant_[a-z0-9_]+$/i` before any SQL execution; migration SQL is static strings |
| T-02-04-04 (Version Collision) | version is PRIMARY KEY in schema_migrations — duplicate insert raises unique constraint error, caught and logged |

## Known Stubs

None — all data flows are wired.

## Self-Check: PASSED

- `apps/api/src/lib/run-migrations.ts` — exists, exports `runMigrations` and `MIGRATIONS`
- `apps/api/src/lib/tenant-schema.ts` — no ALTER TABLE SQL statements (only comments)
- `apps/api/src/lib/__tests__/run-migrations.test.ts` — 6/6 tests GREEN
- `apps/api/src/app.ts` — `runMigrations` imported and called with startup summary log
- `apps/api/src/lib/database.ts` — `runMigrations` called in `ensureSchema()`
- Commit d77e866 exists in git log
