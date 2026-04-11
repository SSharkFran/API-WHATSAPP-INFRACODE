---
phase: 01-security-hardening
reviewed: 2026-04-10T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - apps/api/src/app.ts
  - apps/api/src/config.ts
  - apps/api/src/lib/migrate-fallback-key.ts
  - apps/api/src/modules/chatbot/routes.ts
  - apps/api/src/modules/chatbot/service.ts
  - apps/api/src/plugins/auth.ts
  - apps/api/test/security.test.ts
  - apps/api/test/setup.ts
findings:
  critical: 3
  warning: 5
  info: 4
  total: 12
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-04-10T00:00:00Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

This review covers the core security-hardening layer of the API: app bootstrap, config validation, the auth plugin, chatbot routes and service, the fallback-key migration script, and the accompanying test suite.

The code demonstrates strong security awareness in several areas: CORS is allowlist-driven, Helmet and HSTS are configured, rate limiting is applied globally with a per-tenant overlay, bearer tokens are accepted from query strings only for WebSocket upgrades, `aiFallbackApiKey` values are encrypted at rest, and `DATA_DIR` is validated against the project root at startup. These are all genuine improvements.

Three critical issues remain:

1. `mapConfig` (service.ts) decrypts `aiFallbackApiKey` and returns the **plaintext** key inside the `ChatbotConfig` struct. Routes then mask it before sending it to the client, but the plaintext value lives in memory and is also logged in two `console.log` debug lines in `processLeadAfterConversation`. The masked value — not the decrypted one — should be stored in the config DTO.
2. The `schema` parameter in `migrate-fallback-key.ts` is interpolated directly into a raw SQL string without any sanitisation, creating a SQL injection vector in the migration tool.
3. `JWT_SECRET` has a minimum length of only 8 characters in config validation, which is far too weak for HMAC-SHA256 signing and is inconsistent with `WEBHOOK_HMAC_SECRET` (min 16) and `API_ENCRYPTION_KEY` (min 32).

---

## Critical Issues

### CR-01: `mapConfig` decrypts `aiFallbackApiKey` into the DTO — plaintext key leaks through the config object

**File:** `apps/api/src/modules/chatbot/service.ts:1416-1418`

**Issue:** `mapConfig` calls `decrypt(record.aiFallbackApiKey, ...)` and stores the result directly in the returned `ChatbotConfig` object under `aiFallbackApiKey`. This means every call to `getConfig`, `upsertConfig`, or `getContext` yields a config struct that holds the decrypted key in memory. Routes apply `maskKey` before the HTTP response, which is correct — but `processLeadAfterConversation` passes this same config (with `__tenantId` injected) straight into `extractLeadWithAi`, and two `console.log` calls at lines ~1713 and ~1772 log `chatbotConfig` or derived objects without any scrubbing. Any future logging middleware or crash reporter that serialises the config object will leak the key.

The config DTO (`ChatbotConfig`) is also the public type exported to consumers via `@infracode/types` — having the plaintext key there is structurally wrong.

**Fix:** Keep the encrypted value (or the masked version) in the DTO and decrypt on-demand, close to the call site that needs it:

```typescript
// In mapConfig — store masked value, never plaintext
aiFallbackApiKey: record.aiFallbackApiKey
  ? ChatbotService.maskKey(record.aiFallbackApiKey)  // already encrypted; mask for display
  : null,

// Where the plaintext key is actually needed (e.g. evaluateWithAi / formulateAdminAnswer)
// read directly from the DB record or pass the encrypted value separately:
private async getDecryptedFallbackApiKey(tenantId: string, instanceId: string): Promise<string | null> {
  const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
  const record = await prisma.chatbotConfig.findUnique({
    where: { instanceId },
    select: { aiFallbackApiKey: true }
  });
  return record?.aiFallbackApiKey
    ? decrypt(record.aiFallbackApiKey, this.config.API_ENCRYPTION_KEY)
    : null;
}
```

Alternatively, introduce a parallel internal type that carries `aiFallbackApiKeyEncrypted` and only expose the masked string in the public `ChatbotConfig`.

---

### CR-02: SQL injection via unvalidated `schema` parameter in migration script

**File:** `apps/api/src/lib/migrate-fallback-key.ts:41,52`

**Issue:** The `schema` argument is interpolated directly into two `$queryRawUnsafe` / `$executeRawUnsafe` calls:

```typescript
`SELECT id, "aiFallbackApiKey" FROM ${schema}."ChatbotConfig" WHERE ...`
`UPDATE ${schema}."ChatbotConfig" SET ...`
```

The `schema` parameter has no validation. A caller passing `schema = 'public"; DROP TABLE "ChatbotConfig"; --'` would execute arbitrary SQL. Even in a migration tool that is "only run by admins", this is a textbook injection vulnerability and sets a dangerous precedent.

**Fix:** Validate the schema name against a strict allowlist pattern before interpolation:

```typescript
const SAFE_SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

export async function migrateFallbackApiKeys(
  prisma: PrismaClient,
  encryptionKey: string,
  schema: string = 'public'
): Promise<{ updated: number; skipped: number; errors: number }> {
  if (!SAFE_SCHEMA_RE.test(schema)) {
    throw new Error(`Invalid schema name: "${schema}". Must match /^[a-z_][a-z0-9_]{0,62}$/i`);
  }
  // ... rest of function
}
```

PostgreSQL identifier quoting with `"` prevents most injections once the regex guards the allowed character set.

---

### CR-03: `JWT_SECRET` minimum length (8 chars) is dangerously weak

**File:** `apps/api/src/config.ts:32`

**Issue:**

```typescript
JWT_SECRET: z.string().min(8),
```

An 8-character secret allows brute-force offline attacks against HS256 JWTs in minutes using tools like `hashcat`. NIST SP 800-107 and the jose library documentation both recommend at least 256 bits (32 bytes) of entropy for HMAC-SHA256. The same file sets `WEBHOOK_HMAC_SECRET` to `min(16)` and `API_ENCRYPTION_KEY` to `min(32)` — the JWT secret is inconsistent and the weakest link.

The test setup (`apps/api/test/setup.ts:14`) uses `"change-me"` (8 chars) which would pass this validation in production if someone copied the test env without changing it.

**Fix:**

```typescript
JWT_SECRET: z.string().min(32, "JWT_SECRET deve ter no minimo 32 caracteres para seguranca HMAC-SHA256"),
```

Also update `test/setup.ts` to use a 32-character test secret:

```typescript
process.env.JWT_SECRET ??= "change-me-change-me-change-me-32";
```

---

## Warnings

### WR-01: `aiFallbackApiKey` is passed through in `patch /chatbot/leads-phone` without re-encryption guard

**File:** `apps/api/src/modules/chatbot/routes.ts:183`

**Issue:** The `PATCH /instances/:id/chatbot/leads-phone` handler reads `currentConfig.aiFallbackApiKey` and passes it verbatim to `upsertConfig`. At line 645 of `service.ts`, `upsertConfig` wraps any non-empty `aiFallbackApiKey` with `encrypt(...)`. If `mapConfig` (CR-01 above) is fixed to return the already-encrypted value, this round-trip would double-encrypt the key. If it currently returns plaintext (the bug in CR-01), this round-trip would encrypt plaintext correctly — but the two paths are tightly coupled and break differently depending on whether CR-01 is fixed.

**Fix:** After fixing CR-01, this route must either:
a) Exclude `aiFallbackApiKey` from the round-trip (pass `undefined` to signal "no change"), or
b) Accept only the raw plaintext from the HTTP body (never from the config read-back).

The safest option is to add an `aiFallbackApiKey?: string | null` field to `upsertLeadsPhoneBodySchema` and let the client send it explicitly, defaulting to `undefined` (no-op) when absent:

```typescript
// In upsertConfig update block:
aiFallbackApiKey: input.aiFallbackApiKey?.trim()
  ? encrypt(input.aiFallbackApiKey.trim(), this.config.API_ENCRYPTION_KEY)
  : input.aiFallbackApiKey === null
    ? null          // explicit clear
    : undefined,    // no-op (Prisma ignores undefined in update)
```

---

### WR-02: `triggerKnowledgeSynthesis` has no timeout on the `fetch` call

**File:** `apps/api/src/modules/chatbot/service.ts:424`

**Issue:** The `fetch` call to the AI provider in `triggerKnowledgeSynthesis` has no `AbortSignal.timeout`. If the provider is slow or hangs, this async operation will never resolve. It is called via `void ... .catch(() => null)` in routes, so it won't crash the request, but it will keep a dangling promise alive indefinitely, which accumulates open TCP connections and memory pressure.

Compare with `synthesizeKnowledgeEntry` at line 499, which correctly applies `AbortSignal.timeout(15_000)`.

**Fix:**

```typescript
const response = await fetch(`${managedAiProvider.baseUrl}/chat/completions`, {
  method: "POST",
  signal: AbortSignal.timeout(30_000),  // add timeout
  headers: { ... },
  body: JSON.stringify({ ... })
});
```

---

### WR-03: `generateAprendizadoContinuoVerificationCode` uses `Math.random()` (not cryptographically secure)

**File:** `apps/api/src/modules/chatbot/service.ts:182`

**Issue:**

```typescript
const generateAprendizadoContinuoVerificationCode = (): string =>
  String(Math.floor(100000 + Math.random() * 900000));
```

`Math.random()` is not a cryptographically secure PRNG. For a 6-digit verification code sent to an admin's WhatsApp, this is exploitable: the V8 PRNG state can be recovered from a handful of observed outputs, allowing an attacker to predict future codes. Node.js provides `crypto.randomInt` for this purpose.

**Fix:**

```typescript
import { randomInt } from "node:crypto";

const generateAprendizadoContinuoVerificationCode = (): string =>
  String(randomInt(100000, 1000000));  // cryptographically secure, returns [100000, 999999]
```

---

### WR-04: WebSocket `accessToken` query parameter is accepted for HTTP non-upgrade requests when auth plugin reads `query`

**File:** `apps/api/src/plugins/auth.ts:71`

**Issue:** The auth plugin conditionally reads `accessToken` from the query string only for WebSocket upgrades:

```typescript
const bearerToken = readBearerToken(authorization) ?? (isWebSocketUpgrade ? query?.accessToken : undefined);
```

This is correct. However, `query` is read from `request.query` without any type-narrowing for the HTTP case — the raw query object is always parsed. More importantly, the security test at `test/security.test.ts:120` verifies that `?accessToken=` on a regular HTTP endpoint returns 401, but the test hits `/debug/group-jids` which may not exist (no route definition seen in reviewed files). If that route returns 404 before the auth hook runs, the test passes vacuously — it is not actually testing the auth plugin's behaviour.

**Fix:** Add the test against a route that definitely exists and reaches the auth hook before returning (e.g. `/health` if it has `auth` enabled, or any authenticated route):

```typescript
it("HTTP request with ?accessToken= query param is rejected with 401", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/instances?accessToken=fake-token-12345",  // known authenticated route
  });
  // Should be 401 UNAUTHENTICATED, not 404
  expect(response.statusCode).toBe(401);
});
```

---

### WR-05: `processLeadAfterConversation` logs raw phone numbers and conversation data at INFO level

**File:** `apps/api/src/modules/chatbot/service.ts:1713,1756,1772,1797-1799`

**Issue:** Multiple `console.log` calls in `processLeadAfterConversation` emit PII to stdout:

```typescript
console.log("[lead:phone] raw phoneNumber received:", JSON.stringify(phoneNumber));
console.log("[lead:phone] cleanPhone:", cleanPhone);
console.log("[lead] dados extraídos:", JSON.stringify(extracted));
console.log("[lead] tentando enviar para:", alertPhone);
```

`extracted` includes `nome`, `contato` (full phone number), and `endereco`. In a structured-logging setup, these payloads would be forwarded to log aggregation tools (Datadog, Loki, etc.) with no TTL guarantees and potentially without access controls matching those on the database.

**Fix:** Replace with structured warn/debug-level logs that omit or hash PII:

```typescript
logger.debug({ conversationId, instanceId: conversation.instanceId }, "[lead] processamento iniciado");
logger.debug({ leadSent: extracted !== null }, "[lead] extracao concluida");
```

At a minimum, remove the `JSON.stringify(extracted)` call that dumps the full lead payload including `nome` and `endereco`.

---

## Info

### IN-01: `GROQ_API_KEY` is required even when a managed AI provider (GROQ/OPENAI_COMPATIBLE) is configured per-tenant

**File:** `apps/api/src/config.ts:50`

**Issue:**

```typescript
GROQ_API_KEY: z.string().min(1),
```

This field is required at startup for all deployments, even tenants that configure their own AI provider via `TenantAiProvider` and do not use the platform-managed GROQ key. This forces operators to supply a dummy value in non-GROQ deployments and makes the config misleading.

**Fix:** Make `GROQ_API_KEY` optional (`z.string().optional()`) and guard the `GroqKeyRotator` constructor to handle an empty pool:

```typescript
GROQ_API_KEY: z.string().min(1).optional(),
```

---

### IN-02: Commented-out audit body in `recordPlatformAuditLog` call passes raw `body` including sensitive fields

**File:** `apps/api/src/modules/chatbot/routes.ts:77-78`

**Issue:** The `upsertConfig` handler passes the raw `body` to both `recordPlatformAuditLog` and `recordTenantAuditLog`. The `body` may contain `aiFallbackApiKey` if the client sends it (schema allows it via `upsertChatbotBodySchema`). This would store the raw key value in the audit log tables.

**Fix:** Strip sensitive fields before logging:

```typescript
const auditBody = { ...body, aiFallbackApiKey: body.aiFallbackApiKey ? '****' : null };
await recordPlatformAuditLog(app.platformPrisma, request, "chatbot.upsert", "Instance", params.id, auditBody, app.config.JWT_SECRET);
```

---

### IN-03: `JWT_SECRET` is used as a parameter to `recordAuditLog` — its purpose there is unclear

**File:** `apps/api/src/modules/chatbot/routes.ts:77`

**Issue:** `app.config.JWT_SECRET` is passed as the last argument to both `recordPlatformAuditLog` and `recordTenantAuditLog` across multiple route handlers. Without reading the audit log implementation, this suggests the JWT secret is being used to sign or HMAC audit entries. Passing the JWT signing secret to a general-purpose audit log function creates coupling and expands the attack surface — a bug in the audit log function could expose the key. A dedicated `AUDIT_HMAC_SECRET` would be more appropriate.

**Fix:** Use a separate secret for audit log signing, or document clearly in the function signature why `JWT_SECRET` is appropriate.

---

### IN-04: `console.log` at service startup leaks GROQ key pool size and indirectly confirms key presence

**File:** `apps/api/src/modules/chatbot/service.ts:323`

**Issue:**

```typescript
console.log(`[groq-rotator] inicializado com ${this.groqKeyRotator.size} chave(s)`);
```

While not a direct key leak, startup logs should avoid advertising the number of API keys in the pool to anyone with log access. Use the structured logger instead, at debug level.

**Fix:**

```typescript
// Use structured logger, not console.log — pass to app logger or remove entirely
```

---

_Reviewed: 2026-04-10T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
