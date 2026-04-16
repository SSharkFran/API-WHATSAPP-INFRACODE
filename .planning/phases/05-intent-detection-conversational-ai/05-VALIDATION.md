---
phase: 5
slug: intent-detection-conversational-ai
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-15
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.2.4 |
| **Config file** | `apps/api/vitest.config.ts` |
| **Quick run command** | `pnpm --filter api test` |
| **Full suite command** | `pnpm --filter api test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter api test`
- **After every plan wave:** Run `pnpm --filter api test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 5-01-01 | 01 | 0 | IA-01 | T-5-01 | LLM output validated against VALID_INTENT_LABELS whitelist | unit | `pnpm --filter api test -- intent-classifier` | ❌ W0 | ⬜ pending |
| 5-01-02 | 01 | 1 | IA-01 | T-5-01 | classifyIntent() returns OUTRO on LLM failure (never blocks pipeline) | unit | `pnpm --filter api test -- intent-classifier` | ❌ W0 | ⬜ pending |
| 5-02-01 | 02 | 0 | IA-02 | T-5-02 | ENCERRAMENTO emits session.close_intent_detected via eventBus | unit | `pnpm --filter api test -- intent-wiring` | ❌ W0 | ⬜ pending |
| 5-02-02 | 02 | 1 | IA-02 | T-5-02 | URGENCIA_ALTA emits session.urgency_detected event | unit | `pnpm --filter api test -- intent-wiring` | ❌ W0 | ⬜ pending |
| 5-02-03 | 02 | 1 | IA-02, IA-06 | T-5-03 | TRANSFERENCIA_HUMANO sets humanTakeover:true and sends admin notification | unit | `pnpm --filter api test -- intent-wiring` | ❌ W0 | ⬜ pending |
| 5-03-01 | 03 | 1 | IA-03, IA-04 | T-5-04 | evaluateInbound null → honest fallback fires, never silence | unit | `pnpm --filter api test -- chatbot-fallback` | ❌ W0 | ⬜ pending |
| 5-03-02 | 03 | 1 | IA-04 | — | Admin NOT notified when aprendizadoContinuo is disabled | unit | `pnpm --filter api test -- chatbot-fallback` | ❌ W0 | ⬜ pending |
| 5-03-03 | 03 | 1 | IA-03 | T-5-04 | Honest fallback does NOT fire during humanTakeover (intentional silence) | unit | `pnpm --filter api test -- chatbot-fallback` | ❌ W0 | ⬜ pending |
| 5-04-01 | 04 | 1 | IA-03, IA-05 | — | Sub-agent failure causes GeneralAgent fallback, not silence or throw | unit | `pnpm --filter api test -- orchestrator` | ❌ W0 | ⬜ pending |
| 5-04-02 | 04 | 2 | IA-05 | — | Fire-and-forget void calls replaced with BullMQ jobs | integration | `pnpm --filter api test` | ❌ W0 | ⬜ pending |
| 5-02-04 | 02 | 2 | IA-06 | T-5-03 | Human handoff notifies admin with last 5 conversation exchanges | unit | `pnpm --filter api test -- intent-wiring` | ❌ W0 | ⬜ pending |
| 5-SESS-09 | 01 | 2 | SESS-09 | — | recognizeCloseIntent replaced — no double-emit of close_intent_detected | manual | Staging: 50 pt-BR closure phrases | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/modules/instances/__tests__/intent-classifier.service.test.ts` — stubs for IA-01 (classifyIntent label + failure fallback)
- [ ] `apps/api/src/modules/instances/__tests__/intent-wiring.test.ts` — stubs for IA-02, IA-06 (event emissions, humanTakeover)
- [ ] `apps/api/src/modules/chatbot/__tests__/chatbot-fallback.test.ts` — stubs for IA-03, IA-04 (honest fallback, module gate)
- [ ] Confirm `apps/api/src/modules/chatbot/agents/__tests__/orchestrator.test.ts` exists or create stub — covers IA-05

*All test files are NEW (❌ W0). Existing vitest infrastructure covers execution — no framework changes needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| 50 pt-BR closure expressions classified correctly | SESS-09, IA-01 | Staging LLM evaluation — cannot mock Groq in unit tests for accuracy | Deploy with `INTENT_CLASSIFIER_V2=true` to staging; send 50 phrases, verify ≥90% ENCERRAMENTO recall |
| Session enters CONFIRMACAO_ENVIADA after "era só isso, muito obrigado" | IA-02 | End-to-end WhatsApp flow | Send phrase via real WhatsApp number on staging; verify session state in DB |
| Admin receives WhatsApp notification with summary on TRANSFERENCIA_HUMANO | IA-06 | Requires real WhatsApp send | Send "quero falar com um humano" on staging; verify admin phone receives message with conversation context |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
