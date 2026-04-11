# Phase 1: Security Hardening — Research

**Researched:** 2026-04-10
**Domain:** Node.js / Fastify API security — CORS, auth bypass gates, at-rest encryption, git secret exposure
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEC-01 | CORS configured with explicit allowlist — no `origin: true` | Plan 1.1: replace `origin: true` in `app.ts:191` with env-driven allowlist via `ALLOWED_ORIGINS` Zod var |
| SEC-02 | Auth bypass restricted exclusively to `NODE_ENV=development` | Plan 1.2: condition in `auth.ts:45` already has a partial production guard in `config.ts:63`; bypass must also check `NODE_ENV` at the plugin level |
| SEC-03 | `aiFallbackApiKey` encrypted with the same pattern as `aiApiKeyEncrypted` | Plan 1.3: `encrypt()`/`decrypt()` from `lib/crypto.ts` already used for `aiApiKeyEncrypted`; apply identically to `aiFallbackApiKey` across write, read, and response paths |
| SEC-04 | WhatsApp session files (SQLite/auth state) outside git repository and in `.gitignore` | Plan 1.4: `apps/api/data` already in `.gitignore`; query-string token acceptance needs removal from HTTP paths; `DATA_DIR` startup assertion needed |
</phase_requirements>

---

## Summary

The four security requirements target distinct attack vectors in the API layer. All four are surgical, code-only changes — no new libraries are needed for any of them. The existing codebase already contains the correct foundations: AES-256-GCM encrypt/decrypt in `lib/crypto.ts`, a Zod-based env schema in `config.ts`, Fastify's `@fastify/cors` plugin in `app.ts`, and a partial production auth guard already present in `config.ts`. The gap between current state and required state is consistently a few lines per plan.

The most complex task is Plan 1.3 (`aiFallbackApiKey` encryption), because it has three distinct write sites in `service.ts`, one read site that feeds the fallback AI caller, one GET response site in `routes.ts`, and a one-time data migration to encrypt any existing plaintext rows already in tenant databases. The migration must be idempotent — it must detect whether a value is already ciphertext before re-encrypting.

SEC-02 already has a partial guard: `config.ts:63` throws at startup if `NODE_ENV === 'production'` and `ENABLE_AUTH` is falsy. The gap is `staging`/`preview` environments that set `NODE_ENV` to values other than `production`. The fix adds `NODE_ENV === 'development'` as the sole permitted bypass environment, closing the staging hole.

**Primary recommendation:** Execute plans in order 1.1 → 1.2 → 1.3 → 1.4. No dependencies between them; 1.3 is the most effort.

---

## Standard Stack

### Core (already present — no new installs needed)

| Library | Version (verified) | Purpose | Why Standard |
|---------|-------------------|---------|--------------|
| `@fastify/cors` | 10.x (in use) | CORS enforcement | Official Fastify plugin; `origin` accepts string array, function, or RegExp [VERIFIED: codebase grep] |
| `zod` | 3.x (in use) | Env var schema validation | Already used in `config.ts`; `z.string().min(1)` pattern established [VERIFIED: codebase grep] |
| `node:crypto` | built-in | AES-256-GCM encrypt/decrypt | Already implemented in `lib/crypto.ts`; no extra dependency [VERIFIED: codebase read] |
| `fastify-plugin` | in use | Auth plugin wrapper | Already used in `plugins/auth.ts` [VERIFIED: codebase read] |

### No New Dependencies Required

All four plans are implementable with what is already installed. No `npm install` step is needed for any plan in this phase.

---

## Architecture Patterns

### Pattern 1: CORS Origin Array (SEC-01)

`@fastify/cors` accepts the `origin` option as an array of strings. When a request arrives, it checks `req.headers.origin` against the array. Non-matching origins receive no `Access-Control-Allow-Origin` header, which the browser treats as a rejection.

```typescript
// Source: @fastify/cors README, verified against current usage in app.ts
await app.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()) ?? false,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Api-Key"],
  exposedHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]
});
```

The `?? false` fallback means if the env var is absent the server rejects ALL cross-origin requests — a safe default. `ALLOWED_ORIGINS` must be added to the Zod schema as a required non-defaulting field (or with a development default of `http://localhost:3000`).

**Zod addition for `config.ts`:**
```typescript
ALLOWED_ORIGINS: z.string().min(1).default("http://localhost:3000"),
```

### Pattern 2: Environment-Gated Auth Bypass (SEC-02)

Current condition (`config.ts:63`) only blocks production. The auth plugin check at line 45 reads `!app.config.ENABLE_AUTH` — which is `true` whenever `ENABLE_AUTH` is not `"true"` regardless of NODE_ENV. The fix narrows the bypass:

```typescript
// In plugins/auth.ts — replace line 45
if (!app.config.ENABLE_AUTH && app.config.NODE_ENV === 'development') {
  // bypass...
  return;
}
```

Additionally the startup guard in `config.ts` needs broadening beyond `=== 'production'`:

```typescript
// In config.ts loadConfig() — replace current guard
if (!parsed.ENABLE_AUTH && parsed.NODE_ENV !== 'development') {
  throw new Error(
    "ENABLE_AUTH must be set to true in all non-development environments. " +
    `Current NODE_ENV: ${parsed.NODE_ENV}`
  );
}
```

This means staging, preview, test, and any unknown NODE_ENV values all require auth — only `development` is exempt.

### Pattern 3: At-Rest Encryption for aiFallbackApiKey (SEC-03)

The encrypt/decrypt contract is already established in `lib/crypto.ts`:

```typescript
// Source: apps/api/src/lib/crypto.ts — verified by reading file
encrypt(plaintext: string, key: string): string  // returns "iv.tag.ciphertext"
decrypt(ciphertext: string, key: string): string  // throws on tampered input
```

The same pattern used for `aiApiKeyEncrypted` in `admin/service.ts:487`:

```typescript
// Existing pattern (verified):
input.apiKey && input.apiKey.trim()
  ? encrypt(input.apiKey.trim(), this.config.API_ENCRYPTION_KEY)
  : currentApiKeyEncrypted
```

Apply identically to every write site for `aiFallbackApiKey`. On read, decrypt before passing to fallback caller. In GET responses, return a masked value.

**Masking pattern (consistent with industry standard):**
```typescript
const maskKey = (key: string | null): string | null => {
  if (!key) return null;
  return key.length > 8 ? `${key.slice(0, 4)}...****` : '****';
};
```

**Idempotent migration check:**
```typescript
// Detect if value is already encrypted (iv.tag.ciphertext format)
const isEncrypted = (value: string): boolean =>
  value.split('.').length === 3 && Buffer.from(value.split('.')[0], 'base64').length === 12;
```

### Pattern 4: Query-String Token Removal (SEC-04)

`auth.ts:70-71` falls back from Bearer header to `query?.accessToken` and from `x-api-key` header to `query?.apiKey`. These must be removed from HTTP paths (they land in access logs and reverse proxy logs, leaking credentials). WebSocket upgrade is a legitimate exception because WS clients cannot send custom headers in all browsers.

```typescript
// BEFORE (auth.ts:70-71)
const bearerToken = readBearerToken(authorization) ?? query?.accessToken;
const apiKey = request.headers["x-api-key"]?.toString() ?? query?.apiKey;

// AFTER — remove query fallback for HTTP paths
const bearerToken = readBearerToken(authorization);
const apiKey = request.headers["x-api-key"]?.toString();
```

For WebSocket upgrade endpoints, a separate hook can handle `query.accessToken` explicitly only when `request.headers.upgrade === 'websocket'`.

### Anti-Patterns to Avoid

- **`origin: true` in CORS:** Reflects any origin, defeating the entire purpose. Replace immediately.
- **Relying solely on `NODE_ENV === 'production'` for auth guards:** Staging environments frequently run with `NODE_ENV=staging` or `NODE_ENV=preview` — the guard silently fails.
- **Encrypting an already-encrypted value:** The migration must detect the `iv.tag.ciphertext` format before encrypting. Re-encrypting produces double-wrapped ciphertext that cannot be decrypted with a single `decrypt()` call.
- **Masking before encrypting in GET responses:** The route reads and decrypts to check the value exists, then returns the masked form — never return ciphertext directly to the client.
- **Hardcoded `apps/api/data` in startup assertion:** Use `path.resolve()` to compare absolute paths so symlinks and relative paths don't bypass the check.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CORS origin matching | Custom middleware | `@fastify/cors` `origin` array | Handles preflight, vary headers, credentials correctly [VERIFIED: in use] |
| AES-256-GCM cipher | New crypto module | `lib/crypto.ts` `encrypt()`/`decrypt()` | Already implemented, tested, and used in production paths |
| Env var validation | Manual `process.env` checks | Zod `envSchema` in `config.ts` | Validated at startup, typed, fails fast with clear messages |

---

## Common Pitfalls

### Pitfall 1: ALLOWED_ORIGINS With Trailing Whitespace or Protocol Mismatch
**What goes wrong:** `http://localhost:3000` vs `http://localhost:3000/` or missing protocol causes CORS rejection of legitimate origins.
**Why it happens:** Browser sends exact `Origin` header; Fastify compares string equality.
**How to avoid:** Use `.map(s => s.trim())` and ensure no trailing slashes. Test with `curl -v -H "Origin: http://localhost:3000"`.
**Warning signs:** Panel shows network errors on development while ALLOWED_ORIGINS is set.

### Pitfall 2: NODE_ENV Value in Non-Dev Environments
**What goes wrong:** Railway/Docker sets `NODE_ENV=production` but CI preview sets `NODE_ENV=staging` — auth bypass slips through.
**Why it happens:** The guard only checked `!== 'production'`, leaving any other value ungated.
**How to avoid:** Gate on `=== 'development'`, not `!== 'production'`. Allowlist the permitted bypass value, not blocklist the dangerous one.
**Warning signs:** Staging API responds to requests without an Authorization header.

### Pitfall 3: Double-Encryption in Migration
**What goes wrong:** Running the migration script twice encrypts an already-encrypted ciphertext, producing `encrypt(encrypt(key))`. The subsequent `decrypt()` call returns ciphertext, not the original key.
**Why it happens:** The migration checks for non-null values but not for the ciphertext format.
**How to avoid:** Before encrypting, check `isEncrypted(value)` using the `iv.tag.ciphertext` structure (three base64 segments, first is 12 bytes). Skip rows where this returns true.
**Warning signs:** Fallback AI calls start failing with "invalid key" errors after migration.

### Pitfall 4: aiFallbackApiKey Read Path at Line 2727
**What goes wrong:** After encrypting writes, the caller at `service.ts:2727` receives ciphertext instead of the plaintext API key and passes it directly to the AI provider SDK.
**Why it happens:** The read path (`service.ts:1407`) also needs a `decrypt()` call — not just the write path.
**How to avoid:** Decrypt in `buildRuntimeConfig()` (or equivalent read mapper) so all callers receive plaintext. Never store decrypted value back to DB.
**Warning signs:** Fallback AI calls return 401 from Groq/Gemini after Plan 1.3 is applied.

### Pitfall 5: Query-String Tokens in Access Logs
**What goes wrong:** API keys and access tokens appear in Nginx/Railway access logs and in Fastify's request logger when passed as query params.
**Why it happens:** Logger captures the full URL including query string before auth runs.
**How to avoid:** Remove query-string token acceptance except for WebSocket upgrade. Note that `lib/logger.ts` already redacts `req.headers.authorization` and `req.headers['x-api-key']` — this does NOT cover query params.
**Warning signs:** Reviewing Railway log output shows `?accessToken=eyJ...` in GET request URLs.

### Pitfall 6: DATA_DIR Startup Assertion Path Comparison
**What goes wrong:** `DATA_DIR=./apps/api/data` passes a naive string `startsWith(projectRoot)` check because relative paths resolve differently depending on cwd.
**Why it happens:** String comparison on unresolved paths is unreliable.
**How to avoid:** Use `path.resolve(config.DATA_DIR)` and `path.resolve(process.cwd())` before comparing. Log both resolved paths in the fatal message to aid debugging.
**Warning signs:** Assertion never fires even when DATA_DIR is inside the repo.

---

## Code Examples

### SEC-01: CORS Allowlist

```typescript
// Source: verified against @fastify/cors and apps/api/src/app.ts
await app.register(cors, {
  origin: app.config.ALLOWED_ORIGINS.split(',').map(s => s.trim()),
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Api-Key"],
  exposedHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]
});
```

### SEC-02: Auth Bypass Guard

```typescript
// In plugins/auth.ts — narrowed bypass condition
if (!app.config.ENABLE_AUTH && app.config.NODE_ENV === 'development') {
  // existing bypass block unchanged...
  return;
}

// In config.ts loadConfig() — broadened startup assertion
if (!parsed.ENABLE_AUTH && parsed.NODE_ENV !== 'development') {
  throw new Error(
    `ENABLE_AUTH must be 'true' in non-development environments (NODE_ENV=${parsed.NODE_ENV})`
  );
}
```

### SEC-03: Encrypt on Write, Decrypt on Read

```typescript
// WRITE (service.ts — upsert create/update)
aiFallbackApiKey: input.aiFallbackApiKey?.trim()
  ? encrypt(input.aiFallbackApiKey.trim(), config.API_ENCRYPTION_KEY)
  : existing.aiFallbackApiKey ?? null,

// READ (runtime config builder)
aiFallbackApiKey: record.aiFallbackApiKey
  ? decrypt(record.aiFallbackApiKey, config.API_ENCRYPTION_KEY)
  : null,

// GET RESPONSE (routes.ts)
aiFallbackApiKey: maskKey(currentConfig.aiFallbackApiKey),
```

### SEC-03: Idempotent One-Time Migration

```typescript
// Run once on deployment — safe to run multiple times
const isAlreadyEncrypted = (value: string): boolean => {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    return Buffer.from(parts[0], 'base64').length === 12;
  } catch {
    return false;
  }
};

// For each tenant schema — query rows with non-null aiFallbackApiKey
// If !isAlreadyEncrypted(row.aiFallbackApiKey) → UPDATE with encrypt(value, key)
```

### SEC-04: Startup Path Assertion

```typescript
import { resolve } from 'node:path';

const dataDir = resolve(config.DATA_DIR);
const projectRoot = resolve(process.cwd());

if (dataDir.startsWith(projectRoot)) {
  app.log.fatal(
    { dataDir, projectRoot },
    'DATA_DIR resolves inside the project root — session files would be accessible via git. ' +
    'Set DATA_DIR to an absolute path outside the repository.'
  );
  process.exit(1);
}
```

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|-----------------|--------|
| `origin: true` (reflect all) | Explicit allowlist array | Prevents CSRF from arbitrary origins |
| Auth bypass guarded by `NODE_ENV !== 'production'` | Bypass only when `NODE_ENV === 'development'` | Closes staging/preview hole |
| Plaintext API keys in DB column | AES-256-GCM encrypted at rest | Keys unreadable via SQL/DB dump |
| Query-string token acceptance | Header-only for HTTP; query-string only for WS upgrade | Prevents credential leakage in logs |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | WebSocket upgrade endpoints exist and legitimately need query-string token acceptance | Plan 1.4 scope, SEC-04 | If no WS endpoints need it, remove unconditionally — simpler |
| A2 | `ALLOWED_ORIGINS` with a development default of `http://localhost:3000` is sufficient for local dev | Plan 1.1 | If the panel runs on a different port/origin in dev, developers will hit CORS errors immediately |
| A3 | Existing `aiFallbackApiKey` rows in production tenant databases contain plaintext values, not ciphertext | Plan 1.3 migration | If rows are already encrypted (by some prior attempt), the idempotency check handles it safely |

---

## Open Questions

1. **WebSocket endpoints**
   - What we know: `auth.ts:70` falls back `query.accessToken` for bearer; the plan calls to keep this only for WS upgrade.
   - What's unclear: Whether any current WS clients actually use query-string tokens in practice, or if all use header-based auth.
   - Recommendation: Grep for WebSocket route registrations; if none use query tokens, remove unconditionally.

2. **Staging NODE_ENV value**
   - What we know: Railway sets `NODE_ENV=production` for production deployments.
   - What's unclear: What `NODE_ENV` the staging/preview deployment uses.
   - Recommendation: Check Railway staging environment config; ensure `ENABLE_AUTH=true` is set in the Railway staging service regardless, so the guard is belt-and-suspenders.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 1 is purely code and config changes. No external tools, databases, or services beyond what the existing application already depends on are introduced. No new installs required.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 3.x |
| Config file | `apps/api/vitest.config.ts` |
| Quick run command | `cd apps/api && pnpm test` |
| Full suite command | `cd apps/api && pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| SEC-01 | Cross-origin request from non-allowlisted origin returns no `Access-Control-Allow-Origin` | integration | `cd apps/api && pnpm test -- --reporter=verbose` | ❌ Wave 0 |
| SEC-01 | Cross-origin request from allowlisted origin returns correct `Access-Control-Allow-Origin` | integration | same | ❌ Wave 0 |
| SEC-02 | `loadConfig()` throws if `ENABLE_AUTH` falsy and `NODE_ENV !== 'development'` | unit | `cd apps/api && pnpm test -- --reporter=verbose` | ❌ Wave 0 |
| SEC-02 | Auth plugin bypasses only when `NODE_ENV === 'development'` | unit | same | ❌ Wave 0 |
| SEC-03 | `aiFallbackApiKey` saved as encrypt() output, not plaintext | unit | same | ❌ Wave 0 |
| SEC-03 | GET `/chatbot-config` returns masked key, not plaintext or ciphertext | integration | same | ❌ Wave 0 |
| SEC-03 | Fallback AI caller receives decrypted plaintext key | unit | same | ❌ Wave 0 |
| SEC-04 | Startup assertion exits if `DATA_DIR` resolves inside project root | unit | same | ❌ Wave 0 |
| SEC-04 | Bearer token via query string is rejected on HTTP routes (non-WS) | integration | same | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `cd apps/api && pnpm test`
- **Per wave merge:** `cd apps/api && pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `apps/api/test/security.test.ts` — covers SEC-01 (CORS), SEC-02 (auth bypass), SEC-04 (query-string tokens)
- [ ] `apps/api/test/crypto.test.ts` (or add to existing) — covers SEC-03 (encrypt/decrypt/mask round-trip, idempotency check)
- [ ] No framework install needed — Vitest already installed and configured

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | JWT via `verifyAccessToken`; API key via `sha256` hash lookup |
| V3 Session Management | yes | Tokens via header only (after SEC-04); no query-string sessions |
| V4 Access Control | yes | CORS allowlist (SEC-01); `NODE_ENV`-gated bypass (SEC-02) |
| V5 Input Validation | yes | Zod env schema for `ALLOWED_ORIGINS` |
| V6 Cryptography | yes | AES-256-GCM with random IV and GCM auth tag — `lib/crypto.ts` [VERIFIED: file read] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| CORS wildcard allows CSRF from malicious origin | Spoofing | Explicit `ALLOWED_ORIGINS` allowlist (SEC-01) |
| Auth bypass in staging/preview environments | Elevation of Privilege | `NODE_ENV === 'development'` gate (SEC-02) |
| Plaintext API key in DB readable via SQL dump | Information Disclosure | AES-256-GCM at rest (SEC-03) |
| Bearer token / API key in access logs via query string | Information Disclosure | Header-only for HTTP (SEC-04) |
| Session SQLite files committed to git | Information Disclosure | `apps/api/data` in `.gitignore` (already done); DATA_DIR startup assertion (SEC-04) |

---

## Sources

### Primary (HIGH confidence)

- `apps/api/src/app.ts` lines 189–196 — VERIFIED: current CORS configuration with `origin: true`
- `apps/api/src/plugins/auth.ts` lines 29–67 — VERIFIED: bypass condition, query-string token acceptance
- `apps/api/src/config.ts` lines 1–78 — VERIFIED: Zod env schema, existing production guard
- `apps/api/src/lib/crypto.ts` — VERIFIED: AES-256-GCM encrypt/decrypt implementation
- `apps/api/src/modules/chatbot/service.ts` lines 630–675, 1395–1413, 2710–2730 — VERIFIED: all `aiFallbackApiKey` write, read, and usage sites
- `apps/api/src/modules/chatbot/routes.ts` line 177 — VERIFIED: GET response returning plaintext `aiFallbackApiKey`
- `.gitignore` line 9 — VERIFIED: `apps/api/data` already ignored
- `apps/api/vitest.config.ts` — VERIFIED: Vitest configured with setup file

### Secondary (MEDIUM confidence)

- @fastify/cors documentation — `origin` array option behavior confirmed by reading plugin usage in codebase [ASSUMED from training; behavior is stable and well-documented]

### Tertiary (LOW confidence)

- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; all existing code verified by direct file reads
- Architecture: HIGH — all patterns derived from existing codebase code, not external docs
- Pitfalls: HIGH — derived from reading actual code paths that will be modified
- Test gaps: HIGH — confirmed by listing `apps/api/test/` directory

**Research date:** 2026-04-10
**Valid until:** 2026-07-10 (stable security patterns; Fastify CORS API is stable)
