---
plan: 02-02
phase: 02-crm-identity-data-integrity
status: complete
tasks_completed: 2
tasks_total: 2
---

# Plan 02-02 Summary: formatPhone() Utility + CRM Display Surfaces

## What Was Built

**Task 1 — formatPhone() utility modules (agent, completed)**
- `apps/api/src/lib/format-phone.ts`: server-side `formatPhone()` implementing the locked D-FORMAT contract
- `apps/panel/lib/format-phone.ts`: client-side mirror (identical logic, no shared import)
- `apps/api/src/modules/crm/__tests__/format-phone.test.ts`: 8/8 assertions GREEN

**Task 2 — CRM surfaces + send path fix (inline, completed)**
- `apps/api/src/modules/crm/routes.ts`:
  - `rawJid` added to contacts list response and messages contact response
  - Messages query falls back to `rawJid` exact-match when `phoneNumber` is null (LID contacts)
  - Memory lookup skipped for LID contacts (avoids `contains:` query on null)
  - `jid` field in response now prefers `rawJid` over `phoneNumber`
- `apps/panel/components/tenant/crm-screen.tsx`:
  - Inline `formatPhone` removed; replaced with `import { formatPhone } from "../../lib/format-phone"`
  - `CrmContact` and `ContactDetail` interfaces updated: `phoneNumber: string | null`, `rawJid: string | null`
  - ContactCard: shows `"Aguardando número"` (italic) when `phoneNumber == null`
  - Header phone sub-line: shows italic `"Aguardando número"` for LID contacts
  - `handleSend` + `handleFile`: use `rawJid ?? jid ?? normalizePhoneForSend(phoneNumber)` as `targetJid`; toast error if no usable identifier

## Commits
- `23836dc`: feat(02-02): create formatPhone() utility modules and turn format-phone.test.ts GREEN
- `d2e8aac`: feat(02-02): apply formatPhone() to CRM surfaces, add rawJid to API, fix send path

## Must-Haves Verified
- [x] `formatPhone('+5511987654321') === '+55 11 98765-4321'`
- [x] `formatPhone(null) === 'Aguardando número'`
- [x] `formatPhone('garbage') === 'Contato desconhecido'`
- [x] No `@lid`, `@c.us`, or raw JID string reaches any rendered text node
- [x] send-from-CRM uses `rawJid` as `targetJid` — never the display-formatted string
- [x] CRM contacts list shows `'Aguardando número'` (italic) when `phoneNumber` is null
