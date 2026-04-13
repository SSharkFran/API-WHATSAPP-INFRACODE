---
phase: 02-crm-identity-data-integrity
plan: "03"
subsystem: crm
tags: [performance, n+1, pagination, tags-filter, persistent-memory, ui]
dependency_graph:
  requires: [02-01]
  provides: [batch-memory-query, tags-filter, pagination-cap, memory-panel-ui]
  affects: [crm-contacts-list, crm-contact-detail, crm-message-history]
tech_stack:
  added: []
  patterns:
    - Single findMany with OR clause replacing N+1 findFirst loop
    - memoryMap keyed by last-8-digit phone suffix for O(1) lookup
    - MemoryPanel component with flat-field fallback pattern
key_files:
  created: []
  modified:
    - apps/api/src/modules/crm/routes.ts
    - apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts
    - apps/panel/components/tenant/crm-screen.tsx
decisions:
  - Used single findMany + Map lookup to replace N+1 loop — O(1) DB round trips
  - Capped pagination over-fetch at Math.min((pageSize+skip)*2, 500) — safe ceiling for dedup-then-slice pattern
  - tags filter uses Prisma hasSome operator — array overlap, parameterized (no SQL injection)
  - ContactDetail interface extended with optional memory sub-object for forward compatibility
  - MemoryPanel falls back to flat API fields when nested memory object is absent
  - Message history raised from 60 to 500 rows — cross-session history without session boundary gaps
metrics:
  duration: ~20min
  completed: 2026-04-13
  tasks_completed: 2
  files_modified: 3
---

# Phase 02 Plan 03: CRM Batch Query, Tags Filter, Pagination & Memory Panel Summary

**One-liner:** Single findMany batch query replaces N+1 clientMemory loop; tags filter, 500-row pagination cap, and ContactPersistentMemory display panel added to CRM.

## What Was Built

### Task 1: Fix N+1 query, over-fetch, tags filter (crm/routes.ts) — commit bd6b1af

**N+1 elimination:** The `listContacts` handler previously ran one `clientMemory.findFirst` per contact in a `Promise.all` loop — O(N) DB round trips for N contacts. Replaced with a single `clientMemory.findMany` with an OR clause over all phone suffixes, then a `Map<phone8, row>` for O(1) lookup per contact.

**Pagination cap:** `take: (pageSize + skip) * 2` could grow unboundedly with large page/pageSize values. Capped at `Math.min((pageSize + skip) * 2, 500)` — safe ceiling while preserving the dedup-then-slice pattern.

**Tags filter:** Added `tags: z.array(z.string().max(50)).optional()` to `listContactsQuerySchema`. Wired into `convWhere` as `tags: { hasSome: tags }` — Prisma parameterizes the array, no SQL injection risk. Validation per T-02-03-01 threat mitigation.

**Message history:** Raised `take: limit` (max 100 via schema) to `take: 500` — fixed `orderBy: { createdAt: "asc" }` already present. Cross-session history now shows up to 500 messages without an arbitrary session boundary cap (CRM-04).

**Tests (GREEN 3/3):** `crm-contacts-batch.test.ts` turned from RED stubs to real assertions testing: batch findMany called once for 5 contacts; memoryMap lookup by last-8-digit suffix; empty list skips DB entirely.

### Task 2: ContactPersistentMemory display surface (crm-screen.tsx) — commit 0802de6

**ContactMemory interface:** Added `ContactMemory` type and optional `memory` field to `ContactDetail` interface for forward compatibility with API returning nested memory objects.

**MemoryPanel component:** New component rendering "Dados capturados" section below the message area. Resolves fields preferring `detail.memory.name` / `detail.memory.serviceInterest` / etc., falling back to flat API fields (`detail.serviceInterest`, `detail.leadStatus`, etc.) when nested object is absent. Shows "Nenhum dado capturado ainda" when no memory data exists.

Renders: Nome, Interesse, Status (translated via LEAD_LABEL), Agendamento (pt-BR locale), Observações.

## Deviations from Plan

### Auto-adapted approach

**1. [Rule 1 - Adaptation] MemoryPanel extracted as named component instead of inline JSX**
- **Found during:** Task 2 — inline IIFE approach created malformed JSX with complex ternary nesting
- **Fix:** Extracted to named `MemoryPanel` component placed before `CrmScreen`. Cleaner, testable, avoids JSX nesting issues. Per plan scope constraint (no new files), component lives in the same monolithic crm-screen.tsx.
- **Files modified:** apps/panel/components/tenant/crm-screen.tsx

**2. [Rule 2 - Security] Tags validated with z.string().max(50) per T-02-03-01**
- **Found during:** Task 1 — threat model required validation on tags query param
- **Fix:** Applied `z.string().max(50)` constraint in Zod schema as specified in threat register
- **Files modified:** apps/api/src/modules/crm/routes.ts

## Known Stubs

None — all fields are wired to real data. The `memory` sub-object on `ContactDetail` will be null/absent until the API returns it as a nested object (currently the API returns flat fields). The MemoryPanel falls back gracefully to flat fields in all cases, so no stub behavior visible to the user.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. Tags filter adds a new query parameter surface — already mitigated via Zod validation and Prisma parameterization per T-02-03-01.

## Self-Check

### Files exist
- `apps/api/src/modules/crm/routes.ts` — modified
- `apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts` — modified (GREEN)
- `apps/panel/components/tenant/crm-screen.tsx` — modified

### Commits exist
- bd6b1af — feat(02-03): fix N+1 query, pagination cap, tags filter in crm/routes.ts
- 0802de6 — feat(02-03): add ContactPersistentMemory display surface to CRM contact detail panel

### Acceptance criteria
- [x] `findMany` present in routes.ts (batch query) — 3 occurrences
- [x] `findFirst` no longer in N+1 loop — only single-record lookups remain
- [x] `Math.min` present (pagination cap) — 1 occurrence
- [x] `hasSome` present (tags filter) — 1 occurrence
- [x] `tags` present in schema and convWhere — multiple occurrences
- [x] crm-contacts-batch.test.ts GREEN (3/3)
- [x] `Dados capturados` heading present — 1 occurrence
- [x] `memory.name` reference present — 3 occurrences
- [x] `serviceInterest` rendered in detail panel — present
- [x] `scheduledAt` rendered in detail panel — present
- [x] `take: 500` in message history query — 1 occurrence
- [x] `orderBy: { createdAt: "asc" }` in message query — present

## Self-Check: PASSED
