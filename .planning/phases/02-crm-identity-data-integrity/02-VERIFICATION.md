---
phase: 02-crm-identity-data-integrity
verified: 2026-04-16T18:30:00Z
status: gaps_found
score: 5/9 must-haves verified
overrides_applied: 0
gaps:
  - truth: "No rendered text node in the operator UI contains '@lid', '@c.us', or raw LID digits"
    status: failed
    reason: "The caf4a29 02-03 worktree commit reverted all Plan 02-02 changes to crm-screen.tsx. The inline formatPhone() was re-introduced (lines 88-95 produce '(68) 9254-9342' format). The isLidJid() check renders 'ID WhatsApp' instead of 'Aguardando número'. The rawJid field was removed from CrmContact type. LID contacts would display 'ID WhatsApp' (acceptable) but the critical path for null phoneNumber shows empty string rather than the placeholder."
    artifacts:
      - path: "apps/panel/components/tenant/crm-screen.tsx"
        issue: "Inline formatPhone() re-introduced by caf4a29; import { formatPhone } from '../../lib/format-phone' was removed. 'Aguardando número' placeholder for null phoneNumber contacts is absent (grep returns no match). Contact card sub-line: `lid ? 'ID WhatsApp' : formatPhone(c.phoneNumber)` — non-LID contacts with null phoneNumber still pass null to the old formatPhone(raw: string) which doesn't handle null safely."
    missing:
      - "Restore import { formatPhone } from '../../lib/format-phone' and remove inline definition"
      - "Restore null-phone check: `contact.phoneNumber == null` → italic 'Aguardando número' in ContactCard sub-line"
      - "Restore rawJid field in CrmContact type and ContactDetail type"

  - truth: "CRM contacts list shows 'Aguardando número' (italic) when phoneNumber is null"
    status: failed
    reason: "No occurrence of 'Aguardando número' exists in crm-screen.tsx (confirmed by grep returning 0 results for rendered JSX). The Plan 02-02 implementation was reverted by the 02-03 worktree conflict. Only 'Aguardando' appears in LEAD_LABEL as 'Aguardando retorno' (a different label) and in instance status badge."
    artifacts:
      - path: "apps/panel/components/tenant/crm-screen.tsx"
        issue: "'Aguardando número' string is absent from the file — grep returns 0 matches in JSX context"
    missing:
      - "Add null phoneNumber conditional in ContactCard: `{contact.phoneNumber == null ? <p className='...italic'>Aguardando número</p> : <p className='...'>{formatPhone(contact.phoneNumber)}</p>}`"

  - truth: "send-from-CRM uses rawJid or resolved phoneNumber — never the display-formatted string"
    status: failed
    reason: "handleSend (line 411) and handleFile (line 437) both use `selected.jid` as targetJid (the original phoneNumber field, not rawJid). rawJid was removed from CrmContact by caf4a29. For LID contacts where selected.jid is '' (empty string from routes.ts line 103: `c.contact.phoneNumber ?? ''`), the targetJid conditional `...(selected.jid ? { targetJid: selected.jid } : {})` silently omits targetJid rather than blocking with a toast."
    artifacts:
      - path: "apps/panel/components/tenant/crm-screen.tsx"
        issue: "handleSend uses `selected.jid` not rawJid. No 'Número não disponível' guard toast. rawJid absent from CrmContact type."
      - path: "apps/api/src/modules/crm/routes.ts"
        issue: "Contact list Prisma query does not select rawJid (line 70: select only id, phoneNumber, displayName, isBlacklisted). rawJid not in API response. For LID contacts phoneNumber=null so jid='' (line 103)."
    missing:
      - "In routes.ts contact list query: add rawJid to select clause and to response shape"
      - "In crm-screen.tsx handleSend/handleFile: use `selected.rawJid ?? selected.jid ?? null` as targetJid with null guard toast"

  - truth: "Message history query handles null phoneNumber via rawJid fallback"
    status: failed
    reason: "The messages query (routes.ts lines 137-144) uses only `cleanPhone(contact.phoneNumber).slice(-8)` with a `contains:` match. The rawJid fallback path (introduced in d660e1a) was reverted by caf4a29. For LID contacts with null phoneNumber, phone8 = '' and `contains: ''` matches ALL messages across ALL contacts — a critical data integrity bug."
    artifacts:
      - path: "apps/api/src/modules/crm/routes.ts"
        issue: "Messages query line 137: `const phone8 = cleanPhone(contact.phoneNumber).slice(-8)` — when phoneNumber=null, phone8='', remoteJid contains '' matches everything. No rawJid fallback path. contact.rawJid not fetched (not in select on line 133)."
    missing:
      - "Select rawJid in contact.findFirst query (line 133)"
      - "Add rawJid fallback: if (!phone8 && contact.rawJid) use { remoteJid: { equals: contact.rawJid } }"
      - "Guard against empty phone8: if (!phone8 && !contact.rawJid) return empty messages array"

  - truth: "ContactPersistentMemory.data fields are visible in the contact detail panel"
    status: partial
    reason: "The 'Dados capturados' section exists in crm-screen.tsx (line 684) and renders memory.name, memory.serviceInterest, memory.scheduledAt, memory.notes conditionally. However, as documented in 02-03-SUMMARY.md 'Known Stubs', the API contact detail response does NOT return a nested `memory` field — it returns flat fields (leadStatus, serviceInterest, scheduledAt, notes). The ContactDetail interface has `memory?: ContactMemory | null` but the API route (routes.ts lines 157-168) does not include `memory:` in the response object. The 'Dados capturados' section will always be empty/hidden."
    artifacts:
      - path: "apps/api/src/modules/crm/routes.ts"
        issue: "Contact detail response (lines 158-168) returns flat fields (leadStatus, serviceInterest, scheduledAt, notes) but does not include `memory: { name, serviceInterest, status, scheduledAt, notes }`. The UI checks `detail.memory` which is always undefined."
      - path: "apps/panel/components/tenant/crm-screen.tsx"
        issue: "ContactDetail type has `memory?: ContactMemory | null` but API never populates it — so 'Dados capturados' section never renders real data."
    missing:
      - "In routes.ts contact detail response: add `memory: memory ? { name: memory.name, serviceInterest: memory.serviceInterest, status: memory.status, scheduledAt: memory.scheduledAt?.toISOString() ?? null, notes: memory.notes } : null`"
---

# Phase 02: CRM Identity & Data Integrity Verification Report

**Phase Goal:** Operators see real phone numbers everywhere in the CRM, contact data persists correctly across sessions, and the schema migration system prevents tenant drift as new columns are added.
**Verified:** 2026-04-16T18:30:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Root Cause Analysis

A merge conflict resolution failure caused Plan 02-02 changes to `crm-screen.tsx` and `routes.ts` to be reverted. The 02-03 worktree was based on a snapshot that predated the `d660e1a` commit (Plan 02-02: apply formatPhone to surfaces). When `caf4a29` landed it:

1. Re-introduced the inline `formatPhone()` definition, removing the import from `../../lib/format-phone`
2. Removed `rawJid` from `CrmContact` and `ContactDetail` TypeScript types
3. Replaced the rawJid-first send path with the old `selected.jid` path
4. Removed the `Número não disponível` guard toasts
5. Removed the rawJid select from routes.ts contact queries
6. Removed the rawJid message-fallback path from the messages endpoint

A subsequent `dc8a046 fix(02): restore 02-01/02-02/02-04 artifacts` commit corrected other files but not `crm-screen.tsx` or the `rawJid` query changes in `routes.ts`.

Additionally, Plan 02-03 documented a known stub (ContactPersistentMemory API response gap) that remains unresolved.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | @lid string never written into phoneNumber column of Contact | VERIFIED | service.ts line 2054: `where: { instanceId_rawJid }` + `phoneNumber: null` in create path confirmed. |
| 2 | rawJid column stores the full @lid string | VERIFIED | prisma/schema.prisma lines 228+240: `rawJid String?` + `@@unique([instanceId, rawJid])`. schema confirmed. |
| 3 | phoneNumber is nullable in Prisma schema | VERIFIED | schema.prisma line 227: `phoneNumber String?`. |
| 4 | BullMQ job lid-reconcile:{instanceId} enqueued on CONNECTED | VERIFIED | service.ts lines 1292, 1302 confirm jobId pattern and enqueue call. |
| 5 | Reconciliation worker calls persistLidPhoneMapping() — no duplicate logic | VERIFIED | workers/lid-reconciliation.worker.ts delegates via `instanceOrchestrator.reconcileLidContact()` (service.ts line 1335-1358). |
| 6 | formatPhone('+5511987654321') === '+55 11 98765-4321' | VERIFIED | apps/api/src/lib/format-phone.ts implements correct pt-BR logic. format-phone.test.ts 8/8 GREEN (last touched 76a6656). |
| 7 | No rendered text node in the operator UI contains '@lid', '@c.us', or raw LID digits | FAILED | See gap #1. Inline formatPhone in crm-screen.tsx doesn't guard null phoneNumber. |
| 8 | CRM contacts list shows 'Aguardando número' (italic) when phoneNumber is null | FAILED | See gap #2. String absent from crm-screen.tsx. |
| 9 | send-from-CRM uses rawJid or resolved phoneNumber — never the display-formatted string | FAILED | See gap #3. rawJid removed from types and API response by caf4a29. |
| 10 | Message history query handles null phoneNumber via rawJid fallback | FAILED | See gap #4. rawJid fallback removed from routes.ts messages endpoint. |
| 11 | N+1 clientMemory.findFirst loop replaced by single findMany | VERIFIED | routes.ts lines 81-95: single findMany with OR + memoryMap. crm-contacts-batch.test.ts GREEN (caf4a29). |
| 12 | Over-fetch pagination capped at pageSize * 3 (max 500 rows) | VERIFIED | routes.ts line 67: `Math.min((pageSize + skip) * 2, 500)`. |
| 13 | Tags filter param wired in listContactsQuerySchema and convWhere | VERIFIED | routes.ts lines 14 + 61: `tags: z.array(z.string().max(50)).optional()` + `{ hasSome: tags }`. |
| 14 | ContactPersistentMemory.data fields visible in contact detail panel | PARTIAL | See gap #5. UI section exists but API never populates `memory` field. |
| 15 | schema_migrations table created for every tenant on first access | VERIFIED | run-migrations.ts lines 283-307: CREATE TABLE IF NOT EXISTS + INSERT pattern. runMigrations() returns "success"/"skipped"/"failed". |
| 16 | runMigrations() applies only unapplied migrations — idempotent on re-run | VERIFIED | run-migrations.test.ts 6/6 GREEN (5718ad8). Checks applied set before executing. |
| 17 | A failing tenant's migration error does not halt API startup | VERIFIED | app.ts lines 220-237: catches errors, logs structured summary, continues. |
| 18 | All ALTER TABLE statements in buildTenantSchemaSql() converted to versioned MIGRATIONS[] | PARTIAL | run-migrations.ts has 37-entry MIGRATIONS[]. BUT tenant-schema.ts lines 115-117 still contain 3 ALTER TABLE statements for existing tenant rawJid migration (not removed from buildTenantSchemaSql). These are idempotent but violate the plan acceptance criteria. |

**Score:** 5/9 must-haves fully verified (4 failed, spanning 5 truths due to root cause overlap)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/crm/__tests__/lid-normalization.test.ts` | Failing stubs → GREEN | VERIFIED | 7/7 tests GREEN (ce1129f) |
| `apps/api/src/modules/crm/__tests__/format-phone.test.ts` | Failing stubs → GREEN | VERIFIED | 8/8 tests GREEN (76a6656) |
| `apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts` | Failing stubs → GREEN | VERIFIED | 3/3 tests GREEN (caf4a29) |
| `apps/api/src/lib/__tests__/run-migrations.test.ts` | Failing stubs → GREEN | VERIFIED | 6/6 tests GREEN (5718ad8) |
| `prisma/schema.prisma` | rawJid String? + phoneNumber String? + dual unique | VERIFIED | Lines 228, 240 confirm both fields and constraints |
| `apps/api/src/queues/lid-reconciliation-queue.ts` | createLidReconciliationQueue factory | VERIFIED | File exists, follows message-queue.ts pattern |
| `apps/api/src/queues/queue-names.ts` | LID_RECONCILIATION constant | VERIFIED | Line 6: `LID_RECONCILIATION: "lid-reconciliation"` |
| `apps/api/src/workers/lid-reconciliation.worker.ts` | Reconciliation worker processor | VERIFIED | File exists; calls reconcileLidContact() |
| `apps/api/src/lib/format-phone.ts` | Server-side formatPhone() | VERIFIED | Exports formatPhone; 43 lines, no external deps |
| `apps/panel/lib/format-phone.ts` | Client-side formatPhone() | VERIFIED | File exists with identical implementation |
| `apps/api/src/modules/crm/routes.ts` | rawJid in API response + N+1 fix + tags + pagination | PARTIAL | N+1 fix, tags, pagination confirmed. rawJid NOT in response (reverted by caf4a29). |
| `apps/panel/components/tenant/crm-screen.tsx` | formatPhone import + Aguardando número + rawJid send path | FAILED | Import reverted to inline. Aguardando número absent. rawJid type removed. |
| `apps/api/src/lib/run-migrations.ts` | runMigrations() + MIGRATIONS array | VERIFIED | Exports both; 37 migrations; schema_migrations pattern |
| `apps/api/src/lib/tenant-schema.ts` | Only CREATE TABLE (no ALTER TABLE) | PARTIAL | 3 ALTER TABLE still present (lines 115-117) for rawJid backfill |
| `apps/api/src/app.ts` | runMigrations() called at startup + summary log | VERIFIED | Lines 220-237 confirm both |
| `apps/api/src/lib/database.ts` | ensureSchema() calls runMigrations() | VERIFIED | Line 106: `await runMigrations(platformPrisma, tenantId, noopLogger)` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| service.ts CONNECTED branch | lid-reconciliation-queue.ts | this.lidReconciliationQueue.add() | VERIFIED | service.ts line 1302: `jobId: \`lid-reconcile:${instance.id}\`` |
| service.ts handleInboundMessage | prisma.contact.upsert | instanceId_rawJid where clause | VERIFIED | service.ts line 2054: `where: { instanceId_rawJid: { instanceId: instance.id, rawJid: event.remoteJid } }` |
| crm-screen.tsx ContactCard | apps/panel/lib/format-phone.ts | import { formatPhone } | FAILED | Import was removed by caf4a29; inline formatPhone() re-introduced |
| crm/routes.ts contact response | Contact.rawJid | rawJid: c.contact.rawJid | FAILED | rawJid not selected or returned in contact list (reverted) |
| crm/routes.ts listContacts | prisma.clientMemory.findMany | single OR query replacing N+1 | VERIFIED | lines 85-90: findMany with OR phone8List |
| crm-screen.tsx contact detail panel | ContactPersistentMemory.data | detail.memory.name rendered | PARTIAL | JSX renders `detail.memory.name` but API never returns `memory` field |
| app.ts startup sequence | run-migrations.ts:runMigrations | called for each tenant | VERIFIED | app.ts line 223: loop over tenants, await runMigrations() |
| run-migrations.ts | platformPrisma.$executeRawUnsafe | SQL migration execution + schema_migrations insert | VERIFIED | lines 283, 307 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| crm-screen.tsx ContactCard | `c.phoneNumber` | routes.ts contact list API | phoneNumber is returned (cleanPhone output) but rawJid is not | STATIC — for LID contacts phoneNumber=null, jid='', no rawJid field in response |
| crm-screen.tsx handleSend | `selected.jid` as targetJid | routes.ts: `jid: c.contact.phoneNumber ?? ""` | For LID contacts, `jid` = '' (null coalesced to empty string) | DISCONNECTED — LID contacts get empty jid, targetJid omitted silently |
| crm-screen.tsx contact detail memory section | `detail.memory` | routes.ts contact detail: flat fields, no `memory` key | ClientMemory IS fetched (line 146) but not nested as `memory` in response | HOLLOW_PROP — `detail.memory` always undefined |
| run-migrations.ts MIGRATIONS | per-tenant schema_migrations | $queryRawUnsafe reads applied versions | Returns real applied version rows | FLOWING |
| crm/routes.ts clientMemory batch | `memoryMap` from findMany | Single findMany with OR phone8List | Returns real memory rows | FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED — tests cannot be run without a running server and database. The key test behaviors are covered by unit tests (all passing). Behavioral integration tests for LID send path and null phoneNumber display require human verification.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| CRM-01 | 02-01 | LID/JID normalized at ingestion — real number stored, never internal code | SATISFIED | rawJid schema, LID-fork upsert in service.ts, BullMQ reconciliation queue and worker all present |
| CRM-02 | 02-02 | Formatted number displayed on all CRM surfaces — no @lid or raw JID visible | BLOCKED | crm-screen.tsx inline formatPhone reverted by 02-03 merge conflict; Aguardando número absent; panel lib/format-phone.ts exists but not imported |
| CRM-03 | 02-03 | Custom capture fields saving and loading correctly | BLOCKED | 'Dados capturados' section in crm-screen.tsx exists but API route never returns `memory` nested field — section always hidden |
| CRM-04 | 02-03 | Full conversation history per contact without session loss | PARTIAL | `take: 500` + `orderBy: createdAt asc` present, but rawJid fallback removed: LID contacts get `contains: ''` matching all messages |
| CRM-05 | 02-03 | Contact tags working end-to-end | SATISFIED | tags schema param + hasSome in convWhere confirmed at routes.ts lines 14, 61 |
| CRM-06 | 02-02, 02-03 | Visual interface without broken states | BLOCKED | N+1 fix and pagination cap done. But null phoneNumber renders as empty string (not "Aguardando número") — CRM-06 not met for LID contacts |
| CRM-07 | 02-02 | Send message from CRM using correct identifier (never LID) | BLOCKED | Send path uses `selected.jid` which is `phoneNumber ?? ""`. For LID contacts jid='', targetJid is silently omitted. The `rawJid` fallback was reverted. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| apps/api/src/modules/crm/routes.ts | 137 | `cleanPhone(contact.phoneNumber).slice(-8)` — no null guard | Blocker | When phoneNumber=null: phone8='', `contains: ''` matches ALL messages — returns entire instance message history |
| apps/panel/components/tenant/crm-screen.tsx | 88-95 | Inline `formatPhone(raw: string)` — does not accept null | Blocker | CrmContact.phoneNumber can be null (from API); calling formatPhone(null) against signature `(raw: string)` is a TypeScript safety issue |
| apps/panel/components/tenant/crm-screen.tsx | 411 | `selected.jid ? { targetJid: selected.jid } : {}` — silent omission | Blocker | For LID contacts jid='', targetJid omitted, send proceeds with only `to: normalizePhoneForSend(null)` which returns '' |
| apps/api/src/lib/tenant-schema.ts | 115-117 | ALTER TABLE statements inside buildTenantSchemaSql() | Warning | 3 rawJid-related ALTER TABLE statements remain in baseline function (should be in MIGRATIONS only); causes double-execution (once in baseline, once via MIGRATIONS[]) |

### Human Verification Required

1. **LID contact send delivery**
   - **Test:** In the CRM panel, open a conversation from a @lid contact (phoneNumber=null), type a message, and press Send
   - **Expected:** Either message delivers successfully using rawJid as targetJid, OR a "Número não disponível" error toast is shown (neither currently happens — send silently proceeds with empty phone)
   - **Why human:** Cannot verify Baileys message delivery behavior programmatically

2. **Contact list for LID contacts**
   - **Test:** Open CRM contacts list when at least one contact has phoneNumber=null (a @lid contact that hasn't been reconciled)
   - **Expected:** Contact card shows "Aguardando número" in italic sub-line (currently shows "" or crashes on null)
   - **Why human:** Requires live data with unresolved LID contacts

3. **Custom fields display after save**
   - **Test:** In panel, open a contact detail that has been through a conversation where AI extracted serviceInterest/status fields. Verify those fields appear under "Dados capturados"
   - **Expected:** Fields visible with values extracted by AI
   - **Why human:** API gap (memory not in response) prevents this from working — needs to be confirmed as completely non-functional

## Gaps Summary

**Root cause:** Worktree merge conflict regression in commit `caf4a29`. The Plan 02-03 executor ran from an old base that pre-dated `d660e1a` (Plan 02-02 CRM surfaces), causing a 3-file clobber of the CRM surface work.

**Affected files:**
- `apps/panel/components/tenant/crm-screen.tsx` — formatPhone import, null phone placeholder, rawJid send path all reverted
- `apps/api/src/modules/crm/routes.ts` — rawJid select and response field reverted, messages rawJid fallback removed

**Separate unresolved gap:**
- `apps/api/src/modules/crm/routes.ts` contact detail endpoint does not return `memory:` as a nested object — ContactPersistentMemory UI section is hollow

**Non-blocking gap (idempotent but structurally incorrect):**
- `apps/api/src/lib/tenant-schema.ts` lines 115-117 — 3 ALTER TABLE statements remain in `buildTenantSchemaSql()` after being moved to MIGRATIONS[]

**Requirements blocked by these gaps:** CRM-02, CRM-03, CRM-06, CRM-07 (CRM-04 partially affected for LID contacts)

---

_Verified: 2026-04-16T18:30:00Z_
_Verifier: Claude (gsd-verifier)_
