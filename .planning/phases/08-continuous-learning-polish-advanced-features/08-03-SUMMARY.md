---
phase: "08"
plan: "03"
subsystem: chatbot-knowledge-audit
tags: [schema-migration, knowledge-service, audit-trail, prisma, panel-ui]
dependency_graph:
  requires:
    - "08-01"
  provides:
    - confirmedAt and confirmedByJid columns on TenantKnowledge
    - KnowledgeService.save() with audit params
    - Panel "Conhecimento" tab with audit metadata display
  affects:
    - apps/api/src/lib/run-migrations.ts
    - apps/api/src/modules/chatbot/knowledge.service.ts
    - apps/api/src/modules/chatbot/escalation.service.ts
    - apps/panel/components/tenant/chatbot-studio.tsx
    - prisma/tenant.prisma
tech_stack:
  added: []
  patterns:
    - "ALTER TABLE IF NOT EXISTS for idempotent schema migrations"
    - "Optional audit params with ?? null fallback in Prisma create/update"
    - "Conditional JSX rendering for nullable audit metadata fields"
key_files:
  created: []
  modified:
    - apps/api/src/lib/run-migrations.ts
    - apps/api/src/modules/chatbot/knowledge.service.ts
    - apps/api/src/modules/chatbot/escalation.service.ts
    - apps/panel/components/tenant/chatbot-studio.tsx
    - prisma/tenant.prisma
    - apps/api/src/modules/chatbot/__tests__/knowledge-audit.test.ts
    - apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts
decisions:
  - "Prisma schema updated (not just migration) so TypeScript types reflect confirmedAt/confirmedByJid"
  - "EscalationService Phase 2 passes confirmedAt=new Date() and confirmedByJid=entry.adminJid to save()"
  - "Corrupted git blobs (run-migrations.ts, escalation.service.ts, escalation-confirmation-gate.test.ts) restored from valid earlier commit objects"
metrics:
  duration_minutes: 35
  completed_date: "2026-04-24"
  tasks_completed: 2
  files_changed: 7
requirements:
  - APR-05
  - APR-06
---

# Phase 08 Plan 03: Knowledge Audit Metadata — confirmedAt + confirmedByJid — Summary

**One-liner:** Two-column schema migration (confirmedAt TIMESTAMPTZ, confirmedByJid TEXT) on TenantKnowledge with full Prisma + service + panel propagation for APR-05 auditable learning trail.

## What Was Built

### Task 1: Schema + Service (commit `7859a5c`)

- Added migrations `2026-04-24-044-knowledge-confirmed-at` and `2026-04-24-045-knowledge-confirmed-by-jid` to `run-migrations.ts`
- Updated `prisma/tenant.prisma` `TenantKnowledge` model with `confirmedAt DateTime?` and `confirmedByJid String?`
- Regenerated Prisma client (tenant-client)
- Extended `LearnedKnowledge` interface with `confirmedAt: string | null` and `confirmedByJid: string | null`
- Updated `KnowledgeService.save()` signature with optional `confirmedAt?: Date | null` and `confirmedByJid?: string | null` params
- Updated Prisma `create()` and `update()` calls to persist audit fields (update uses conditional spread so only updates if param provided)
- Updated `mapRecord()` to serialize `confirmedAt` to ISO string and include `confirmedByJid`
- Updated `EscalationService` Phase 2 (`processAdminReply`) to pass `confirmedAt: new Date()` and `confirmedByJid: entry.adminJid` to `save()`
- Tests: 2/2 green (`knowledge-audit.test.ts`)

### Task 2: Panel UI (commit `e581961`)

- Extended `knowledgeList` state type to include `confirmedAt: string | null` and `confirmedByJid: string | null`
- Added two conditional metadata spans below existing `"por: {taughtBy}"` and `createdAt` display:
  - `confirmado por: {jid-without-suffix}` — only shown when `confirmedByJid` is non-null
  - `em: {formatted-date}` — only shown when `confirmedAt` is non-null
- Existing "Remover" and edit buttons untouched

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrupted git blob files restored**
- **Found during:** Task 1 setup
- **Issue:** Three files were stored as git commit diff text instead of TypeScript source: `run-migrations.ts`, `escalation.service.ts`, `escalation-confirmation-gate.test.ts`. This was caused by a prior agent writing `git show` output directly to working tree files.
- **Fix:** Restored `run-migrations.ts` from `git cat-file -p 0058d19` (clean blob with migrations 001–043). Restored `escalation-confirmation-gate.test.ts` from `git cat-file -p 0169011` (proper test source). Reconstructed `escalation.service.ts` from pre-gate version `b59ece2` + applied the 08-02 diff embedded in the corrupted blob manually via Python string replacements.
- **Files modified:** `apps/api/src/lib/run-migrations.ts`, `apps/api/src/modules/chatbot/escalation.service.ts`, `apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts`
- **Commit:** `7859a5c`

**2. [Rule 2 - Missing functionality] Prisma schema update required**
- **Found during:** Task 1
- **Issue:** The plan described using `prisma.tenantKnowledge.create()` with `confirmedAt`/`confirmedByJid` fields, but these fields were absent from `prisma/tenant.prisma`. TypeScript would reject the data object at compile time.
- **Fix:** Added `confirmedAt DateTime?` and `confirmedByJid String?` to `TenantKnowledge` model. Re-ran `prisma generate`.
- **Files modified:** `prisma/tenant.prisma`
- **Commit:** `7859a5c`

## Known Stubs

None — all fields are wired through schema → service → panel. Entries created before these migrations have `null` confirmedAt/confirmedByJid; the UI conditionally hides those fields rather than showing empty labels.

## Threat Flags

None — no new network endpoints or auth paths introduced. The panel display of `confirmedByJid` is scoped to the tenant's own admin panel (T-8-03-01 accepted per plan threat model).

## Verification Checklist

- [x] `grep -c "2026-04-24-044" apps/api/src/lib/run-migrations.ts` = 1
- [x] `grep -c "2026-04-24-045" apps/api/src/lib/run-migrations.ts` = 1
- [x] `grep -c "confirmedAt" apps/api/src/modules/chatbot/knowledge.service.ts` = 7 (≥ 3 required)
- [x] `grep -c "confirmedByJid" apps/api/src/modules/chatbot/knowledge.service.ts` = 7 (≥ 3 required)
- [x] No TypeScript errors in `knowledge.service.ts` or `run-migrations.ts`
- [x] `knowledge-audit.test.ts` — 2/2 tests pass
- [ ] Panel "Conhecimento" tab shows confirmedAt + confirmedByJid (human verify — Task 2 checkpoint)

## Self-Check


## Self-Check: PASSED

- run-migrations.ts: FOUND
- knowledge.service.ts: FOUND
- chatbot-studio.tsx: FOUND
- SUMMARY.md: FOUND
- Commit 7859a5c: FOUND
- Commit e581961: FOUND
