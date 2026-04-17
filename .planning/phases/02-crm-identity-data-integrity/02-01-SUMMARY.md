---
phase: 02-crm-identity-data-integrity
plan: "01"
subsystem: crm-identity
tags: [prisma, bullmq, lid-normalization, contact-schema, queue]
dependency_graph:
  requires: ["02-00"]
  provides: ["rawJid-schema", "lid-reconciliation-queue", "lid-aware-upsert"]
  affects: ["apps/api/src/modules/instances/service.ts", "prisma/schema.prisma", "prisma/tenant.prisma"]
tech_stack:
  added: ["lid-reconciliation-queue (BullMQ)", "LidReconciliationWorker"]
  patterns: ["BullMQ jobId deduplication", "@lid-fork upsert pattern", "reconcileLidContact public wrapper"]
key_files:
  created:
    - apps/api/src/queues/lid-reconciliation-queue.ts
    - apps/api/src/workers/lid-reconciliation.worker.ts
  modified:
    - prisma/schema.prisma
    - prisma/tenant.prisma
    - apps/api/src/lib/tenant-schema.ts
    - apps/api/src/queues/queue-names.ts
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/app.ts
    - apps/api/src/modules/crm/__tests__/lid-normalization.test.ts
decisions:
  - "@lid upsert uses instanceId_rawJid unique index — never writes LID digits to phoneNumber"
  - "BullMQ jobId lid-reconcile:{instanceId} deduplicates rapid reconnect events (T-02-01-04)"
  - "reconcileLidContact public method delegates to private persistLidPhoneMapping — no logic duplication"
  - "Tenant schema ALTER TABLE migrations add rawJid + drop NOT NULL on phoneNumber for existing tenants"
  - "Prisma CLI unavailable in worktree environment — db push must run via start:db-push script on deploy"
metrics:
  duration: "~45 minutes"
  completed: "2026-04-16"
  tasks_completed: 2
  files_modified: 7
  files_created: 2
---

# Phase 02 Plan 01: LID/JID Normalization at Ingestion — Summary

## One-liner

@lid JID ingestion now stores rawJid + phoneNumber=null via BullMQ-deduped reconciliation queue; all 7 unit tests GREEN.

## What Was Built

### Task 1: Prisma Schema — rawJid + nullable phoneNumber

Both platform (`prisma/schema.prisma`) and tenant (`prisma/tenant.prisma`) Contact models were updated:
- `phoneNumber String` → `phoneNumber String?` (nullable)
- `rawJid String?` added as new field
- `@@unique([instanceId, rawJid])` added as second unique constraint alongside existing `@@unique([instanceId, phoneNumber])`

`apps/api/src/lib/tenant-schema.ts` received three idempotent migration statements for existing tenant schemas:
- `ALTER TABLE ... ALTER COLUMN "phoneNumber" DROP NOT NULL`
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS "rawJid" TEXT`
- `DO $$ BEGIN ... ADD CONSTRAINT uniq_..._instance_raw_jid UNIQUE ... END $$` (safe re-entrant)

The `CREATE TABLE IF NOT EXISTS` block was also updated so newly-provisioned tenant schemas start correct.

### Task 2: LID-aware upsert + BullMQ reconciliation queue and worker

**queue-names.ts**: Added `LID_RECONCILIATION: "lid-reconciliation"` constant.

**lid-reconciliation-queue.ts**: New queue factory following exact same pattern as `message-queue.ts` — attempts: 3, exponential backoff 5s, removeOnComplete: 10, removeOnFail: 100.

**service.ts — CONNECTED hook**: After existing webhook/alert dispatch, enqueues `lid-reconcile:{instanceId}` job. BullMQ jobId deduplication silently drops duplicate jobs on rapid reconnects (T-02-01-04).

**service.ts — handleInboundMessage upsert fork**: Detects `event.remoteJid.endsWith("@lid")` and branches:
- `@lid` path: upserts via `instanceId_rawJid` index with `phoneNumber: null`, `rawJid: event.remoteJid`
- Non-LID path: existing `instanceId_phoneNumber` upsert, now also writes `rawJid` in create path (enables Plan 2.3 fallback)

**service.ts — reconcileLidContact public method**: Wraps `persistLidPhoneMapping` with tenant validation (T-02-01-02) so the worker can call it without duplicating merge logic.

**lid-reconciliation.worker.ts**: Worker processor that finds `{ phoneNumber: null, rawJid: { not: null } }` contacts, checks for `sharedPhoneJid` in fields, and calls `instanceOrchestrator.reconcileLidContact()`. Logs only rawJid (opaque LID string) and counts — never resolved phoneNumber (T-02-01-05).

**app.ts**: Wires `lidReconciliationQueue` into `InstanceOrchestrator` deps, registers `BullWorker` with `redis.duplicate()` connection, closes both queue and worker in `onClose` hook.

**lid-normalization.test.ts**: All 7 RED stubs turned GREEN — covers phoneNumber=null, rawJid storage, no LID digits in phoneNumber, instanceId_rawJid where clause, BullMQ jobId dedup pattern.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Tenant schema migration statements needed**
- **Found during:** Task 1
- **Issue:** Plan referenced `apps/api/src/db/tenant-schema.ts` but actual path is `apps/api/src/lib/tenant-schema.ts`. The file manages tenant schema provisioning via raw SQL — existing tenant schemas need migration, not just new ones.
- **Fix:** Added three idempotent ALTER TABLE statements after the CREATE TABLE block. Also updated the CREATE TABLE block itself for new tenants.
- **Files modified:** `apps/api/src/lib/tenant-schema.ts`
- **Commit:** 0ffcb6f

**2. [Rule 2 - Missing critical functionality] Worker architecture uses separate service class, not inline in service.ts**
- **Found during:** Task 2
- **Issue:** Plan step 3c suggested registering the Worker inline in service.ts, but the existing pattern (SessionLifecycleService) registers BullMQ Workers in a dedicated class instantiated in app.ts. Placing Worker registration in service.ts (which is a domain service, not infrastructure) would break the architecture.
- **Fix:** Created `lid-reconciliation.worker.ts` processor factory + wired BullMQ Worker in `app.ts` following the SessionLifecycleService pattern.
- **Files modified:** `apps/api/src/app.ts`, new file `apps/api/src/workers/lid-reconciliation.worker.ts`
- **Commit:** ce1129f

**3. [Rule 3 - Blocking issue] Prisma CLI unavailable in worktree environment**
- **Found during:** Task 1 verification
- **Issue:** `pnpm exec prisma validate` fails — pnpm virtual store symlinks (Windows hard links) are not traversable in the bash/MINGW environment used by the executor. The prisma build directory appears empty.
- **Fix:** Schema correctness verified manually (grep checks, pattern matching against existing schema). DB push will execute via `pnpm run start:db-push` on deploy (existing mechanism in package.json scripts).
- **Impact:** `npx prisma validate` and `prisma db push` could not be run in CI during this plan. Schema syntax is correct based on manual verification and existing model patterns.

## Known Stubs

None — all data flows are wired. The reconciliation worker will silently skip contacts that have no `sharedPhoneJid` in their fields (waiting for a phone-number-share event to fire first), which is intentional per the plan's specification.

## Threat Flags

No new threat surface beyond what was specified in the plan's threat model. The `reconcileLidContact` public method validates tenantId→instanceId ownership before any DB write (T-02-01-02).

## Self-Check: PASSED

- FOUND: prisma/schema.prisma
- FOUND: prisma/tenant.prisma
- FOUND: apps/api/src/lib/tenant-schema.ts
- FOUND: apps/api/src/queues/lid-reconciliation-queue.ts
- FOUND: apps/api/src/workers/lid-reconciliation.worker.ts
- FOUND: apps/api/src/modules/crm/__tests__/lid-normalization.test.ts
- FOUND commit: 0ffcb6f (Task 1 — schema changes)
- FOUND commit: ce1129f (Task 2 — queue, worker, service, tests)
- Tests: 7/7 GREEN
