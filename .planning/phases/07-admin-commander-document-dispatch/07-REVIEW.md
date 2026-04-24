---
phase: 07-admin-commander-document-dispatch
reviewed: 2026-04-23T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - apps/api/src/lib/run-migrations.ts
  - apps/api/src/modules/instances/__tests__/admin-action-log.service.spec.ts
  - apps/api/src/modules/instances/__tests__/admin-command.handler.spec.ts
  - apps/api/src/modules/instances/__tests__/document-dispatch.service.spec.ts
  - apps/api/src/modules/instances/__tests__/status-query.service.spec.ts
  - apps/api/src/modules/instances/admin-action-log.service.ts
  - apps/api/src/modules/instances/admin-command.handler.ts
  - apps/api/src/modules/instances/document-dispatch.service.ts
  - apps/api/src/modules/instances/service.ts
  - apps/api/src/modules/instances/status-query.service.ts
  - apps/api/src/modules/tenant/routes.ts
  - apps/panel/app/(tenant)/tenant/historico-acoes/page.tsx
  - apps/panel/lib/api.ts
findings:
  critical: 2
  warning: 5
  info: 4
  total: 11
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-04-23T00:00:00Z
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Phase 7 introduces the Admin Commander (WhatsApp command routing), Document Dispatch (PDF delivery
to clients), AdminActionLog (audit trail), and StatusQueryService. The architecture is sound:
dependency-injection throughout, non-blocking audit writes via `setImmediate`, and schema-qualified
raw SQL. However two critical issues need to be addressed before shipping: SQL injection in the
`AdminActionLog` INSERT caused by directly interpolating the schema name into a template literal
without quoting, and an unvalidated `limit` query parameter on the action-history endpoint that
allows raw user input into a SQL LIMIT clause. Five warnings cover a double-resolve race condition in
`writeLog`, a missing `createdAt` type assertion in the panel component, an always-emitted
`admin.command` event regardless of message content, inconsistent logger usage, and the stub wiring
in `handleEncerrarCommand`. Four info-level items cover dead code, magic numbers, and test
scaffolding notes.

---

## Critical Issues

### CR-01: SQL injection — unquoted schema interpolation in AdminActionLogService.insertRow

**File:** `apps/api/src/modules/instances/admin-action-log.service.ts:70`

**Issue:** Both `insertRow` (line 70) and `insertEntry` (line 99) build the table reference by
interpolating `schema` directly into a template literal:

```ts
`INSERT INTO "${schema}"."AdminActionLog" ...`
```

`schema` is constructed as `` `tenant_${tenantId.replaceAll(/[^a-zA-Z0-9_]/g, '_')}` `` (line 67),
which strips most special characters, but the surrounding double-quote is still present in the
template string. If `tenantId` is `" OR 1=1--` the sanitized schema becomes `tenant___OR_1_1__` —
acceptable — but the sanitization is applied *inline* and is not the same hardened function used in
`run-migrations.ts` (`quoteSchema` + regex guard). A discrepancy in sanitization logic between
`AdminActionLogService` and `runMigrations` means they can diverge if one is updated without the
other.

The more dangerous gap is that `getTenantDb` in `DocumentDispatchService.dispatch` (line 54) calls:

```ts
db.$queryRawUnsafe<ContactRow>(
  `SELECT ... FROM "Contact" WHERE LOWER("displayName") LIKE LOWER($1) LIMIT 6`,
  `%${clientName}%`
)
```

`clientName` is passed as a parameterised `$1` — that is safe. But the `Contact` table reference
has **no schema prefix** at all, meaning the query runs in whatever the connection's `search_path`
is. If `search_path` is not set to the tenant schema before this call, the query will silently read
from a different tenant's `Contact` table (cross-tenant data leak).

**Fix — unify schema quoting:**

```ts
// Shared utility (already exists in run-migrations.ts — extract to lib/tenant-schema.ts)
const quoteSchema = (s: string) => `"${s}"`;

// In insertRow / insertEntry:
const schema = quoteSchema(`tenant_${tenantId.replaceAll(/[^a-zA-Z0-9_]/g, '_')}`);

// In DocumentDispatchService.dispatch — prefix Contact with schema:
const schema = resolveTenantSchemaName(tenantId); // already in lib/tenant-schema.ts
const contacts = await db.$queryRawUnsafe<ContactRow>(
  `SELECT id, "displayName", "phoneNumber", "rawJid"
   FROM ${schema}."Contact"
   WHERE LOWER("displayName") LIKE LOWER($1)
   LIMIT 6`,
  `%${clientName}%`
);
```

---

### CR-02: Unvalidated user-controlled integer passed into raw SQL LIMIT in routes.ts

**File:** `apps/api/src/modules/tenant/routes.ts:81`

**Issue:** The `limit` value from the query string is read directly and passed into `$queryRawUnsafe`
without numeric validation:

```ts
const { limit = 100 } = request.query as { limit?: number };
// ...
const rows = await db.$queryRawUnsafe<AdminActionLogEntry[]>(
  `SELECT ... LIMIT $1`,
  limit
);
```

Fastify coerces `limit` to an integer (schema declares `type: "integer"`) but the schema also sets
`maximum: 500` — however the Fastify schema is in the `querystring` field as a plain JSON Schema
object, **not** as a Zod schema, so it is not validated by a Zod pre-parse like other routes in
this file. If the schema validation middleware is not applied globally, a caller can pass
`limit=999999999` and cause an unnecessarily expensive query, or a negative value leading to a
database error that leaks internal SQL in the error response.

**Fix:**

```ts
const rawLimit = (request.query as { limit?: unknown }).limit;
const limit = Math.min(Math.max(1, Number(rawLimit) || 100), 500);
```

Or add Zod parsing consistent with the rest of the file:

```ts
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const { limit } = querySchema.parse(request.query);
```

---

## Warnings

### WR-01: Double-resolve race condition in AdminActionLogService.writeLog

**File:** `apps/api/src/modules/instances/admin-action-log.service.ts:51-61`

**Issue:** The `writeLog` method resolves the outer Promise twice: once immediately at line 60
(`resolve()` after the `setImmediate` registration) and once again inside the `setImmediate`
callback via `.finally(() => resolve())` (line 57). Calling `resolve` on an already-resolved
Promise is a no-op in V8, so this does not currently cause a runtime bug, but it:

1. Makes the intent confusing — the JSDoc comment says "resolve immediately so caller is not
   blocked" but the `.finally(() => resolve())` implies it should also resolve after the DB write.
2. The test at line 89–92 in `admin-action-log.service.spec.ts` verifies that the DB call has NOT
   happened when `await callPromise` returns — which works only because the outer `resolve()` fires
   first. If a future maintainer removes the outer `resolve()`, the test would hang until
   `flushSetImmediate()`, silently changing observable behaviour.

**Fix:** Remove the `.finally(() => resolve())` inside the `setImmediate` callback to make the
intent unambiguous:

```ts
writeLog(opts: WriteLogOptions): Promise<void> {
  setImmediate(() => {
    void this.insertRow(opts).catch((err) =>
      this.logger.warn({ err, tenantId: opts.tenantId, command: opts.command },
        '[AdminActionLogService] write failed')
    );
  });
  return Promise.resolve(); // non-blocking — always resolves immediately
}
```

---

### WR-02: admin.command event emitted for every admin message regardless of content type

**File:** `apps/api/src/modules/instances/service.ts:2477-2485`

**Issue:** The `admin.command` event is emitted unconditionally whenever `isAdminOrInstanceSender`
is true, including for image, audio, video, and sticker messages where `rawTextInput` is `null` or
`undefined`. This means `AdminCommandHandler.handle` receives an event with
`event.command = null/undefined`, which it normalises with `(event.command ?? '').trim()` — leading
to a no-op fall-through to `adminCommandService.handleCommand` with an empty string on every
non-text admin message.

```ts
// service.ts line 2482 — command can be null for media messages
command: rawTextInput,
```

**Fix:** Guard the emit with a truthiness check:

```ts
if (isAdminOrInstanceSender && rawTextInput) {
  this.eventBus.emit('admin.command', {
    type: 'admin.command',
    tenantId,
    instanceId: instance.id,
    command: rawTextInput,
    fromJid: event.remoteJid,
  });
}
```

---

### WR-03: handleEncerrarCommand sends a placeholder message but always logs deliveryStatus 'pending'

**File:** `apps/api/src/modules/instances/admin-command.handler.ts:156-171`

**Issue:** `handleEncerrarCommand` sends a message to the admin (the `sendResponse` call does
succeed), but the audit log entry is written with `deliveryStatus: 'pending'`. If this is the final
state of the log record and the session-close flow is never wired, the action history panel will
permanently show `Pendente` for every `/encerrar` command, misleading operators.

Additionally, the response message contains an untranslated technical note
`(verificar contato no CRM)` that is likely not intended for the end-user UI.

**Fix:** Either update `deliveryStatus` to `'sent'` (since the response is delivered to the admin),
or document via a TODO that this must be updated when Phase 8 wires the session close:

```ts
this.deps.actionLog.write(event.tenantId, {
  triggeredByJid: event.fromJid,
  actionType: 'session_close',
  messageText: clientName,
  deliveryStatus: 'sent', // admin was notified; session-close wiring is Phase 8
});
```

---

### WR-04: getTenantDb in DocumentDispatchService is synchronous but typed as returning a potentially async client

**File:** `apps/api/src/modules/instances/document-dispatch.service.ts:53`

**Issue:** `DocumentDispatchDeps.getTenantDb` is typed as returning a synchronous object
(`getTenantDb: (tenantId: string) => { $queryRawUnsafe: ... }`), but in `service.ts` it is wired as:

```ts
getTenantDb: (tid) => this.tenantPrismaRegistry.getClient(tid) as never,
```

`tenantPrismaRegistry.getClient()` returns a `Promise<PrismaClient>`, not a bare client. The `as
never` suppresses the TypeScript error but means the actual `db` received in `dispatch()` is a
`Promise` object, not a Prisma client. Calling `db.$queryRawUnsafe(...)` on a Promise will throw
`TypeError: db.$queryRawUnsafe is not a function` at runtime.

**Fix:** Change the dep type and usage to async:

```ts
// In DocumentDispatchDeps:
getTenantDb: (tenantId: string) => Promise<{ $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T[]> }>;

// In dispatch():
const db = await this.deps.getTenantDb(tenantId);
```

And update the wiring in `service.ts`:

```ts
getTenantDb: (tid) => this.tenantPrismaRegistry.getClient(tid),
```

---

### WR-05: console used as logger in service.ts instead of the injected pino logger

**File:** `apps/api/src/modules/instances/service.ts:313,325,332`

**Issue:** All three Phase 7 services are instantiated with `console as never` for the `logger`
dependency:

```ts
const documentDispatchService = new DocumentDispatchService({
  logger: console as never,
  ...
});
const adminActionLogService = new AdminActionLogService({
  logger: console as never,
  ...
});
const statusQueryService = new StatusQueryService({
  logger: console as never,
  ...
});
```

`console` does not produce structured JSON logs. In production this means Phase 7 log events are
unstructured, unindexed, and will not be captured by log aggregation. The `InstanceOrchestrator`
already has a `pino` logger available (used throughout `service.ts`); it should be passed here.

**Fix:**

```ts
const documentDispatchService = new DocumentDispatchService({
  logger: this.logger.child({ component: 'DocumentDispatchService' }),
  ...
});
```

(Apply the same pattern for `AdminActionLogService` and `StatusQueryService`.)

---

## Info

### IN-01: Dead local variable `text` in handleDocumentCommand

**File:** `apps/api/src/modules/instances/admin-command.handler.ts:140`

**Issue:** `handleDocumentCommand` re-derives `text` from `event.command` at line 140, but
`documentType` and `clientName` are already extracted by the caller (`handle`). The variable is only
used to populate `messageText` in the audit log entry. This is functionally equivalent to using
`event.command` directly.

```ts
// Line 140 — redundant
const text = (event.command ?? '').trim();
```

**Fix:** Remove the local variable and use `event.command ?? ''` inline in the log entry, or just
pass the already-trimmed `text` from `handle()` down as a parameter.

---

### IN-02: Magic number 5_242_880 duplicated between service and test

**File:** `apps/api/src/modules/instances/document-dispatch.service.ts:7` and
`apps/api/src/modules/instances/__tests__/document-dispatch.service.spec.ts:116`

**Issue:** `MAX_DOC_BYTES` is defined as `5 * 1024 * 1024` in the service (exported only as a
`const`), but the test hardcodes `6_000_000` (which is actually larger than 5 MiB = 5_242_880).
There is a subtle discrepancy: `5 MB` (5,000,000 bytes) vs `5 MiB` (5,242,880 bytes). The
user-facing error message says "5 MB" but the constant is 5 MiB, which could cause confusion.

**Fix:** Export `MAX_DOC_BYTES` from the service and import it in the test:

```ts
// document-dispatch.service.ts
export const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5 MiB

// test:
import { MAX_DOC_BYTES } from '../document-dispatch.service.js';
vi.mocked(stat).mockResolvedValue({ size: MAX_DOC_BYTES + 1 } as never);
```

Also consider aligning the user-facing message to say "5 MiB" or changing the constant to
`5_000_000` so it matches "5 MB".

---

### IN-03: AdminPlanSummary interface declared after its usage in api.ts

**File:** `apps/panel/lib/api.ts:557`

**Issue:** `AdminPlanSummary` is declared at line 557 but first used at lines 324 and 523 (in
`mockPlans` and `getAdminPlans`). TypeScript hoists interface declarations so this compiles, but the
convention in this file is to declare all interfaces before use. It is also referenced at line 324
in `mockPlans` which is in the middle of the file — the interface should be moved to the top with
the other exported interfaces.

**Fix:** Move the `AdminPlanSummary` interface definition to the interface block (around line 85),
alongside the other exported API types.

---

### IN-04: Test file for admin-command.handler relies entirely on a hand-rolled mock class

**File:** `apps/api/src/modules/instances/__tests__/admin-command.handler.spec.ts:11-52`

**Issue:** The `vi.mock` block for `../admin-command.handler.js` reimplements the routing logic in
the mock itself. This means the tests are testing the mock, not the real `AdminCommandHandler`.
Tests 1–7 exercise the mock's routing implementation rather than the production class. When
`AdminCommandHandler` is updated, these tests will not catch regressions unless the mock is also
updated.

This is a test-quality concern, not a runtime bug, but it significantly reduces the protection the
test suite offers. The comment at the top ("module is mocked to avoid 'Cannot find module' errors")
suggests the real class existed at test-write time — the mock should be removed and the real
implementation imported directly, following the pattern used in `document-dispatch.service.spec.ts`
and `admin-action-log.service.spec.ts`.

**Fix:** Remove the `vi.mock` block for `admin-command.handler.js` and instantiate the real
`AdminCommandHandler` with stub dependencies, as the other spec files do.

---

_Reviewed: 2026-04-23T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
