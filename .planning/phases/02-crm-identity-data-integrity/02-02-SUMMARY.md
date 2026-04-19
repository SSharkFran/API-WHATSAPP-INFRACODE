---
phase: 02-crm-identity-data-integrity
plan: "02"
subsystem: crm
tags: [formatPhone, jid, lid, phone-normalization, crm-ui]
dependency_graph:
  requires: [02-01]
  provides: [formatPhone-utility, rawJid-api-field, null-safe-crm-ui]
  affects: [crm-screen, crm-routes, format-phone-lib]
tech_stack:
  added: []
  patterns: [null-safe-rendering, module-import-over-inline, rawJid-send-path]
key_files:
  created:
    - apps/api/src/lib/format-phone.ts
    - apps/panel/lib/format-phone.ts
  modified:
    - apps/api/src/modules/crm/routes.ts
    - apps/panel/components/tenant/crm-screen.tsx
    - apps/api/src/modules/crm/__tests__/format-phone.test.ts
decisions:
  - "formatPhone() implemented without external deps (libphonenumber-js prohibited) — pure digit manipulation"
  - "Panel lib mirrors API lib exactly — separate files because Next.js cannot import from apps/api"
  - "rawJid used as targetJid in send path — phoneNumber is display-only, never sent to API"
  - "messages query falls back to rawJid equals-match when phoneNumber is null — prevents empty thread for LID contacts"
metrics:
  duration: 15m
  completed: "2026-04-18"
  tasks_completed: 2
  files_created: 2
  files_modified: 3
requirements: [CRM-02, CRM-06, CRM-07]
---

# Phase 02 Plan 02: formatPhone() Utility and CRM Surface Normalization Summary

**One-liner:** formatPhone() utility (BR E.164 format, null → "Aguardando número") applied to all CRM operator surfaces with rawJid send path fix for LID contacts.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create formatPhone() utility modules (TDD GREEN) | d748bcd | apps/api/src/lib/format-phone.ts, apps/panel/lib/format-phone.ts, format-phone.test.ts |
| 2 | Apply formatPhone() to CRM surfaces and fix send path | 213fadf | apps/api/src/modules/crm/routes.ts, apps/panel/components/tenant/crm-screen.tsx |

## What Was Built

### Task 1 — formatPhone() Utility (TDD)

Created two mirrored formatPhone() modules (server + client) with the locked output contract from 02-UI-SPEC.md:

- BR 11-digit mobile: `5511987654321` → `+55 11 98765-4321`
- BR 10-digit landline: `551198765432` → `+55 11 9876-5432`
- E.164 international: `+14155550199` → `+14155550199` (as-is)
- null/undefined: → `"Aguardando número"`
- LID JID (`19383773@lid`): JID suffix stripped, digits too short → `"Aguardando número"` (never leaks raw digits)
- Garbage: → `"Contato desconhecido"`

All 8 test cases in `format-phone.test.ts` are GREEN.

### Task 2 — CRM Surface Normalization + Send Path Fix

**API (routes.ts):**
- `rawJid` added to contacts list response (mapper now uses `rawJid ?? phoneNumber` for `jid` field)
- `rawJid` added to messages endpoint contact select and response
- Messages query falls back to `rawJid` exact-match when `phoneNumber` is null (Plan 2.1 Pitfall 3 — LID contacts with unresolved phone)

**Panel (crm-screen.tsx):**
- Removed inline `formatPhone()` (was producing `(DDD) NNNNN-NNNN` format — wrong)
- Added `import { formatPhone } from "../../lib/format-phone"` — single source of truth
- `CrmContact.phoneNumber` type changed to `string | null` (null-safe)
- `ContactDetail.phoneNumber` type changed to `string | null`
- `CrmContact.rawJid` field added to interface
- ContactCard: sub-line shows `<p italic>Aguardando número</p>` when `phoneNumber == null`, else `formatPhone(phoneNumber)`
- ContactCard name fallback: uses "Aguardando número" when both `displayName` and `phoneNumber` are null
- Chat header phone span: `formatPhone(phoneNumber)` or "Aguardando número" if null
- `handleSend`: uses `rawJid ?? jid ?? phoneNumber` as `targetJid` — guard toast if all null
- `handleFile`: same rawJid-first targetJid pattern + null guard

## Verification Results

```
pnpm vitest run --reporter=verbose apps/api/src/modules/crm/__tests__/format-phone.test.ts
  8/8 PASSED

grep "@lid" apps/panel/components/tenant/crm-screen.tsx
  → Only in comments/type-checks (lines 18, 70) — not in any rendered text node

grep "rawJid" apps/api/src/modules/crm/routes.ts
  → 7 occurrences (contacts mapper, messages query, response shapes)

grep "Aguardando número" apps/panel/components/tenant/crm-screen.tsx
  → 2 render sites (ContactCard sub-line + chat header)

grep "italic" apps/panel/components/tenant/crm-screen.tsx
  → Line 153: placeholder italic class

grep "formatPhone" apps/panel/components/tenant/crm-screen.tsx
  → 4 occurrences (import + 3 render sites)

grep "Número não disponível" apps/panel/components/tenant/crm-screen.tsx
  → 2 occurrences (handleSend + handleFile guards)
```

TypeScript: No new errors introduced. Pre-existing errors (missing `react`/`lucide-react` type declarations — worktree has no node_modules) are present before and after our changes. API `routes.ts` compiles clean.

## Deviations from Plan

### Auto-fixed Issues

None — plan executed as specified.

### Notes

- The `Prisma` namespace import added to `routes.ts` for `Prisma.MessageWhereInput` type annotation required adding `import type { Prisma } from "@prisma/client"`. This is a minor addition not explicitly in the plan but required for correct TypeScript typing of the conditional message query. Aligns with Rule 2 (missing type annotation).

## Known Stubs

None — all phone render sites are wired to `formatPhone()` with real null-safe logic. The `rawJid` field flows from DB → API → UI type definitions. No hardcoded placeholders that would prevent the plan's goal.

## Threat Flags

No new threat surface introduced beyond what was planned. `rawJid` is exposed in API responses as planned (T-02-02-01 — accepted, operator-facing only). The `equals:` query for rawJid (T-02-02-05) uses exact match, not `contains`, which prevents wildcard injection.

## Self-Check: PASSED

- `apps/api/src/lib/format-phone.ts` — FOUND
- `apps/panel/lib/format-phone.ts` — FOUND
- Commit `d748bcd` — FOUND
- Commit `213fadf` — FOUND
- 8/8 tests GREEN — CONFIRMED
