---
phase: 01-security-hardening
plan: 03
subsystem: chatbot-security
tags: [encryption, aes-256-gcm, at-rest, tdd, wave-1]
dependency_graph:
  requires: [01-01, 01-02]
  provides: [aiFallbackApiKey-encryption, fallback-key-migration]
  affects: [01-04]
tech_stack:
  added: []
  patterns: [AES-256-GCM encrypt/decrypt, maskKey response masking, idempotent migration script]
key_files:
  created:
    - apps/api/src/lib/migrate-fallback-key.ts
  modified:
    - apps/api/src/modules/chatbot/service.ts
    - apps/api/src/modules/chatbot/routes.ts
    - apps/api/test/security.test.ts
decisions:
  - Used Prisma undefined (not null) in update path so omitted aiFallbackApiKey field leaves DB value unchanged
  - maskKey() defined in routes.ts (not exported from service.ts) — masking is a presentation concern, service returns plaintext for callers
  - Migration uses raw SQL with schema prefix to support per-tenant PostgreSQL schema topology
  - CLI entry point uses process.argv[1] === import.meta.url.pathname — safe for tsx direct execution
metrics:
  duration: ~15 minutes
  completed: 2026-04-11T02:54:42Z
  tasks_completed: 2
  tasks_total: 2
  files_modified: 4
requirements:
  - SEC-03
---

# Phase 01 Plan 03: aiFallbackApiKey At-Rest Encryption Summary

## One-liner

AES-256-GCM encryption applied to aiFallbackApiKey at all write sites; decrypted in memory for AI callers; masked (sk-t...****) in all API responses; idempotent migration script guards existing plaintext rows.

## What Was Built

**SEC-03 — aiFallbackApiKey Encryption (T-01-07, T-01-08):**

- Added `encrypt` import to `chatbot/service.ts` alongside existing `decrypt` import from `lib/crypto.ts`.
- **Encrypt on write** (two sites): both the Prisma `create:` and `update:` blocks now call `encrypt(input.aiFallbackApiKey.trim(), this.config.API_ENCRYPTION_KEY)`. The update path uses `undefined` (Prisma leave-unchanged semantics) when no new key is provided — preserving the existing encrypted value.
- **Decrypt on read** (`mapConfig()`): `record.aiFallbackApiKey ? decrypt(record.aiFallbackApiKey, this.config.API_ENCRYPTION_KEY) : null` — callers receive plaintext. The fallback AI caller at `callFallbackProvider` (line ~2727) already used `config.aiFallbackApiKey ?? ""` and continues to receive plaintext correctly.
- **maskKey() static method** added to `ChatbotService` class for use at the routes layer.
- **Routes masking** (`chatbot/routes.ts`): Added module-level `maskKey()` utility; applied `{ ...config, aiFallbackApiKey: maskKey(config.aiFallbackApiKey) }` to all three response paths (GET `/instances/:id/chatbot`, PUT `/instances/:id/chatbot`, PATCH `/instances/:id/chatbot/leads-phone`).
- **Migration script** (`lib/migrate-fallback-key.ts`): Queries `ChatbotConfig` rows with non-null `aiFallbackApiKey`, skips rows where `isAlreadyEncrypted()` returns true (iv.tag.ciphertext format), encrypts and updates plaintext rows. Multi-schema safe via raw SQL with schema prefix parameter. Never logs plaintext key values. CLI entry point for `pnpm tsx` execution.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| TDD tests | SEC-03 tests E F G implementation | f9aa380 | apps/api/test/security.test.ts |
| 1 | Encrypt on write + decrypt on read in chatbot service | 36c64da | apps/api/src/modules/chatbot/service.ts |
| 2 | Mask API response + idempotent migration script | e9151d5 | apps/api/src/modules/chatbot/routes.ts, apps/api/src/lib/migrate-fallback-key.ts |

## Verification Results

- `grep "encrypt(input.aiFallbackApiKey" service.ts` — 2 matches (lines 646, 674)
- `grep "decrypt(record.aiFallbackApiKey" service.ts` — 1 match (line 1417)
- `grep "maskKey" routes.ts` — 3 response-path matches (lines 48, 80, 207)
- `grep "isAlreadyEncrypted" migrate-fallback-key.ts` — 2 matches (definition + call)
- `grep "migrateFallbackApiKeys" migrate-fallback-key.ts` — export + call confirmed
- SEC-03 tests (E, F, G): GREEN
- SEC-01 tests (A, B): GREEN (no regression)
- SEC-02 tests (C, D): GREEN (no regression)
- SEC-04 tests (H, I): RED (expected stubs for Plan 04)
- Full test run: 32 passed, 2 failed (only SEC-04 stubs), 2 skipped
- `pnpm tsc --noEmit` — exit 0 (no TypeScript errors)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Update path uses `undefined` instead of `existing?.aiFallbackApiKey`**
- **Found during:** Task 1 — examining upsert structure
- **Issue:** The plan suggested using `existing?.aiFallbackApiKey ?? null` in the update path, but the upsert block in this service does NOT pass an `existing` record variable at that scope — it uses Prisma's `upsert` which internally handles create vs update. Setting `null` when `input.aiFallbackApiKey` is absent would silently clear existing encrypted keys on every config update.
- **Fix:** Used `undefined` in the update block — Prisma `undefined` means "leave field unchanged", which is the correct behavior when no new key is submitted.
- **Files modified:** apps/api/src/modules/chatbot/service.ts
- **Commit:** 36c64da

**2. [Rule 1 - Bug] PATCH /leads-phone passes plaintext from getConfig() back to upsertConfig()**
- **Found during:** Task 2 — reading PATCH route handler carefully
- **Issue:** The PATCH route reads `currentConfig` via `getConfig()` (which after Task 1 decrypts to plaintext), then passes `currentConfig.aiFallbackApiKey` (plaintext) back to `upsertConfig()`. Since `upsertConfig()` now encrypts on write, this flow is correct — plaintext in → encrypted stored in DB. No fix needed; documented for clarity.
- **Resolution:** No code change required — flow is correct by design.

## Known Stubs

None — all functionality is fully implemented. The PATCH route passes plaintext from `getConfig()` to `upsertConfig()`, which re-encrypts it correctly. This round-trip is intentional behavior.

## Threat Flags

None — this plan only hardens an existing column. No new network endpoints, auth paths, or schema changes at trust boundaries introduced.

## Self-Check: PASSED
