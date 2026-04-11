# Phase 2 — CRM Identity & Data Integrity: Context

**Phase:** 02 — CRM Identity & Data Integrity  
**Captured:** 2026-04-11  
**Status:** Ready for planning

---

## Domain Boundary

Operators always see real phone numbers in the CRM; contact data (custom fields, tags, conversation history) persists correctly across sessions; and tenant schema migrations run reliably as new columns are added across the platform.

This phase does NOT include: UI redesign, new CRM features, or session lifecycle management (Phase 4).

---

## Canonical Refs

- `.planning/ROADMAP.md` — Plans 2.1–2.4, Success Criteria, UAT Scenarios
- `.planning/REQUIREMENTS.md` — CRM-01 through CRM-07
- `apps/api/src/modules/crm/routes.ts` — existing CRM API (N+1 bug, over-fetch, cleanPhone utility)
- `apps/panel/components/tenant/crm-screen.tsx` — existing CRM UI component
- `apps/api/src/db/tenant-schema.ts` — current ALTER TABLE ADD COLUMN IF NOT EXISTS pattern (to be migrated)

---

## Decisions

### LID Fallback UX (Plan 2.1 + 2.2)

**Decision:** When a contact's `phoneNumber` is null (LID not yet resolved), show **"Aguardando número"** as the display label in the CRM list.

- This is distinct from "Contato desconhecido" (the fallback for permanently unresolvable contacts)
- "Aguardando número" signals to the operator that resolution is in progress, not that the contact is unknown
- The background reconciliation job will replace this label automatically once resolution succeeds
- The raw JID must never appear anywhere in the operator-facing UI

### `formatPhone()` Scope (Plan 2.2)

**Decision:** **pt-BR only, raw E.164 fallback for international numbers.**

- Format: numbers with country code `+55` → `+55 11 99999-9999` (or `+55 11 9999-9999` for 8-digit landlines)
- All other country codes → return E.164 as-is (e.g., `+1 415 555 0199` stays as `+14155550199`)
- Unknown/unresolvable format → `"Contato desconhecido"`
- No external i18n library (libphonenumber-js or similar) — keep it dependency-free
- The existing `cleanPhone()` in `crm/routes.ts` strips suffixes only — `formatPhone()` is a new utility that wraps it and adds E.164 formatting

### LID Reconciliation Job Cadence (Plan 2.1)

**Decision:** **Event-driven — triggered on `connection.update: open`.**

- When a Baileys instance fires `connection.update: open`, enqueue a BullMQ job to sweep all contacts for that `instanceId` with `phoneNumber = null` and attempt `signalRepository.getPNForLID()` resolution
- No periodic polling job — avoids wasted cycles when no instance is connected
- The job should deduplicate via BullMQ job ID (e.g., `lid-reconcile:{instanceId}`) to prevent stacking on rapid reconnects
- Max retry: 3 attempts per contact per connection event; after that, leave `phoneNumber` null until next connection

### Tenant Migration Failure Strategy (Plan 2.4)

**Decision:** **Log error, skip failing tenant, continue API startup.**

- `runMigrations(tenantId)` errors are caught per-tenant — they must not propagate to halt the entire startup sequence
- On failure: log a structured error (`{ tenantId, migration, error }`) at `error` level via Pino
- The failing tenant continues to operate on its current schema (potentially missing new columns); downstream code must handle missing columns gracefully (nullable, optional)
- A startup summary log should list all tenants with migration status (success / skipped / failed)
- No automatic retry on startup — the fix requires operator intervention (manual re-run or deploy)

---

## Implementation Constraints (from Codebase Scout)

- **`cleanPhone()`** already exists in `crm/routes.ts` — `formatPhone()` must wrap it, not duplicate it
- **N+1 loop** (`clientMemory.findFirst()` per contact) must be converted to a single `findMany` with `OR phoneNumber contains` — the fix is in `crm/routes.ts:76–85`
- **Over-fetch** (`take: (pageSize + skip) * 2`) should be replaced with correct offset/limit pagination
- **`crm-screen.tsx`** is a single monolithic component — no sub-component refactor is in scope for this phase; just fix the data rendering and send paths

---

## Deferred Ideas

_(None surfaced during discussion.)_

---

## Next Steps

1. `/gsd-plan-phase 2` — Create detailed execution plans for Plans 2.1–2.4
2. Instrumentation note from STATE.md: LID resolution timing window after `connection.update: open` is unknown — Plan 2.1 implementer should instrument and log the delay before declaring CRM-01 done
