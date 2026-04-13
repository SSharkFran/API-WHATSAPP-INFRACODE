---
phase: 02-crm-identity-data-integrity
plan: "01"
subsystem: crm-identity
tags: [prisma-schema, bullmq, lid-normalization, contact-upsert]
dependency_graph:
  requires: [02-00]
  provides: [rawJid-schema, lid-reconciliation-queue, lid-aware-upsert]
  affects: [prisma/tenant.prisma, prisma/schema.prisma, apps/api/src/modules/instances/service.ts]
tech_stack:
  added: [lid-reconciliation-queue.ts, BullMQ Worker for LID_RECONCILIATION]
  patterns: [BullMQ jobId dedup, Prisma dual-unique-index upsert fork, tenant-isolation verify in worker]
key_files:
  created:
    - apps/api/src/queues/lid-reconciliation-queue.ts
  modified:
    - prisma/schema.prisma
    - prisma/tenant.prisma
    - apps/api/src/lib/tenant-schema.ts
    - apps/api/src/queues/queue-names.ts
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/app.ts
    - apps/api/src/modules/crm/__tests__/lid-normalization.test.ts
decisions:
  - "Prisma dual-unique-index strategy: @@unique([instanceId,phoneNumber]) + @@unique([instanceId,rawJid]) on Contact — non-LID path uses phone-based index, LID path uses rawJid index"
  - "Worker method processLidReconciliation on InstanceOrchestrator — calls persistLidPhoneMapping, never duplicates merge logic"
  - "BullMQ dedup via jobId: lid-reconcile:{instanceId} — second CONNECTED event silently skipped"
  - "Tenant schema SQL updated with ADD COLUMN IF NOT EXISTS + DROP NOT NULL for existing tenant DBs"
  - "db push deferred to staging environment — no .env in worktree; schema is validated"
metrics:
  duration: ~25min
  completed: 2026-04-13T13:49:00Z
  tasks_completed: 2
  files_modified: 7
  files_created: 1
---

# Phase 02 Plan 01: LID/JID Normalization at Ingestion — Summary

**One-liner:** Prisma Contact schema gains `rawJid String?` + nullable `phoneNumber` with dual unique indexes; service.ts forks upsert on `@lid` JID (phoneNumber=null, rawJid=remoteJid) and enqueues deduped BullMQ reconciliation job on each CONNECTED event.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Prisma schema change — rawJid + nullable phoneNumber | a880474 | schema.prisma, tenant.prisma, tenant-schema.ts |
| 2 | LID-aware upsert + BullMQ reconciliation queue/worker | 35f5c7d | queue-names.ts, lid-reconciliation-queue.ts, service.ts, app.ts, lid-normalization.test.ts |

## What Was Built

### Task 1: Prisma Schema

Both `prisma/schema.prisma` (platform) and `prisma/tenant.prisma` (tenant) Contact models updated:
- `phoneNumber String?` — made nullable (was `String`)
- `rawJid String?` — new field added after phoneNumber
- `@@unique([instanceId, rawJid])` — new unique constraint alongside existing `@@unique([instanceId, phoneNumber])`

`apps/api/src/lib/tenant-schema.ts` updated with idempotent SQL migrations:
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS "rawJid" TEXT`
- `ALTER TABLE ... ALTER COLUMN "phoneNumber" DROP NOT NULL`
- Unique constraint added via DO $$ IF NOT EXISTS $$ block

Prisma schema validation passes for both schemas.

### Task 2: LID-Aware Upsert and Reconciliation Queue

**queue-names.ts:** Added `LID_RECONCILIATION: "lid-reconciliation"` constant.

**lid-reconciliation-queue.ts:** New BullMQ queue factory following message-queue.ts pattern exactly.

**service.ts changes:**
- Import: `type Job` from bullmq, `createLidReconciliationQueue` from queues
- Property: `private readonly lidReconciliationQueue: Queue` initialized in constructor
- CONNECTED hook: enqueues `lid-reconcile:{instanceId}` job with BullMQ jobId dedup
- `handleInboundMessage` upsert fork: `isLid` check routes to `instanceId_rawJid` unique index with `phoneNumber: null` when `remoteJid.endsWith("@lid")`; non-LID path stores `rawJid` in create path for future message history fallback
- `processLidReconciliation` method: finds contacts with `phoneNumber=null, rawJid!=null`, verifies tenantId/instanceId ownership (T-02-01-02), calls `persistLidPhoneMapping()` for each resolvable contact, logs only rawJid (T-02-01-05)

**app.ts:** BullMQ Worker registered for `LID_RECONCILIATION` queue, closed in `onClose` hook.

**Tests:** 9 tests GREEN — stubs replaced with real assertions testing:
- phoneNumber=null for @lid upsert
- rawJid stored correctly  
- @lid digits never written to phoneNumber
- instanceId_rawJid where clause used for @lid
- BullMQ jobId dedup (same deterministic jobId for same instanceId)
- persistLidPhoneMapping called for resolvable contacts
- Contacts without sharedPhoneJid skipped gracefully

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Added tenant/instance ownership verification in reconciliation worker**
- **Found during:** Task 2 — threat model T-02-01-02 requires worker to verify tenantId matches instanceId's actual tenant
- **Fix:** Added `platformPrisma.instance.findUnique` check at start of `processLidReconciliation` — mismatched tenantId returns early with warning log
- **Files modified:** apps/api/src/modules/instances/service.ts
- **Commit:** 35f5c7d

**2. [Rule 2 - Missing functionality] Added 2 extra test cases for worker logic**
- **Found during:** Task 2 — plan stubs had 7 tests but worker reconciliation behavior needed coverage
- **Fix:** Added tests for `persistLidPhoneMapping` call and sharedPhoneJid skip behavior
- **Files modified:** apps/api/src/modules/crm/__tests__/lid-normalization.test.ts
- **Commit:** 35f5c7d

**3. [Deviation - Environment] `prisma db push` not executed**
- `prisma db push --accept-data-loss` requires a live PostgreSQL connection. No `.env` file exists in this worktree. Schema was validated with `npx prisma validate` (both schemas exit 0). The `db push` must be run in the staging environment where DATABASE_URL and TENANT_DATABASE_URL are configured.
- Tenant schema SQL migrations in `tenant-schema.ts` cover all existing tenant databases on first connection.

## Known Stubs

None — all plan stubs replaced with real assertions.

## Threat Flags

No new threat surface beyond the plan's threat model. All T-02-01-xx mitigations applied:
- T-02-01-02 (tenantId verification): implemented in `processLidReconciliation`
- T-02-01-04 (DoS via rapid reconnects): BullMQ jobId dedup implemented
- T-02-01-05 (phone in error logs): only rawJid logged in reconciliation worker

rawJid exposed in the Contact record — T-02-01-01 notes this must be audited in Plan 2.2 (API response mappers must not leak rawJid to UI).

## Self-Check: PASSED

| Item | Status |
|------|--------|
| prisma/schema.prisma | FOUND |
| prisma/tenant.prisma | FOUND |
| apps/api/src/queues/lid-reconciliation-queue.ts | FOUND |
| apps/api/src/modules/crm/__tests__/lid-normalization.test.ts | FOUND |
| .planning/phases/02-crm-identity-data-integrity/02-01-SUMMARY.md | FOUND |
| commit a880474 | FOUND |
| commit 35f5c7d | FOUND |
| rawJid in tenant.prisma (2 lines) | FOUND |
| phoneNumber String? in Contact model | FOUND |
| 9 tests GREEN | PASSED |
