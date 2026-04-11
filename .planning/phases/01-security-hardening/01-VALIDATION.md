---
phase: 1
slug: security-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-10
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest / vitest (existing) |
| **Config file** | `apps/api/jest.config.ts` or equivalent |
| **Quick run command** | `cd apps/api && npm test -- --testPathPattern=security` |
| **Full suite command** | `cd apps/api && npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/api && npm test -- --testPathPattern=security`
- **After every plan wave:** Run `cd apps/api && npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 0 | SEC-01 | — | CORS test stubs created | unit | `cd apps/api && npm test -- --testPathPattern=security` | ❌ W0 | ⬜ pending |
| 1-01-02 | 01 | 1 | SEC-01 | PITFALL-4 | Cross-origin request from unlisted origin returns no `Access-Control-Allow-Origin` header | unit | `cd apps/api && npm test -- --testPathPattern=security` | ✅ | ⬜ pending |
| 1-02-01 | 02 | 1 | SEC-02 | PITFALL-6 | Startup fails with fatal error when `ENABLE_AUTH !== 'true'` and `NODE_ENV !== 'development'` | unit | `cd apps/api && npm test -- --testPathPattern=security` | ✅ | ⬜ pending |
| 1-03-01 | 03 | 1 | SEC-03 | PITFALL-5 | `aiFallbackApiKey` is stored as encrypted ciphertext; decrypt round-trip returns original value | unit | `cd apps/api && npm test -- --testPathPattern=security` | ✅ | ⬜ pending |
| 1-03-02 | 03 | 1 | SEC-03 | PITFALL-5 | GET response for `aiFallbackApiKey` returns masked value (`sk-...****`) | unit | `cd apps/api && npm test -- --testPathPattern=security` | ✅ | ⬜ pending |
| 1-04-01 | 04 | 1 | SEC-04 | PITFALL-3 | Startup asserts `DATA_DIR` is outside project root; exits fatally if not | unit | `cd apps/api && npm test -- --testPathPattern=security` | ✅ | ⬜ pending |
| 1-04-02 | 04 | 1 | SEC-04 | — | `?accessToken=` and `?apiKey=` query params rejected on HTTP paths | unit | `cd apps/api && npm test -- --testPathPattern=security` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/test/security.test.ts` — stubs for SEC-01, SEC-02, SEC-03, SEC-04
- [ ] `apps/api/test/crypto.test.ts` additions — encrypt/decrypt round-trip for `aiFallbackApiKey`

*Existing infrastructure (jest/vitest) already in place — no new framework installation needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `git ls-files apps/api/data/` returns empty | SEC-04 | Requires git state inspection | Run `git ls-files apps/api/data/` in a fresh clone — must return empty |
| DB query shows ciphertext for `ai_fallback_api_key` | SEC-03 | Requires live database access | Connect to DB with psql, run `SELECT ai_fallback_api_key FROM chatbot_config LIMIT 1;` — value must be unreadable ciphertext |
| WebSocket `?accessToken=` still accepted on upgrade | SEC-04 | Requires live WebSocket client | Connect a WS client using query-string auth — must still work on upgrade endpoint |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
