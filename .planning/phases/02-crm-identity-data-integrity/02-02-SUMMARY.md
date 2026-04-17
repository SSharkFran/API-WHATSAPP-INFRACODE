---
phase: 02-crm-identity-data-integrity
plan: "02"
subsystem: crm
tags: [formatPhone, LID, JID, CRM, phone-formatting, typescript]
dependency_graph:
  requires: [02-01]
  provides: [formatPhone-utility, rawJid-api-response, crm-screen-phone-display]
  affects: [apps/panel/components/tenant/crm-screen.tsx, apps/api/src/modules/crm/routes.ts]
tech_stack:
  added: []
  patterns: [utility-module-duplication (server+client), null-safe rendering, rawJid-fallback-send]
key_files:
  created:
    - apps/api/src/lib/format-phone.ts
    - apps/panel/lib/format-phone.ts
  modified:
    - apps/api/src/modules/crm/__tests__/format-phone.test.ts
    - apps/api/src/modules/crm/routes.ts
    - apps/panel/components/tenant/crm-screen.tsx
decisions:
  - "Duplicate formatPhone() in server + client — Next.js panel cannot import from apps/api/src/"
  - "rawJid exposed in API response — panel needs it for send path and null-phone detection"
  - "Messages query uses rawJid exact-match fallback when phoneNumber is null — avoids empty thread for LID contacts"
  - "Send guard toast 'Número não disponível ainda' — both text and file send paths"
metrics:
  duration_minutes: 45
  completed_date: "2026-04-17"
  tasks_completed: 2
  files_changed: 5
---

# Phase 02 Plan 02: formatPhone() Utility and CRM Surface Updates Summary

**One-liner:** formatPhone() utility with pt-BR E.164 formatting applied to all CRM render sites; send path uses rawJid for LID-affected contacts; API exposes rawJid field; messages query falls back to rawJid when phoneNumber is null.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create formatPhone() utility modules and turn format-phone.test.ts GREEN | 76a6656 | apps/api/src/lib/format-phone.ts, apps/panel/lib/format-phone.ts, format-phone.test.ts |
| 2 | Apply formatPhone() to all CRM surfaces and fix send path | d660e1a | apps/api/src/modules/crm/routes.ts, apps/panel/components/tenant/crm-screen.tsx |

## What Was Built

### Task 1: formatPhone() Utility

Two identical modules (server + client) implementing the locked output contract from 02-UI-SPEC.md:

- `+5511987654321` → `+55 11 98765-4321` (BR 11-digit mobile)
- `551198765432` → `+55 11 9876-5432` (BR 10-digit landline)
- `+14155550199` → `+14155550199` (international E.164 as-is)
- `null` → `"Aguardando número"` (null/undefined input)
- `garbage!!$$` → `"Contato desconhecido"` (unparseable)
- `19383773@lid` → `"Contato desconhecido"` (strips @lid, short digit string → garbage)
- JID suffixes stripped before formatting (@c.us, @lid, @s.whatsapp.net)
- No external dependencies (libphonenumber-js explicitly prohibited)

All 8 test cases in `format-phone.test.ts` are GREEN.

### Task 2: CRM Surface Updates

**API (routes.ts):**
- Contact list response now includes `rawJid` field and null-safe `phoneNumber` (null for LID-only contacts)
- `jid` field in response uses `rawJid ?? phoneNumber ?? ""` as the sendable identifier
- Messages query: falls back to `rawJid` exact-match when `phoneNumber` is null (prevents empty thread for LID contacts)
- Contact detail response exposes `rawJid` + null-safe `phoneNumber`
- Memory lookup skipped gracefully when no phone digits available

**Panel (crm-screen.tsx):**
- Removed inline `formatPhone()` definition; imports from `../../lib/format-phone`
- `CrmContact` type: `rawJid: string | null`, `phoneNumber: string | null`
- `ContactDetail` type: `rawJid: string | null`, `phoneNumber: string | null`
- `ContactCard`: italic "Aguardando número" sub-line when phoneNumber is null; otherwise `formatPhone(phoneNumber)`
- Chat header phone: `formatPhone(selected.phoneNumber)` or italic "Aguardando número"
- `handleSend`: uses `selected.rawJid ?? selected.jid` as `targetJid`; shows "Número não disponível ainda. Tente novamente em instantes." toast when both null
- `handleFile`: same rawJid-first send path with guard toast

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] File send path also needed rawJid guard**
- **Found during:** Task 2
- **Issue:** Plan only mentioned fixing `handleSend`, but `handleFile` had the same broken phone-only send path
- **Fix:** Applied identical rawJid-first logic + guard toast to `handleFile`
- **Files modified:** apps/panel/components/tenant/crm-screen.tsx
- **Commit:** d660e1a

**2. [Rule 1 - Bug] Memory lookup guard for null phoneNumber in contact list**
- **Found during:** Task 2
- **Issue:** `cleanPhone(null).slice(-8)` returns `""` — a `contains: ""` Prisma query matches everything
- **Fix:** Added `if (!phone8) return Promise.resolve(null)` guard before clientMemory query
- **Files modified:** apps/api/src/modules/crm/routes.ts
- **Commit:** d660e1a

**3. [Rule 1 - Bug] Prisma import path correction**
- **Found during:** Task 2
- **Issue:** First attempt used `../../../prisma/...` but crm/routes.ts is at depth `modules/crm/` needing `../../../../../prisma/...`
- **Fix:** Corrected to match pattern used by other route files in the codebase
- **Files modified:** apps/api/src/modules/crm/routes.ts
- **Commit:** d660e1a

## Known Stubs

None. All phone render sites are wired to real data from the API.

## Threat Flags

No new threat surface introduced beyond what is documented in the plan's threat model:
- `rawJid` in API response: mitigated — not rendered in text nodes, only used for send path
- `rawJid` in Prisma `equals:` query: exact match, no injection risk (mitigated per T-02-02-05)

## Verification

```
format-phone.test.ts: 8/8 PASS
TypeScript (panel): CLEAN (0 errors)
@lid in JSX: 0 render sites (1 comment only)
rawJid in routes.ts: 10 occurrences
Aguardando número: 3 occurrences in crm-screen.tsx
italic class: 3 occurrences in crm-screen.tsx
formatPhone calls: 4 occurrences in crm-screen.tsx
import format-phone: 1 import statement
Número não disponível: 2 occurrences (handleSend + handleFile guards)
```

## Self-Check: PASSED

- apps/api/src/lib/format-phone.ts: FOUND
- apps/panel/lib/format-phone.ts: FOUND
- apps/api/src/modules/crm/__tests__/format-phone.test.ts: FOUND (updated)
- apps/api/src/modules/crm/routes.ts: FOUND (updated)
- apps/panel/components/tenant/crm-screen.tsx: FOUND (updated)
- Commit 76a6656: FOUND
- Commit d660e1a: FOUND
