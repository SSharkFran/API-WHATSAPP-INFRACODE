# Coding Conventions

**Analysis Date:** 2026-04-10

## Naming Patterns

**Files:**
- `kebab-case` for all TypeScript source files: `module-runtime.ts`, `decrypt-failure-burst.ts`, `redis-rate-limit.ts`
- Service files use the suffix `.service.ts`: `auth/service.ts`, `chatbot/knowledge.service.ts`, `platform/alert.service.ts`
- Route files use the suffix `.routes.ts` or `routes.ts`: `instances/routes.ts`, `chatbot/fiado.routes.ts`
- Schema files use the suffix `.schemas.ts` or `schemas.ts`: `instances/schemas.ts`, `chatbot/schemas.ts`
- Agent files use the suffix `.agent.ts`: `chatbot/agents/conversation.agent.ts`, `chatbot/agents/fiado.agent.ts`
- Plugin files use the suffix `.ts` inside `plugins/`: `plugins/auth.ts`, `plugins/swagger.ts`
- React component files use `PascalCase.tsx`: `instance-grid.tsx` (kebab-case with `.tsx`)
- Next.js pages follow file-system routing: `app/(dashboard)/instances/page.tsx`

**Functions:**
- `camelCase` for all functions: `buildApp`, `loadConfig`, `registerInstanceRoutes`, `createLogger`
- Factory functions prefixed with `create`: `createLogger`, `createRedis`, `createPlatformPrisma`, `createDecryptFailureBurstDetector`
- Registration functions prefixed with `register`: `registerRoutes`, `registerInstanceRoutes`, `registerAuthRoutes`
- Boolean helper functions prefixed with `is` or `has`: `isPhoneBlockedByBlacklist`, `isPhoneAllowedByListaBranca`, `hasRequiredScopes`
- `require*` prefix for guard functions that throw on failure: `requireTenantId`
- `normalize*` prefix for data normalization: `normalizePhoneNumber`, `normalizeError`
- `get*` prefix for configuration accessors: `getAgendamentoAdminModuleConfig`, `getScopesForTenantRole`

**Variables:**
- `camelCase` for all variables and parameters
- Dependency injection objects named `deps` typed as `*Deps` interface: `AuthServiceDeps`, `InstanceOrchestratorDeps`
- Config object consistently named `config` of type `AppConfig`
- Request objects consistently named `request`, reply objects named `reply`

**Types / Interfaces:**
- `PascalCase` for all types and interfaces
- Dependency bags use suffix `Deps`: `AuthServiceDeps`, `InstanceOrchestratorDeps`
- Input shapes use suffix `Input`: `LoginInput`, `AcceptInvitationInput`
- Schema types inferred via `z.infer<typeof schema>`: `export type AppConfig = z.infer<typeof envSchema>`
- Enum-like string unions use `UPPER_SNAKE_CASE` values: `"PLATFORM_OWNER"`, `"CONNECTED"`, `"QR_PENDING"`
- `as const` arrays used to define allowed values with derived types:
  ```typescript
  export const PLATFORM_ROLES = ["PLATFORM_OWNER", "PLATFORM_SUPPORT", ...] as const;
  export type PlatformRole = (typeof PLATFORM_ROLES)[number];
  ```

**Classes:**
- `PascalCase` for class names, always suffixed with their role: `AuthService`, `InstanceOrchestrator`, `TenantPrismaRegistry`, `ApiError`
- Constructor parameter is a single `deps` object: `constructor(deps: AuthServiceDeps)`
- Private members prefixed with `readonly` when invariant: `private readonly config: AppConfig`
- Public constructor explicitly typed: `public constructor(deps: ...)`
- Public methods explicitly typed: `public async login(...)`

## Code Organization Patterns

**Module structure** (inside `apps/api/src/modules/<name>/`):
```
modules/auth/
  routes.ts     — Fastify route registrations
  schemas.ts    — Zod schemas for request/response validation
  service.ts    — Business logic class (PascalCase name ending in Service)
```

**Lib structure** (`apps/api/src/lib/`): Pure utility functions and helpers, no Fastify or module dependencies. Each file has a single clear responsibility: `errors.ts`, `logger.ts`, `authz.ts`, `phone.ts`, etc.

**Plugin structure** (`apps/api/src/plugins/`): Fastify plugins wrapped in `fastify-plugin`. Plugins register hooks (`onRequest`) and decorate the app.

**Service composition**: All services are manually constructed in `app.ts` (composition root) via explicit dependency injection — no DI framework. Services receive all dependencies as a single typed `deps` object.

**React/Next.js panels** (`apps/panel/app/`): Route groups in parentheses `(dashboard)`, `(auth)`, `(super-admin)`. Pages are `page.tsx` files. Shared UI lives in `packages/ui/src/components/`.

## TypeScript Usage Patterns

**Strict mode:** `"strict": true` in `tsconfig.base.json`. All packages inherit from it.

**Module system:** `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`. All imports use `.js` extension even for `.ts` source files:
```typescript
import { buildApp } from "./app.js";
import { ApiError } from "../../lib/errors.js";
```

**Type imports:** `import type` is used consistently for type-only imports:
```typescript
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
```

**Zod for runtime validation:** All external input (HTTP bodies, env vars) is validated via Zod schemas defined in `schemas.ts`. Types are inferred from schemas with `z.infer`.

**No `any`:** The codebase uses `unknown` and type guards rather than `any`. When downcasting is needed, explicit `as` casts with a comment are preferred.

**`satisfies` operator:** Used to type-check without widening:
```typescript
] satisfies Array<Record<string, unknown>>;
```

**Interface for dependency bags:** All service dependencies are described as an interface in the same file:
```typescript
interface AuthServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  emailService: EmailService;
}
```

## Error Handling Approach

**Custom error class:** `ApiError` in `apps/api/src/lib/errors.ts` — extends `Error` with `statusCode`, `publicCode`, and optional `details`.

**Throw early pattern:** Guard functions (`requireTenantId`) throw `ApiError` directly. Services throw `ApiError` for domain errors.

**Centralized normalization:** `normalizeError(error: unknown): ApiError` converts unknown errors to `ApiError`. Used in Fastify's `setErrorHandler`.

**HTTP response shape:** All errors produce:
```json
{ "code": "PUBLIC_ERROR_CODE", "message": "...", "details": {} }
```

**5xx vs 4xx logging:** The error handler logs 5xx errors as `error` level and 4xx as `warn` level.

**No uncaught promise swallowing:** `void bootstrap()` at entry point; errors call `process.exitCode = 1` and `app.close()`.

## Logging Approach

**Library:** `pino` (structured JSON logging), instantiated via `createLogger` in `apps/api/src/lib/logger.ts`.

**Log level:** `"debug"` in development, `"info"` in production.

**Redaction:** Sensitive fields are redacted at logger level:
```typescript
redact: ["req.headers.authorization", "req.headers['x-api-key']", "payload.secret", "payload.apiKey"]
```

**Structured logging:** All log calls use object-first form:
```typescript
app.log.warn({ err: error }, "Falha ao bootstrapar instancias persistidas");
app.log.info({ port: app.config.PORT }, "InfraCode API iniciada");
```

**Request-scoped logger:** Fastify injects `request.log` for per-request context. Used in error handler: `request.log.error.bind(request.log)`.

**Language:** Log messages are in Brazilian Portuguese.

## API Design Conventions

**Framework:** Fastify 5 with `fastify-type-provider-zod`.

**Route definition pattern:**
```typescript
app.get("/instances", {
  config: {
    auth: "tenant",       // "tenant" | "platform" | false
    allowApiKey: true,    // optional
    requiredScopes: ["read"]
  },
  schema: {
    tags: ["Instances"],
    summary: "...",
    body: bodySchema,    // Zod schema
    response: { 200: responseSchema }
  }
}, async (request) => { ... });
```

**Auth config on routes:** Every route declares `config.auth` (`false`, `"tenant"`, `"platform"`). API key auth is opt-in via `allowApiKey: true` and `requiredScopes`.

**REST naming:**
- Resource collections: `/instances`, `/admin/tenants`, `/admin/plans`
- Resource items: `/instances/:id`
- Actions on resources: `/instances/:id/messages/send`, `/instances/:id/chatbot/simulate`
- Tenant-scoped: `/tenant/dashboard`, `/tenant/api-keys`
- Admin-scoped: `/admin/tenants`, `/admin/impersonation/:tenantId`

**Response shape:** Successful responses return a plain JSON object or array. No envelope wrapper (no `{ data: ... }`).

**Auth tokens:**
- JWT via `Authorization: Bearer <token>` header or `?accessToken=` query param
- API keys via `X-Api-Key` header or `?apiKey=` query param

## Import/Export Patterns

**Import order (observed):**
1. Node built-in modules (`node:crypto`, `node:fs/promises`)
2. Third-party packages (`fastify`, `zod`, `pino`, `ioredis`)
3. Internal workspace packages (`@infracode/types`)
4. Local absolute-style imports (from `../../lib/...`, `../chatbot/...`)

**Exports:** Named exports throughout. No default exports in service/lib files. React components use named exports. Next.js pages use default exports (`export default function Page()`).

**Barrel files:** `routes/index.ts` re-exports all route registrations. No barrel `index.ts` in lib or modules (direct imports).

**`.js` extension:** All relative imports end in `.js` (required by NodeNext module resolution):
```typescript
import { ApiError } from "../../lib/errors.js";
```

## Comments / Documentation

**JSDoc-style comments on exports:** Public functions and classes have a single-line JSDoc comment in Portuguese describing their purpose:
```typescript
/**
 * Converte erros desconhecidos para um formato consistente de resposta HTTP.
 */
export const normalizeError = ...
```

**No inline comments for obvious logic.** Comments appear on non-obvious decisions.

**Language:** All code comments are in Brazilian Portuguese.

## Module Design

**Services as classes:** Business logic is always in a class (`AuthService`, `InstanceOrchestrator`). Helper utilities are plain exported functions.

**No singleton pattern:** Services are instantiated once in `app.ts` and passed as dependencies.

**Circular dependency handling:** Services that need each other use setter injection (`chatbotService.setPlatformAlertService(platformAlertService)`).

---

*Convention analysis: 2026-04-10*
