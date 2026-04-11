---
phase: 01-security-hardening
verified: 2026-04-10T12:00:00Z
status: human_needed
score: 4/4 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Deploy to a staging environment without ENABLE_AUTH=true and observe startup output"
    expected: "Application refuses to start with a fatal error message containing 'ENABLE_AUTH'"
    why_human: "Cannot spin up a real staging deployment in a code-only verification pass"
  - test: "Open the tenant database and run: SELECT \"aiFallbackApiKey\" FROM \"ChatbotConfig\" WHERE \"aiFallbackApiKey\" IS NOT NULL LIMIT 1"
    expected: "Returned value is unreadable iv.tag.ciphertext format — no human-readable Groq/Gemini API key string"
    why_human: "Requires live database access; verification can only check the encrypt call site in code, not the stored DB values for existing tenants"
  - test: "Make a cross-origin request from a non-whitelisted origin using browser DevTools or curl: curl -H 'Origin: https://evil.com' -I https://<production-domain>/health"
    expected: "Response has no Access-Control-Allow-Origin header"
    why_human: "Requires a running deployment against a real domain to confirm headers are set correctly end-to-end (CORS behavior differs between inject() and real HTTP)"
---

# Phase 01: Security Hardening Verification Report

**Phase Goal:** Close four pre-launch security gaps (SEC-01 through SEC-04) before the first production deploy.
**Verified:** 2026-04-10T12:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A cross-origin request from any domain not in ALLOWED_ORIGINS receives no Access-Control-Allow-Origin header | VERIFIED | `app.ts:215` uses `app.config.ALLOWED_ORIGINS.split(',').map(s => s.trim())` as origin allowlist; `origin: true` is absent; SEC-01 tests A+B are substantive (not stubs) and exercise `buildApp()` with inject |
| 2 | A staging deployment that omits ENABLE_AUTH=true refuses to start | VERIFIED | `config.ts:64` guard: `if (!parsed.ENABLE_AUTH && parsed.NODE_ENV !== "development")` throws with ENABLE_AUTH message; `auth.ts:45` bypass narrowed to `NODE_ENV === 'development'` only |
| 3 | The aiFallbackApiKey column contains only encrypted ciphertext — never plaintext | VERIFIED (code) | `service.ts:646,674` call `encrypt(input.aiFallbackApiKey.trim(), this.config.API_ENCRYPTION_KEY)` on both write paths; `service.ts:1417` decrypts on read; `routes.ts:48,80,207` apply `maskKey()` to all three response paths |
| 4 | git ls-files apps/api/data/ returns empty — no session files tracked | VERIFIED | `git ls-files apps/api/data/` returned empty; `.gitignore:9` contains `apps/api/data`; startup assertion at `app.ts:57` blocks insecure DATA_DIR at boot |

**Score:** 4/4 truths verified (code evidence)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/test/security.test.ts` | 9 failing stubs for all SEC-XX behaviors | VERIFIED | File exists, 9 `it()` blocks, all now implemented and GREEN per SUMMARY 01-04 |
| `apps/api/src/app.ts` | CORS allowlist via ALLOWED_ORIGINS; DATA_DIR startup assertion | VERIFIED | `origin: app.config.ALLOWED_ORIGINS.split(',').map(s => s.trim())` at line 215; `resolve(config.DATA_DIR)` assertion at line 54; `process.exit(1)` at line 72 |
| `apps/api/src/config.ts` | ALLOWED_ORIGINS Zod field; broadened auth guard | VERIFIED | `ALLOWED_ORIGINS: z.string().min(1).default("http://localhost:3000")` at line 46; guard `NODE_ENV !== "development"` at line 64 |
| `apps/api/src/plugins/auth.ts` | Bypass narrowed to development; query-string removed for HTTP | VERIFIED | `!app.config.ENABLE_AUTH && app.config.NODE_ENV === 'development'` at line 45; `isWebSocketUpgrade` ternary at line 71 prevents unconditional query fallback |
| `apps/api/src/modules/chatbot/service.ts` | encrypt on write (2 sites); decrypt on read | VERIFIED | `encrypt(input.aiFallbackApiKey.trim(), ...)` at lines 646 and 674; `decrypt(record.aiFallbackApiKey, ...)` at line 1417 |
| `apps/api/src/modules/chatbot/routes.ts` | maskKey applied to all aiFallbackApiKey response paths | VERIFIED | `maskKey()` defined at line 18; applied at lines 48, 80, and 207 — all three response-returning paths |
| `apps/api/src/lib/migrate-fallback-key.ts` | Idempotent migration script exporting migrateFallbackApiKeys | VERIFIED | File exists; `migrateFallbackApiKeys` exported at line 31; `isAlreadyEncrypted()` guard at line 21; idempotency check at line 46 |
| `apps/api/test/setup.ts` | DATA_DIR set outside project root | VERIFIED | `process.env.DATA_DIR ??= "/tmp/infracode-test-sessions"` at line 16 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `app.ts` | `config.ts` ALLOWED_ORIGINS | `app.config.ALLOWED_ORIGINS.split(',').map` | WIRED | Pattern confirmed at app.ts:215 |
| `auth.ts` | `config.ts` NODE_ENV | `app.config.NODE_ENV === 'development'` | WIRED | Pattern confirmed at auth.ts:45 |
| `service.ts` write path | `lib/crypto.ts` | `encrypt(input.aiFallbackApiKey.trim(), this.config.API_ENCRYPTION_KEY)` | WIRED | Confirmed at lines 646, 674; import at line 9 |
| `service.ts` read path | `lib/crypto.ts` | `decrypt(record.aiFallbackApiKey, this.config.API_ENCRYPTION_KEY)` | WIRED | Confirmed at line 1417 |
| `routes.ts` | `service.ts` getConfig (plaintext) | `{ ...config, aiFallbackApiKey: maskKey(config.aiFallbackApiKey) }` | WIRED | maskKey applied at lines 48, 80, 207 |
| `auth.ts` WS gate | auth.ts query fallback | `request.headers.upgrade?.toLowerCase() === 'websocket'` | WIRED | isWebSocketUpgrade ternary at line 71 — HTTP paths get `undefined`, WS gets `query?.accessToken` |
| `app.ts` startup | `config.ts` DATA_DIR | `resolve(config.DATA_DIR)` vs `resolve(process.cwd())` | WIRED | Assertion block at lines 54-72 with `process.exit(1)` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `routes.ts` response | `aiFallbackApiKey` (masked) | `service.ts getConfig()` → `decrypt(record.aiFallbackApiKey, ...)` → maskKey | Reads from DB record; decrypt only fires when record value is non-null | FLOWING |
| `routes.ts` PATCH leads-phone | `aiFallbackApiKey` upsert input | `getConfig()` plaintext → passed to `upsertConfig()` which re-encrypts | Round-trip is correct by design (plaintext in → encrypted stored) | FLOWING |
| `auth.ts` bypass | `NODE_ENV` check | `app.config.NODE_ENV` from Zod-validated env | Real env var, not hardcoded | FLOWING |

### Behavioral Spot-Checks

Step 7b: Skipped for direct HTTP/live DB checks — those require a running server. Code-level checks below confirm wiring.

| Behavior | Check | Result | Status |
|----------|-------|--------|--------|
| `origin: true` removed | `grep "origin: true" apps/api/src/app.ts` | No match | PASS |
| ALLOWED_ORIGINS in config | `grep "ALLOWED_ORIGINS" apps/api/src/config.ts` | Line 46 confirmed | PASS |
| Guard is `!== development` | `grep "NODE_ENV !== .development" apps/api/src/config.ts` | Line 64 confirmed | PASS |
| Auth bypass narrowed | `grep "NODE_ENV === 'development'" apps/api/src/plugins/auth.ts` | Line 45 confirmed | PASS |
| encrypt on write (2 sites) | `grep "encrypt(input.aiFallbackApiKey" service.ts` | Lines 646, 674 | PASS |
| decrypt on read | `grep "decrypt(record.aiFallbackApiKey" service.ts` | Line 1417 | PASS |
| maskKey on all 3 routes | `grep "maskKey" routes.ts` | Lines 18, 48, 80, 207 | PASS |
| isWebSocketUpgrade guard | `grep "isWebSocketUpgrade" auth.ts` | Line 70 confirmed | PASS |
| DATA_DIR assertion | `grep "dataDir.startsWith" app.ts` | Line 57 confirmed | PASS |
| process.exit(1) present | `grep "process.exit" app.ts` | Line 72 confirmed | PASS |
| DATA_DIR in setup.ts | `grep "DATA_DIR" test/setup.ts` | /tmp/infracode-test-sessions at line 16 | PASS |
| git session files | `git ls-files apps/api/data/` | Empty output | PASS |
| migrateFallbackApiKeys exported | `grep "migrateFallbackApiKeys" migrate-fallback-key.ts` | Lines 6, 8, 31, 75 | PASS |
| isAlreadyEncrypted guard | `grep "isAlreadyEncrypted" migrate-fallback-key.ts` | Lines 21, 46 | PASS |
| Commits verified | All 8 plan commits in git log | All present (3951a4b...21d7924) | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SEC-01 | 01-02 | CORS configured with explicit allowlist — no `origin: true` | SATISFIED | `origin: app.config.ALLOWED_ORIGINS.split(',').map(s => s.trim())` at app.ts:215; `origin: true` absent |
| SEC-02 | 01-02 | Auth bypass restricted exclusively to `NODE_ENV=development` | SATISFIED | Guard `!parsed.ENABLE_AUTH && parsed.NODE_ENV !== "development"` at config.ts:64; bypass condition at auth.ts:45 |
| SEC-03 | 01-03 | `aiFallbackApiKey` encrypted with same pattern as `aiApiKeyEncrypted` | SATISFIED | encrypt at write (service.ts:646,674), decrypt at read (service.ts:1417), maskKey at response (routes.ts:48,80,207), migration script with idempotency guard |
| SEC-04 | 01-04 | Session files outside git, DATA_DIR startup assertion, query-string tokens removed | SATISFIED | .gitignore:9 covers apps/api/data; git ls-files empty; startup assertion at app.ts:54-72; isWebSocketUpgrade ternary in auth.ts:71 |

All four SEC-01 through SEC-04 requirements mapped to Phase 1 in REQUIREMENTS.md traceability table are accounted for. No orphaned requirements found.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `routes.ts` | 183 | `aiFallbackApiKey: currentConfig.aiFallbackApiKey ?? null` (unmasked) | Info | This is a write-path argument to `upsertConfig()` — not a response. `getConfig()` returns plaintext (decrypted), which is correctly re-encrypted by `upsertConfig()`. Response at line 207 applies `maskKey()`. Not a leak. |

No blocker or warning anti-patterns found. The apparent unmasked usage at line 183 is a write-path data flow, not a response field.

### Human Verification Required

Three items require human or deployed-environment testing to confirm full end-to-end behavior. All automated code checks passed.

#### 1. Staging Startup Refusal

**Test:** Deploy the API to a staging-equivalent environment (NODE_ENV=production or any non-development value) with `ENABLE_AUTH` unset or empty. Observe startup output.
**Expected:** Application exits immediately with a fatal error message containing "ENABLE_AUTH must be 'true' in all non-development environments".
**Why human:** Cannot spin up a real staging/production deployment in a code-only verification pass. The `loadConfig()` guard is correct in code, but the deployed behavior (including env var injection by the host platform) must be confirmed once.

#### 2. Database Ciphertext Confirmation for Existing Rows

**Test:** On a database with existing tenant data, run: `SELECT "aiFallbackApiKey" FROM public."ChatbotConfig" WHERE "aiFallbackApiKey" IS NOT NULL LIMIT 5;`
**Expected:** All returned values are in `iv.tag.ciphertext` format (three base64 segments separated by dots) — no Groq/Gemini API key strings visible.
**Why human:** The migration script `migrate-fallback-key.ts` exists and is idempotent, but it must be manually executed against each tenant schema before existing plaintext rows are encrypted. Verification can only confirm the code path — not that the migration has actually been run in production.

#### 3. CORS Rejection on Live Deployment

**Test:** Against a deployed API instance, run: `curl -v -H "Origin: https://evil.com" https://<production-domain>/health`
**Expected:** Response does NOT contain `Access-Control-Allow-Origin` header.
**Why human:** Fastify's inject() method used in tests bypasses the actual HTTP layer. CORS behavior in production (including any reverse proxy configuration that might override headers) must be confirmed with a real HTTP client against the live endpoint.

### Gaps Summary

No gaps found. All four observable truths are verified against the actual codebase with commit evidence. The three human verification items are deployment-environment confirmations, not code defects — the implementation is complete and wired correctly.

---

_Verified: 2026-04-10T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
