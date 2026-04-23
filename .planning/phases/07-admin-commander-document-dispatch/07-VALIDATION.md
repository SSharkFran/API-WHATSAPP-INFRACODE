---
phase: 7
slug: admin-commander-document-dispatch
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-20
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.4 |
| **Config file** | apps/api/vitest.config.ts |
| **Quick run command** | `cd apps/api && npm test -- --run` |
| **Full suite command** | `cd apps/api && npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/api && npm test -- --run`
- **After every plan wave:** Run `cd apps/api && npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 7-01-01 | 01 | 1 | CMD-01 | T-7-01 | Admin identity verified before command execution | unit | `cd apps/api && npm test -- --run admin-command` | ❌ W0 | ⬜ pending |
| 7-01-02 | 01 | 1 | CMD-02 | T-7-02 | Prefix parser routes /status, /resumo, /contrato, /proposta, /encerrar correctly | unit | `cd apps/api && npm test -- --run admin-command` | ❌ W0 | ⬜ pending |
| 7-01-03 | 01 | 1 | CMD-06 | — | LLM fallback classifies free-text into known intents | unit | `cd apps/api && npm test -- --run admin-command` | ❌ W0 | ⬜ pending |
| 7-02-01 | 02 | 2 | DOC-01 | T-7-03 | File size >= 5 MB triggers warning, not silent send/reject | unit | `cd apps/api && npm test -- --run document-dispatch` | ❌ W0 | ⬜ pending |
| 7-02-02 | 02 | 2 | DOC-02 | T-7-04 | Contact lookup by name returns correct JID | unit | `cd apps/api && npm test -- --run document-dispatch` | ❌ W0 | ⬜ pending |
| 7-02-03 | 02 | 2 | DOC-03 | — | PDF sent via base64 buffer (not file:// URL) | unit | `cd apps/api && npm test -- --run document-dispatch` | ❌ W0 | ⬜ pending |
| 7-03-01 | 03 | 2 | CMD-05 | T-7-05 | AdminActionLog row written for every command | unit | `cd apps/api && npm test -- --run admin-action-log` | ❌ W0 | ⬜ pending |
| 7-04-01 | 04 | 3 | CMD-06 | — | /status returns health + session count + today's messages | unit | `cd apps/api && npm test -- --run status-query` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/modules/instances/__tests__/admin-command.handler.spec.ts` — stubs for CMD-01, CMD-02, CMD-06
- [ ] `apps/api/src/modules/instances/__tests__/document-dispatch.service.spec.ts` — stubs for DOC-01, DOC-02, DOC-03
- [ ] `apps/api/src/modules/instances/__tests__/admin-action-log.service.spec.ts` — stubs for CMD-05

*All test files use vitest. Config: `apps/api/vitest.config.ts`. Run with `cd apps/api && npm test -- --run`.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Admin WhatsApp → client receives PDF with personalized caption | DOC-04 | Requires live WhatsApp session + real device | Send `/contrato [name]` from admin JID; verify client JID receives document with caption containing client name |
| Panel action history page renders correctly | CMD-05 | Requires browser + logged-in tenant session | Navigate to /tenant/action-history; verify rows show requester JID, timestamp, document name, delivery status |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
