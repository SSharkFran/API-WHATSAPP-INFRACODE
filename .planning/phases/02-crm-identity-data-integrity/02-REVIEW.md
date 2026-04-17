---
phase: 02-crm-identity-data-integrity
reviewed: 2026-04-16T00:00:00Z
depth: standard
files_reviewed: 18
files_reviewed_list:
  - apps/api/src/app.ts
  - apps/api/src/lib/__tests__/run-migrations.test.ts
  - apps/api/src/lib/database.ts
  - apps/api/src/lib/format-phone.ts
  - apps/api/src/lib/run-migrations.ts
  - apps/api/src/lib/tenant-schema.ts
  - apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts
  - apps/api/src/modules/crm/__tests__/format-phone.test.ts
  - apps/api/src/modules/crm/__tests__/lid-normalization.test.ts
  - apps/api/src/modules/crm/routes.ts
  - apps/api/src/modules/instances/service.ts
  - apps/api/src/queues/lid-reconciliation-queue.ts
  - apps/api/src/queues/queue-names.ts
  - apps/api/src/workers/lid-reconciliation.worker.ts
  - apps/panel/components/tenant/crm-screen.tsx
  - apps/panel/lib/format-phone.ts
  - prisma/schema.prisma
  - prisma/tenant.prisma
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-04-16T00:00:00Z
**Depth:** standard
**Files Reviewed:** 18
**Status:** issues_found

## Summary

The phase introduces the CRM identity data-integrity layer: `@lid` contact normalization, LID reconciliation via BullMQ, a versioned migration system, and the CRM read/write routes with N+1 fix. The overall architecture is sound and the security-sensitive paths (tenantId verification in `reconcileLidContact`, schema injection guard in `run-migrations.ts`) are well-handled.

Four issues require attention before ship:

1. **Critical** — The migration version string is interpolated raw into a SQL INSERT without escaping. A malformed version value (even one that slips past the codebase's own conventions) could allow SQL injection at migration-record time.
2. **Warning** — `contact.rawJid!` non-null assertion in the worker fires on a value that was fetched with `rawJid: { not: null }` but TypeScript still types it as `string | null`, meaning any runtime inconsistency (e.g. a race delete between the `findMany` and the loop body) would produce an unhandled exception that bypasses the per-contact `try/catch`.
3. **Warning** — The inline `formatPhone` in `crm-screen.tsx` diverges from both `apps/panel/lib/format-phone.ts` and `apps/api/src/lib/format-phone.ts` for short digit sequences: it returns the raw digits rather than "Contato desconhecido", which means LID-style numeric IDs can appear raw in the UI.
4. **Warning** — `console.log` (not the structured logger) is used on the hot path in `service.ts` at the LID reconciliation enqueue point and elsewhere in the same file — these will not appear in structured JSON logs in production (Railway/Logtail).
5. **Warning** — `tenant-schema.ts` executes bare `ALTER TABLE` statements outside a transaction in `buildTenantSchemaSql`. Two of these statements are duplicates of what `CREATE TABLE IF NOT EXISTS` already defines (the `phoneNumber` NOT NULL drop and `rawJid` column), creating harmless but confusing redundancy — and the `DO $$ … $$` deduplication guard for the unique constraint is fragile against concurrent provisioning.

---

## Critical Issues

### CR-01: SQL Injection via Unparameterized Migration Version in INSERT

**File:** `apps/api/src/lib/run-migrations.ts:307`
**Issue:** The `INSERT INTO schema_migrations ("version") VALUES (...)` statement is built by string interpolation of `migration.version`, not by a parameterized query. Although all current version strings are controlled by the codebase, the code establishes a pattern where any migration version that contains a single quote (e.g. `it's-broken`) would break the SQL, and a version containing `'); DROP TABLE ...` would be executable. The `$executeRawUnsafe` name itself flags that no sanitization occurs.

```typescript
// Current — vulnerable pattern:
await platformPrisma.$executeRawUnsafe(
  `INSERT INTO ${quoteSchema(schema)}."schema_migrations" ("version") VALUES ('${migration.version}');`
);

// Fix — use a parameterized query via $queryRawUnsafe / tagged template, or escape the value:
await platformPrisma.$executeRawUnsafe(
  `INSERT INTO ${quoteSchema(schema)}."schema_migrations" ("version") VALUES ($1);`,
  migration.version
);
```

Prisma's `$executeRawUnsafe` accepts positional parameters as additional arguments — this is the correct low-level escape hatch.

---

## Warnings

### WR-01: Non-null Assertion on `contact.rawJid` Can Throw Past Per-Contact Try/Catch

**File:** `apps/api/src/workers/lid-reconciliation.worker.ts:69`
**Issue:** `contact.rawJid!` uses a TypeScript non-null assertion on a field typed as `string | null`. The `findMany` query uses `rawJid: { not: null }` to filter, so the value should never be null at that point. However, if a concurrent operation deletes or nullifies the contact between the `findMany` and the loop body, TypeScript's assertion passes silently and the `null` value is forwarded to `reconcileLidContact` with type `string`, bypassing the per-contact `try/catch`. The result is an uncaught exception that fails the entire BullMQ job.

```typescript
// Current:
await deps.instanceOrchestrator.reconcileLidContact(
  tenantId,
  instanceId,
  contact.rawJid!,   // non-null assertion — can throw at runtime
  sharedPhoneJid
);

// Fix — add a defensive guard:
const rawJid = contact.rawJid;
if (!rawJid) {
  logger.warn({ instanceId, contactId: contact.id }, "LID reconciliation: rawJid became null — skipping");
  continue;
}
await deps.instanceOrchestrator.reconcileLidContact(tenantId, instanceId, rawJid, sharedPhoneJid);
```

### WR-02: Inline `formatPhone` in `crm-screen.tsx` Diverges from Canonical Implementation

**File:** `apps/panel/components/tenant/crm-screen.tsx:88-95`
**Issue:** The local `formatPhone` helper used inside `crm-screen.tsx` is a different implementation from `apps/panel/lib/format-phone.ts` (which is the canonical UI copy of the API contract). The local version has this branch:

```typescript
if (digits.length > 13) return digits; // LID / número estranho — exibe cru
```

This means any digit string longer than 13 characters (e.g. a raw LID numeric ID `19383773123456789` or a malformed JID numeric prefix) is rendered as-is in the UI. The canonical `formatPhone` in `panel/lib/format-phone.ts` returns `"Contato desconhecido"` for these cases, which is the locked contract from `02-UI-SPEC.md` (D-FORMAT). The `ContactCard` component uses the local `formatPhone`, while other display paths use the canonical one — inconsistent behavior depending on rendering path.

**Fix:** Remove the local `formatPhone` from `crm-screen.tsx` and import from `../../lib/format-phone`:

```typescript
// Remove lines 88-95 (local formatPhone definition)
// Add import:
import { formatPhone } from "../../lib/format-phone";
```

The `apps/panel/lib/format-phone.ts` already handles all cases including LID-short digits correctly.

### WR-03: `console.log` on Hot Path Bypasses Structured Logger

**File:** `apps/api/src/modules/instances/service.ts:1294`
**Issue:** The LID reconciliation enqueue uses `console.log` rather than the structured `pino` logger. The same pattern appears at lines 1220, 1245, 1294, 1352, 1513, 1531, 1759, 1809 (and others). In production (Railway), the app's JSON logger is piped to log aggregation; `console.log` output is either lost or appears as unstructured plain text. The line at 1294 also logs the `instanceId` on every `CONNECTED` event, which is a medium-frequency hot path.

```typescript
// Current (line 1294):
console.log("[lid-reconciliation] CONNECTED event — enqueuing reconciliation job", {
  instanceId: instance.id,
  event: "CONNECTED"
});

// Fix — use the class-level logger or the request logger:
// The InstanceOrchestrator has no instance logger stored. Either:
// 1. Accept a logger in the constructor (preferred), or
// 2. Use a module-level logger created from createLogger.
// Minimal fix — remove the console.log (the enqueue itself is observable):
// The info-level log in the worker already confirms enqueueing; this one is redundant.
```

The `console.warn` calls on error paths (lines 1288, 1352) are similarly affected — those should at minimum use `console.error` to appear in Railway stderr, but ideally use the structured logger.

### WR-04: Redundant and Potentially Race-Prone DDL in `tenant-schema.ts`

**File:** `apps/api/src/lib/tenant-schema.ts:115-117`
**Issue:** Three statements execute unconditionally after the `CREATE TABLE IF NOT EXISTS "Contact"` block:

```sql
ALTER TABLE "Contact" ALTER COLUMN "phoneNumber" DROP NOT NULL;
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "rawJid" TEXT;
DO $$ BEGIN IF NOT EXISTS (...) THEN ALTER TABLE "Contact" ADD CONSTRAINT ... END IF; END $$;
```

The `CREATE TABLE IF NOT EXISTS` on lines 101-114 already defines `"phoneNumber" TEXT` (nullable) and includes `"rawJid" TEXT` and the `UNIQUE` constraint on `rawJid`. These three `ALTER TABLE` statements are dead on a fresh schema and only serve as backfills for schemas created before `rawJid` was added. The problem is:

1. They run outside a transaction, so a concurrent tenant provisioning call can fail with a duplicate constraint error between the `DO $$ IF NOT EXISTS` check and the `ALTER TABLE ADD CONSTRAINT` execution.
2. They add noise to every schema ensure call, even when idempotent.

**Fix:** Move these backfill alters into the versioned `MIGRATIONS` array in `run-migrations.ts` with a version like `"2026-04-11-000-contact-rawjid-backfill"` (ordered before the existing ones), and remove them from `buildTenantSchemaSql`. The `CREATE TABLE IF NOT EXISTS` definition already has the correct baseline.

---

## Info

### IN-01: Schema/Prisma Model Divergence — `ConversationSession` Missing FK in `tenant.prisma`

**File:** `prisma/tenant.prisma:272-287`
**Issue:** The `ConversationSession` model in `tenant.prisma` declares `conversationId String?` but has no `@relation` to `Conversation`. The `buildTenantSchemaSql` raw SQL (line 252) defines a foreign key `REFERENCES "Conversation"("id") ON DELETE SET NULL`, so the physical DB has referential integrity. However, the Prisma client does not — `prisma.conversationSession` cannot `.include({ conversation: ... })` in TypeScript, which means any future query that tries to join through this relation will fail silently or require raw SQL. Consider adding the `@relation` and the back-reference to `Conversation`.

### IN-02: `schema.prisma` Platform Model Missing CRM Fields Added by Tenant Migrations

**File:** `prisma/schema.prisma:243-260`
**Issue:** The platform `schema.prisma` `Contact` model does not include `rawJid`. The `Conversation` model does not include `phoneNumber`, `humanTakeover`, `leadSent`, etc. Since the platform schema is a separate Postgres schema from the tenant schemas, this is structurally correct (tenant data lives in tenant schemas). However, the mismatch means any code that accidentally calls `platformPrisma.contact` instead of a tenant prisma client will silently query rows without the new columns and won't fail at compile time. This is a documentation/clarity issue, not a runtime bug.

### IN-03: `debug` `console.log` Left in Production Code Path

**File:** `apps/api/src/modules/instances/service.ts:1294`
**Issue:** This specific `console.log` (distinct from the structured-logger issue in WR-03) was noted in the recent commit history (`debug: use console.error to expose lifecycle error messages`) as an intentional debug artifact. Now that the feature is stabilized, the log at line 1294 should be downgraded to debug level or removed to avoid log noise on every reconnect event in production multi-tenant deployments.

---

_Reviewed: 2026-04-16T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
