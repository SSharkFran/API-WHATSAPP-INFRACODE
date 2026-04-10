# Testing Patterns

**Analysis Date:** 2026-04-10

## Test Framework

**Runner:** Vitest 3.x
- Only `@infracode/api` has tests. `@infracode/panel`, `@infracode/worker`, `@infracode/types` all output `echo "No tests"`.
- Config: `apps/api/vitest.config.ts`

**Assertion Library:** Vitest built-in (`expect` from `vitest`)

**Run Commands:**
```bash
pnpm --filter @infracode/api test     # Run all API tests (vitest run)
pnpm test                             # Runs across all packages (only API has real tests)
```

There is no watch mode script defined. No coverage script defined. `vitest run` is the only test invocation.

## Test File Organization

**Location:** Dedicated `test/` directory at `apps/api/test/` — not co-located with source.

**Naming:** `<subject>.test.ts` — no `.spec.ts` files exist in this project.

**Structure:**
```
apps/api/
  test/
    setup.ts                          — Global env var initialization
    app.test.ts                       — Health check smoke test
    host.test.ts                      — Unit test for hostname parsing
    chatbot-simulate.test.ts          — Auth rejection integration test
    knowledge.service.test.ts         — Unit tests for chatbot module-runtime
    agendamento-admin.test.ts         — Unit tests for scheduling module logic
    decrypt-failure-burst.test.ts     — Unit tests for burst detector utility
    multi-tenant.integration.test.ts  — Full integration test (DB-dependent)
  vitest.config.ts
```

## Setup File

`apps/api/test/setup.ts` sets all required environment variables with safe test defaults before any test runs. This allows `buildApp()` to succeed without a real `.env`:

```typescript
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/infracode_whatsapp";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
process.env.ENABLE_AUTH ??= "false";
process.env.GROQ_API_KEY ??= "test-groq-key";
// ... all required config fields
```

Configured in `vitest.config.ts`:
```typescript
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"]
  }
});
```

## Test Structure

**Suite organization:**
```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";

describe("subject description", () => {
  it("does the thing", () => {
    expect(result).toBe(expected);
  });
});
```

**Lifecycle for integration tests:**
```typescript
describe("POST /instances/:id/chatbot/simulate", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("rejeita request sem autenticacao", async () => { ... });
});
```

**Test description language:** Brazilian Portuguese for test descriptions:
- `"bloqueia numero na blacklist"`
- `"nao bloqueia numero fora da blacklist"`
- `"parseia marcador valido"`

## Test Types

**Unit tests (no app bootstrap):**
Tests for pure functions and helper utilities that need no HTTP server or database. Examples:
- `host.test.ts` — tests `resolveTenantSlugFromHostname`
- `knowledge.service.test.ts` — tests `isPhoneBlockedByBlacklist`, `matchesPauseWord`, `sanitizeChatbotModules`
- `agendamento-admin.test.ts` — tests `getAgendamentoAdminModuleConfig`, `buildOperationalModuleInstructions`, and a local regex parser
- `decrypt-failure-burst.test.ts` — tests `createDecryptFailureBurstDetector` with injectable clock

**Integration tests (with app bootstrap, no DB):**
Tests that call `buildApp()` and use `app.inject()` to fire HTTP requests. Auth is disabled in these tests via `ENABLE_AUTH=false` in setup.ts. Queues are replaced with no-op stubs when `NODE_ENV === "test"`. Examples:
- `app.test.ts` — GET /health returns 200
- `chatbot-simulate.test.ts` — verifies 401/403 auth rejection

**Integration tests (with real DB — opt-in only):**
`multi-tenant.integration.test.ts` is skipped by default using:
```typescript
const describeIfDb = process.env.RUN_DB_TESTS === "true" ? describe : describe.skip;
describeIfDb("InfraCode SaaS Multi-tenant", () => { ... });
```
These tests require a running PostgreSQL instance, run Prisma migrations via `execFileSync`, and test full tenant lifecycle scenarios including tenant isolation, impersonation, plan enforcement, and message type acceptance.

## Mocking

**No mocking framework in use.** There are no `vi.mock()`, `vi.fn()`, or `vi.spyOn()` calls found in any test file.

**Test doubles used instead:**
- Injectable dependencies: `createDecryptFailureBurstDetector({ now: () => now })` — clock is injected as a function for time control.
- No-op queues: In `app.ts`, `NODE_ENV === "test"` replaces BullMQ queues with stubs:
  ```typescript
  const createNoopQueue = (): Queue =>
    ({
      add: async () => ({}) as never,
      close: async () => undefined
    }) as unknown as Queue;
  ```
- Auth bypass: `ENABLE_AUTH=false` in setup.ts causes the auth plugin to skip JWT/API-key validation.

## Fixtures and Test Helpers

**No fixture files or factories.** Test data is defined inline.

**DB integration test helpers** are defined as named `const` functions at the bottom of `multi-tenant.integration.test.ts`:
```typescript
const seedPlatformOwner = async (app) => { ... };
const cleanPlatformState = async (app) => { ... };
const loginAdmin = async (app) => { ... };
const createPlan = async (app, accessToken, input) => { ... };
const createTenant = async (app, accessToken, input) => { ... };
const acceptInvitation = async (app, token, name, password) => { ... };
```
These are local to the integration test file and are not shared across tests.

**DB cleanup pattern:** `beforeEach` calls `cleanPlatformState` which does raw schema drops and `deleteMany` for every table, then re-seeds a platform owner, ensuring test isolation.

## HTTP Testing

Fastify's built-in `app.inject()` is used for all HTTP-level tests — no `supertest` in active use (though `supertest` is in `devDependencies`).

```typescript
const response = await app.inject({
  method: "GET",
  url: "/health"
});
expect(response.statusCode).toBe(200);
expect(response.json()).toMatchObject({ status: "ok" });
```

For authenticated requests in DB tests:
```typescript
await app.inject({
  method: "POST",
  url: "/instances",
  headers: {
    authorization: `Bearer ${tenantTokens.accessToken}`
  },
  payload: { name: "Primary WA", autoStart: false }
});
```

## Coverage

**No coverage configuration.** No coverage threshold, no `--coverage` flag in any script.

## CI/CD Testing

No CI configuration files (`.github/workflows/`, `.gitlab-ci.yml`, etc.) were found. There is no automated CI pipeline for tests.

## Async Testing

All async tests use `async/await`. No callback-style or `.then()` chaining in tests.

```typescript
it("returns platform status", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  expect(response.statusCode).toBe(200);
});
```

## Error Scenario Testing

Auth rejection tests check for a set of acceptable status codes rather than a single value, to allow for different auth modes:
```typescript
expect([401, 403]).toContain(response.statusCode);
```

Domain logic tests check return shapes rather than thrown errors:
```typescript
expect(result).toBeNull();
expect(result?.isEnabled).toBe(false);
```

---

*Testing analysis: 2026-04-10*
