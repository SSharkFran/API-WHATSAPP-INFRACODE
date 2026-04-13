---
phase: 3
slug: admin-identity-service
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-13
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.2.4 |
| **Config file** | `apps/api/vitest.config.ts` |
| **Quick run command** | `cd apps/api && pnpm test -- admin-identity` |
| **Full suite command** | `cd apps/api && pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/api && pnpm test -- admin-identity`
- **After every plan wave:** Run `cd apps/api && pnpm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 0 | ADM-01 | — | Unit stubs created before extraction | unit | `pnpm test -- admin-identity` | ❌ W0 | ⬜ pending |
| 3-01-02 | 01 | 1 | ADM-01, ADM-02 | — | Admin phone routes to admin handler, never ChatbotService | unit | `pnpm test -- admin-identity` | ❌ W0 | ⬜ pending |
| 3-01-03 | 01 | 1 | ADM-02 | — | Admin identified when aprendizadoContinuo module null/disabled | unit | `pnpm test -- admin-identity` | ❌ W0 | ⬜ pending |
| 3-01-04 | 01 | 1 | ADM-01 | — | fromMe echo does NOT match as admin | unit | `pnpm test -- admin-identity` | ❌ W0 | ⬜ pending |
| 3-02-01 | 02 | 1 | ADM-03 | — | @lid remoteJid matched via Redis-cached admin JID | unit (mock Redis) | `pnpm test -- admin-identity` | ❌ W0 | ⬜ pending |
| 3-03-01 | 03 | 2 | ADM-04 | T-3-01 | Platform route without PLATFORM_OWNER token returns 403 | integration | `pnpm test -- security` | ✅ partial | ⬜ pending |
| 3-03-02 | 03 | 2 | ADM-04 | — | Single call site for isAdmin in handleInboundMessage | unit | `pnpm test -- admin-identity` | ❌ W0 | ⬜ pending |
| 3-04-01 | 04 | 3 | ADM-01 | — | Structured logger output visible in admin checks | manual | — | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/modules/instances/__tests__/admin-identity.service.test.ts` — stubs for ADM-01, ADM-02, ADM-03 with four key scenarios: (1) admin phone matches, (2) module disabled still detects, (3) LID-form JID resolved via Redis, (4) fromMe echo is NOT admin
- [ ] `apps/api/test/admin-platform-routes.test.ts` — ADM-04 platform route guard test (or extension of `security.test.ts`)

*Existing infrastructure: Vitest 3.2.4 + `apps/api/test/setup.ts` env stubs confirmed — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Pino structured logger output for admin checks | ADM-01 | Requires running instance + live WhatsApp connection | Send admin message, inspect stdout for `AdminIdentityService` log line with `isAdmin: true` |
| Scheduler moves after listen() | ADM-01 (PITFALL 8) | Requires app startup observation | Start server, confirm no scheduler errors before `app.listen` completes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
