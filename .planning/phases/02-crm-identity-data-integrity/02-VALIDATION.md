---
phase: 2
slug: crm-identity-data-integrity
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-11
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (assumed — no test files found in codebase scan) |
| **Config file** | `vitest.config.ts` (Wave 0 creates if absent) |
| **Quick run command** | `pnpm vitest run --reporter=verbose apps/api/src/modules/crm` |
| **Full suite command** | `pnpm vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run --reporter=verbose apps/api/src/modules/crm`
- **After every plan wave:** Run `pnpm vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-04-01 | 2.4 | 1 | structural | — | runMigrations skips failed tenants; startup continues | unit | `pnpm vitest run --reporter=verbose -t "runMigrations"` | ❌ W0 | ⬜ pending |
| 02-04-02 | 2.4 | 1 | structural | — | schema_migrations table created for new tenant | integration | manual | — | ⬜ pending |
| 02-01-01 | 2.1 | 2 | CRM-01 | — | @lid string never written to phoneNumber | unit | `pnpm vitest run --reporter=verbose -t "LID normalization"` | ❌ W0 | ⬜ pending |
| 02-01-02 | 2.1 | 2 | CRM-01 | — | rawJid stored when LID unresolvable | unit | `pnpm vitest run --reporter=verbose -t "rawJid fallback"` | ❌ W0 | ⬜ pending |
| 02-01-03 | 2.1 | 2 | CRM-01 | — | BullMQ reconciliation job enqueued on connection.update:open | unit | `pnpm vitest run --reporter=verbose -t "LID reconciliation"` | ❌ W0 | ⬜ pending |
| 02-02-01 | 2.2 | 3 | CRM-02 | — | formatPhone("+5511987654321") === "+55 11 98765-4321" | unit | `pnpm vitest run --reporter=verbose -t "formatPhone"` | ❌ W0 | ⬜ pending |
| 02-02-02 | 2.2 | 3 | CRM-07 | — | send-from-CRM uses targetJid, not display phone | e2e | manual | — | ⬜ pending |
| 02-03-01 | 2.3 | 4 | CRM-06 | — | N+1 replaced: single clientMemory.findMany query | unit | `pnpm vitest run --reporter=verbose -t "CRM contacts batch"` | ❌ W0 | ⬜ pending |
| 02-03-02 | 2.3 | 4 | CRM-03 | — | Custom fields rendered in contact detail panel | e2e | manual | — | ⬜ pending |
| 02-03-03 | 2.3 | 4 | CRM-04 | — | Tags survive page reload | e2e | manual | — | ⬜ pending |
| 02-03-04 | 2.3 | 4 | CRM-05 | — | Conversation history shows messages from multiple sessions | e2e | manual | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/modules/crm/__tests__/lid-normalization.test.ts` — stubs for CRM-01 (LID→phoneNumber, rawJid fallback)
- [ ] `apps/api/src/modules/crm/__tests__/format-phone.test.ts` — stubs for CRM-02 (formatPhone output contract)
- [ ] `apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts` — stubs for CRM-06 (N+1 fix)
- [ ] `apps/api/src/lib/__tests__/run-migrations.test.ts` — stubs for 2.4 (runMigrations error isolation)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| send-from-CRM delivers to LID-affected contact | CRM-07 | Requires live Baileys instance + WhatsApp connection | Open CRM, select @lid contact, send message, verify delivery in WhatsApp |
| Custom fields rendered in contact detail | CRM-03 | React rendering — requires browser | Open contact detail, verify AI-extracted fields visible |
| Tags survive page reload | CRM-04 | Browser persistence — requires UI | Assign tag, reload page, verify tag still shown |
| Conversation history cross-session | CRM-05 | Requires multi-session contact data | Open contact with 3+ sessions, verify all messages visible |
| schema_migrations table created for new tenant | structural | Requires DB introspection | Provision test tenant, query `information_schema.tables` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
