---
phase: 02-crm-identity-data-integrity
plan: "04"
subsystem: tenant-schema-migrations
tags: [migrations, schema, tenant, versioning, idempotency]
dependency_graph:
  requires: ["02-00"]
  provides: ["per-tenant versioned schema migrations", "runMigrations()", "MIGRATIONS[]", "schema_migrations table"]
  affects: ["apps/api/src/lib/database.ts", "apps/api/src/app.ts", "apps/api/src/lib/tenant-schema.ts"]
tech_stack:
  added: []
  patterns: ["versioned migration tracking via schema_migrations PRIMARY KEY", "D-MIGRATION-FAIL: per-tenant error isolation", "idempotent migrations via appliedSet filter"]
key_files:
  created:
    - apps/api/src/lib/run-migrations.ts
  modified:
    - apps/api/src/lib/tenant-schema.ts
    - apps/api/src/lib/database.ts
    - apps/api/src/app.ts
    - apps/api/src/lib/__tests__/run-migrations.test.ts
decisions:
  - "Logger added to TenantPrismaRegistry constructor (Rule 2: needed for structured error logging in ensureSchema)"
  - "Migration startup loop skipped in NODE_ENV=test to avoid DB calls in unit tests"
  - "Comment in tenant-schema.ts documents that ALTER TABLE is now managed via run-migrations.ts"
metrics:
  duration: "~25 minutes"
  completed_date: "2026-04-13"
  tasks_completed: 2
  files_modified: 5
---

# Phase 02 Plan 04: Per-Tenant Schema Migration Tracking Summary

**One-liner:** Versioned schema migration system (`schema_migrations` table + `runMigrations()`) replacing 34 unversioned `ALTER TABLE` statements, with startup enumeration and per-tenant error isolation per D-MIGRATION-FAIL.

## What Was Built

### Task 1: runMigrations() and MIGRATIONS array

Created `apps/api/src/lib/run-migrations.ts` with:

- `MIGRATIONS[]` — 34 versioned entries covering every `ALTER TABLE` previously in `buildTenantSchemaSql()`, ordered by version string ascending (`2026-04-11-001-*` through `2026-04-11-034-*`)
- `runMigrations(platformPrisma, tenantId, logger)` — creates `schema_migrations` table if absent, fetches applied set, skips applied versions, applies pending migrations in order
- Returns `"success"` | `"skipped"` | `"failed"` (never throws — per D-MIGRATION-FAIL)
- Structured error log `{ tenantId, migration, error }` at Pino error level on failure
- Schema name validated against `/^tenant_[a-z0-9_]+$/i` before use (T-02-04-01 injection mitigation)

Updated `apps/api/src/lib/tenant-schema.ts`:
- Stripped all 34 `ALTER TABLE IF NOT EXISTS` statements from `buildTenantSchemaSql()`
- Retained all `CREATE TABLE IF NOT EXISTS` baseline statements (15 tables + indexes)
- Added comment documenting that ALTER TABLE is now managed via run-migrations.ts

Tests: `run-migrations.test.ts` turned GREEN (6/6 assertions passing)

### Task 2: Startup wiring and ensureSchema() integration

Updated `apps/api/src/app.ts`:
- Import `runMigrations` from `./lib/run-migrations.js`
- At startup (after services init, before `return app`): enumerate all tenants via `platformPrisma.tenant.findMany()`
- Call `runMigrations()` for each tenant with defensive `.catch()` wrapper
- Log startup summary: `{ migrations: [...] }` with count of applied/skipped/failed
- Log `warn` if any tenants failed — startup continues (D-MIGRATION-FAIL)
- Skipped in `NODE_ENV=test` to avoid DB calls in unit test environments

Updated `apps/api/src/lib/database.ts`:
- Added `pino` type import
- Added `logger: pino.Logger` field to `TenantPrismaRegistry`
- Constructor now accepts `logger` as third parameter
- `ensureSchema()` calls `runMigrations(platformPrisma, tenantId, this.logger)` after baseline table creation
- Ensures both startup (all tenants) and lazy provisioning (new tenants on first access) apply all migrations

## Deviations from Plan

### Auto-added: Logger parameter to TenantPrismaRegistry constructor

**Found during:** Task 2
**Rule:** Rule 2 — missing critical functionality (structured logging required for runMigrations call in ensureSchema)
**Fix:** Added `logger: pino.Logger` as third constructor parameter to `TenantPrismaRegistry`; updated `app.ts` to pass `logger` at construction site
**Files modified:** `apps/api/src/lib/database.ts`, `apps/api/src/app.ts`
**Commits:** 1caf327

### Auto-fixed: TypeScript type error in test destructuring

**Found during:** Task 1 TypeScript check
**Rule:** Rule 1 — type error in test file
**Fix:** Changed `([sql]: [string]) => ...` to `(args: unknown[]) => { const sql = args[0] as string; ... }` in the "applies only unapplied migrations" test
**Files modified:** `apps/api/src/lib/__tests__/run-migrations.test.ts`
**Commits:** 85aafa4

## Known Stubs

None — all migrations are real SQL, runMigrations() is fully implemented, startup loop is wired.

## Threat Flags

No new threat surface beyond what was documented in the plan's threat model (T-02-04-01 through T-02-04-05 all addressed in implementation).

## Self-Check: PASSED

- FOUND: apps/api/src/lib/run-migrations.ts
- FOUND: apps/api/src/lib/tenant-schema.ts
- FOUND: apps/api/src/lib/__tests__/run-migrations.test.ts
- FOUND: apps/api/src/app.ts
- FOUND: apps/api/src/lib/database.ts
- FOUND commit 85aafa4: feat(02-04): implement runMigrations() + MIGRATIONS array, strip ALTER TABLE from baseline
- FOUND commit 1caf327: feat(02-04): wire runMigrations() into API startup and ensureSchema()
