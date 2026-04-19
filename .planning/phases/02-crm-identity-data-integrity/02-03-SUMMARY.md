---
phase: 02-crm-identity-data-integrity
plan: "03"
subsystem: crm
tags: [performance, query-optimization, ui, memory, tags-filter, pagination]
dependency_graph:
  requires: [02-01]
  provides: [batch-memory-query, tags-filter, pagination-cap, memory-display-surface, cross-session-history]
  affects: [crm-contacts-list, crm-contact-detail, crm-messages-endpoint]
tech_stack:
  added: []
  patterns: [batch-findMany-with-Map-lookup, Zod-array-filter, MemoryRow-type-annotation]
key_files:
  created: []
  modified:
    - apps/api/src/modules/crm/routes.ts
    - apps/panel/components/tenant/crm-screen.tsx
    - apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts
decisions:
  - N+1 loop replaced with findMany + in-process Map — no schema change needed
  - tags filter uses Prisma hasSome (array overlap) — correct for TEXT[] column
  - memory sub-object added to messages endpoint response for UI consumption
  - take:500 ceiling chosen for message history — ~500KB max per query (acceptable)
  - MemoryRow type annotation added to resolve implicit-any from missing Prisma generated client
metrics:
  duration_seconds: 496
  completed_date: "2026-04-18"
  tasks_completed: 2
  files_modified: 3
---

# Phase 02 Plan 03: CRM Performance, Tags Filter, and Memory Display Summary

**One-liner:** Batch clientMemory lookup (findMany + Map), 500-row pagination cap, tags hasSome filter, and AI-captured fields display surface in CRM contact detail panel.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix N+1 query, over-fetch, tags filter in crm/routes.ts | 3cddcf9 | routes.ts, crm-contacts-batch.test.ts |
| 2 | Add ContactPersistentMemory display surface to CRM detail panel | 8f5d94b | crm-screen.tsx, routes.ts |

## What Was Built

### Task 1 — Backend fixes (routes.ts)

**N+1 elimination:** The `Promise.all(deduped.map(c => prisma.clientMemory.findFirst(...)))` loop was replaced with a single `prisma.clientMemory.findMany({ where: { OR: phone8List.map(...) } })` call followed by an in-process `Map` keyed by last-8 phone digits. For a 40-contact page, this goes from 40 DB round trips to 1.

**Pagination cap:** `take: (pageSize + skip) * 2` replaced with `take: Math.min((pageSize + skip) * 2, 500)` — prevents runaway over-fetch on large page/pageSize values.

**Tags filter:** `tags: z.array(z.string().max(50)).optional()` added to `listContactsQuerySchema`. When provided, `convWhere["tags"] = { hasSome: tags }` is applied to the Prisma query. Tags param validated with max(50) per threat model T-02-03-01.

**Message history:** `take: limit` (max 100 via schema) raised to `take: 500` — cross-session history now returns up to 500 messages in chronological order (orderBy: createdAt asc was already present).

**TypeScript:** Added `MemoryRow` interface to type the findMany result — resolved property-access TS errors introduced when the empty-array ternary caused type inference to `{}`.

### Task 2 — UI display surface (crm-screen.tsx + routes.ts)

**ContactMemory interface** added to crm-screen.tsx. `ContactDetail` extended with optional `memory?: ContactMemory | null`.

**API routes.ts** updated to return `memory` sub-object in the messages endpoint response — fields: name, serviceInterest, status, scheduledAt, notes.

**"Dados capturados" section** added to the contact detail header in crm-screen.tsx, rendering AI-extracted fields (name, serviceInterest, status, scheduledAt, notes) when available. Shows "Nenhum dado capturado ainda" when memory is null.

## Tests

| File | Result |
|------|--------|
| crm-contacts-batch.test.ts | 3/3 PASS |

Tests cover: findMany called once (not findFirst N times), Map lookup by last-8 suffix, empty list skips DB call entirely.

## Acceptance Criteria Verification

```
grep "findMany" routes.ts          → 3 lines (batch query, message findMany, conversation findMany)
grep "findFirst" routes.ts         → 3 lines (single-contact lookup, clientMemory in messages, conversation) — none in contacts list handler
grep "Math.min" routes.ts          → 1 line ✓
grep "hasSome" routes.ts           → 1 line ✓
grep "take: 500" routes.ts         → 1 line ✓
grep "orderBy.*createdAt" routes.ts → 1 line ✓
grep "Dados capturados" crm-screen → 1 line ✓
grep "memory\.name" crm-screen     → 1 line ✓
grep "serviceInterest" crm-screen  → multiple lines ✓
grep "scheduledAt" crm-screen      → multiple lines ✓
vitest crm-contacts-batch.test.ts  → 3/3 PASS ✓
pnpm tsc --noEmit (panel)          → 0 errors ✓
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript property-access errors from ternary type inference**
- **Found during:** Task 1 TypeScript check
- **Issue:** `memoryRows` typed as `never[] | PrismaResult[]` — TS inferred empty arm as `{}`, causing "Property 'name' does not exist" errors on lines 112, 118-121
- **Fix:** Added explicit `MemoryRow` interface and typed the variable `const memoryRows: MemoryRow[]`
- **Files modified:** apps/api/src/modules/crm/routes.ts
- **Commit:** 3cddcf9

**2. [Rule 2 - Missing functionality] memory sub-object not in API response**
- **Found during:** Task 2 — plan's JSX pattern references `selectedContact.memory.name` but API returned fields flattened on contact
- **Fix:** Added `memory` sub-object to messages endpoint response shape and `ContactMemory` interface to crm-screen.tsx
- **Files modified:** apps/api/src/modules/crm/routes.ts, apps/panel/components/tenant/crm-screen.tsx
- **Commit:** 8f5d94b

## Known Stubs

None. All memory fields are wired from real DB data via `clientMemory.findFirst` in the messages endpoint.

## Threat Surface Scan

No new network endpoints or auth paths introduced. Tags filter uses Prisma parameterized `hasSome` — no raw SQL. Tags validated as `z.array(z.string().max(50))` per T-02-03-01 mitigation. Memory display is read-only, operator-facing (T-02-03-03 accepted). Message take:500 ceiling explicit (T-02-03-04 accepted).

## Self-Check: PASSED

- SUMMARY.md: FOUND
- Commit 3cddcf9 (Task 1): FOUND
- Commit 8f5d94b (Task 2): FOUND
- crm-contacts-batch.test.ts: 3/3 PASS
- apps/panel TypeScript: 0 errors
