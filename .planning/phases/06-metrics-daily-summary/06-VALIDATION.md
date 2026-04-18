---
phase: 6
slug: metrics-daily-summary
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-17
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest 29.x / vitest |
| **Config file** | `apps/api/jest.config.ts` / `apps/panel/vitest.config.ts` |
| **Quick run command** | `pnpm --filter api test --testPathPattern=session-metrics` |
| **Full suite command** | `pnpm --filter api test && pnpm --filter panel test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter api test --testPathPattern=session-metrics`
- **After every plan wave:** Run `pnpm --filter api test && pnpm --filter panel test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 6-01-01 | 01 | 0 | MET-01 | — | N/A | unit stub | `pnpm --filter api test --testPathPattern=session-metrics` | ❌ W0 | ⬜ pending |
| 6-01-02 | 01 | 1 | MET-01 | — | documentCount increments per document.sent event | unit | `pnpm --filter api test --testPathPattern=session-metrics` | ✅ | ⬜ pending |
| 6-01-03 | 01 | 1 | MET-02 | — | durationSeconds = endedAt - startedAt | unit | `pnpm --filter api test --testPathPattern=session-metrics` | ✅ | ⬜ pending |
| 6-01-04 | 01 | 1 | MET-03 | — | firstResponseMs written on first bot outbound | unit | `pnpm --filter api test --testPathPattern=session-metrics` | ✅ | ⬜ pending |
| 6-01-05 | 01 | 1 | MET-04 | — | continuation rate tracked after inactivity message | unit | `pnpm --filter api test --testPathPattern=session-metrics` | ✅ | ⬜ pending |
| 6-01-06 | 01 | 1 | MET-05 | — | documentCount per session increments correctly | unit | `pnpm --filter api test --testPathPattern=session-metrics` | ✅ | ⬜ pending |
| 6-02-01 | 02 | 2 | MET-07 | — | N/A | e2e manual | See Manual-Only Verifications | — | ⬜ pending |
| 6-03-01 | 03 | 2 | MET-06 | — | no summary sent when resumoDiario disabled | unit | `pnpm --filter api test --testPathPattern=daily-summary` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/modules/instances/__tests__/session-metrics-collector.test.ts` — stubs for MET-01 through MET-05
- [ ] `apps/api/src/modules/instances/__tests__/daily-summary.test.ts` — stubs for MET-06

*Existing test infrastructure (jest, vitest) covers the framework — Wave 0 only adds test stub files.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dashboard panel displays correct session counts matching DB | MET-07 | Requires browser + real DB | Run 5 test sessions; check dashboard vs SELECT COUNT from ConversationSession |
| High-urgency sessions appear first in queue with badge | URG-02 | Visual verification | Create urgency-flagged session; verify badge + sort order in browser |
| Admin receives WhatsApp summary at configured time | MET-06 | Requires live WhatsApp instance | Enable resumoDiario, wait for configured hour, verify receipt |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
