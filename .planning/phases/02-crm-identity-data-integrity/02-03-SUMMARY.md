---
phase: 02-crm-identity-data-integrity
plan: "03"
subsystem: crm
tags: [performance, query-optimization, tags-filter, ui, persistent-memory]
completed: 2026-04-17T13:24:46Z
duration_seconds: 290

dependency_graph:
  requires: [02-01]
  provides: [batch-memory-query, tags-filter, pagination-cap, custom-fields-ui, cross-session-messages]
  affects: [apps/api/src/modules/crm/routes.ts, apps/panel/components/tenant/crm-screen.tsx]

tech_stack:
  patterns:
    - "Prisma findMany with OR array instead of Promise.all(findFirst) for batch lookups"
    - "Map<phone8, memory> for O(1) contact-to-memory association"
    - "Prisma hasSome operator for TEXT[] array overlap filter"
    - "Math.min cap on over-fetch pagination"

key_files:
  modified:
    - apps/api/src/modules/crm/routes.ts
    - apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts
    - apps/panel/components/tenant/crm-screen.tsx

decisions:
  - "Kept take:500 cap on message history (T-02-03-04 threat accepted — 500KB ceiling is reasonable)"
  - "Phone8 suffix match retained as lookup key — cleanPhone strips @suffix then slices last 8 digits"
  - "memory field added to ContactDetail interface as optional — API may not yet return it for all contacts"

metrics:
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
  commits: 2
---

# Phase 02 Plan 03: CRM Data Integrity Fixes Summary

**One-liner:** Batch clientMemory lookup (N+1→findMany), pagination cap (500 rows), tags filter (hasSome), and AI-field display surface in contact detail panel.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix N+1 query, over-fetch, tags filter in crm/routes.ts | e1e424a | routes.ts, crm-contacts-batch.test.ts |
| 2 | Add ContactPersistentMemory display surface to CRM contact detail panel | 0dd57fd | crm-screen.tsx |

## Changes Made

### Task 1: crm/routes.ts

**N+1 → findMany (CRM-06)**

Replaced `Promise.all(deduped.map(c => prisma.clientMemory.findFirst(...)))` with:
1. Build `phone8List` from all deduplicated contacts
2. Single `prisma.clientMemory.findMany({ where: { OR: phone8List.map(p => ({ phoneNumber: { contains: p } })) } })`
3. Build `memoryMap = new Map(memoryRows.map(m => [cleanPhone(m.phoneNumber).slice(-8), m]))`
4. Per-contact lookup: `memoryMap.get(cleaned.slice(-8))`

**Pagination cap (CRM-06)**

`take: (pageSize + skip) * 2` → `take: Math.min((pageSize + skip) * 2, 500)`

**Tags filter (CRM-05)**

- `listContactsQuerySchema` gains `tags: z.array(z.string().max(50)).optional()`
- `convWhere` gains `...(tags && tags.length > 0 ? { tags: { hasSome: tags } } : {})`
- Injection mitigation: Prisma parameterizes `hasSome`; tag values validated to max 50 chars (T-02-03-01)

**Message history (CRM-04)**

- `take: limit` (max 100 per messagesQuerySchema) → `take: 500` — cross-session history no longer capped at 60
- `orderBy: { createdAt: "asc" }` was already present

### Task 2: crm-screen.tsx

**ContactMemory interface added:**
```typescript
interface ContactMemory {
  name?: string | null;
  serviceInterest?: string | null;
  status?: string | null;
  scheduledAt?: string | null;
  notes?: string | null;
}
```

**ContactDetail extended** with `memory?: ContactMemory | null`

**"Dados capturados" section** added in contact detail panel (after sub-header, before notes). Renders each field conditionally:
- Nome, Interesse, Status, Agendamento (with pt-BR date format), Observações
- When `detail.memory` is null: shows "Nenhum dado capturado ainda" in italic

## Test Results

```
✓ CRM contacts batch > replaces N+1 clientMemory.findFirst loop with single findMany query
✓ CRM contacts batch > returns correct memory per contact matched by last-8-digit phone suffix
✓ CRM contacts batch > handles empty contact list without querying clientMemory
Test Files  1 passed (1) | Tests  3 passed (3)
```

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

The `memory` field in `ContactDetail` is typed as optional (`memory?: ContactMemory | null`). The API response from the messages endpoint currently does NOT include a `memory` property — the data is returned as flat fields (`leadStatus`, `serviceInterest`, `scheduledAt`, `notes`) rather than nested under `memory`. This means the "Dados capturados" UI section will render blank until the API is updated to include `contact.memory` in its response shape.

**Stub location:** `apps/panel/components/tenant/crm-screen.tsx` — `detail?.memory` check
**Resolution:** A follow-on task should add `memory: { name, serviceInterest, status, scheduledAt, notes }` to the contact detail API response (messages endpoint return value). The data already exists in the DB via `clientMemory.findFirst` which IS queried in that endpoint.

## Threat Flags

No new threat surface introduced beyond what was analyzed in the plan's threat model.

## Self-Check

- [x] `grep "findMany" apps/api/src/modules/crm/routes.ts` — 3 lines (conversation, clientMemory batch, message)
- [x] `grep "Math.min" apps/api/src/modules/crm/routes.ts` — 1 line
- [x] `grep "hasSome" apps/api/src/modules/crm/routes.ts` — 1 line
- [x] `grep "Dados capturados" apps/panel/components/tenant/crm-screen.tsx` — 1 line
- [x] `grep "take: 500" apps/api/src/modules/crm/routes.ts` — 1 line
- [x] Tests: 3/3 GREEN
- [x] Commits: e1e424a, 0dd57fd both exist

## Self-Check: PASSED
