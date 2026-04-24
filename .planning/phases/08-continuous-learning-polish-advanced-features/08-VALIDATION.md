---
phase: 8
slug: continuous-learning-polish-advanced-features
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-24
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest 29.x / vitest |
| **Config file** | apps/api/jest.config.ts |
| **Quick run command** | `npx jest --testPathPattern=aprendizadoContinuo --passWithNoTests` |
| **Full suite command** | `npx jest --passWithNoTests` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx jest --testPathPattern=aprendizadoContinuo --passWithNoTests`
- **After every plan wave:** Run `npx jest --passWithNoTests`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 8-01-01 | 01 | 1 | APR-01 | — | Disabled module returns false/[] for all methods | unit | `npx jest --testPathPattern=DisabledAprendizadoContinuoModule` | ❌ W0 | ⬜ pending |
| 8-01-02 | 01 | 1 | APR-01 | — | No isEnabled guards remain in services | lint/grep | `grep -r "isEnabled" apps/api/src/modules/chatbot --include="*.ts" \| grep -v "interface\|class\|method" \| wc -l` | ✅ | ⬜ pending |
| 8-02-01 | 02 | 2 | APR-02 | T-8-01 | Knowledge not ingested without SIM confirmation | unit | `npx jest --testPathPattern=EscalationService` | ❌ W0 | ⬜ pending |
| 8-02-02 | 02 | 2 | APR-04 | — | Escalation TTL expires after 4h, marks unanswered | unit | `npx jest --testPathPattern=confirmation-gate` | ❌ W0 | ⬜ pending |
| 8-03-01 | 03 | 2 | APR-05 | — | LearningLog migration adds confirmedAt/confirmedByJid | manual | check DB migration output | ✅ | ⬜ pending |
| 8-03-02 | 03 | 2 | APR-06 | — | Panel delete removes entry from KB | e2e | manual browser test | ✅ | ⬜ pending |
| 8-04-01 | 04 | 3 | URG-01 | — | urgencyScore persisted from Redis to PostgreSQL | unit | `npx jest --testPathPattern=SessionMetricsCollector` | ❌ W0 | ⬜ pending |
| 8-04-02 | 04 | 3 | FOL-01 | T-8-02 | Follow-up outside 24h window is blocked | unit | `npx jest --testPathPattern=FollowUpService` | ❌ W0 | ⬜ pending |
| 8-04-03 | 04 | 3 | FOL-02 | — | Override logged when admin forces out-of-window send | unit | `npx jest --testPathPattern=FollowUpService` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/modules/chatbot/__tests__/disabled-aprendizado-continuo.test.ts` — stubs for APR-01
- [ ] `apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts` — stubs for APR-02, APR-04
- [ ] `apps/api/src/modules/chatbot/__tests__/session-metrics-collector.test.ts` — stubs for URG-01
- [ ] `apps/api/src/modules/chatbot/__tests__/follow-up-service.test.ts` — stubs for FOL-01, FOL-02

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| "Conhecimento Adquirido" panel page renders learned Q&A pairs | APR-05 | UI rendering verification | Open panel, navigate to tenant settings → Conhecimento Adquirido, verify list shows |
| Dashboard urgency column is sortable | URG-02 | UI interaction | Open conversation queue, click urgency column header, verify sort order changes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
