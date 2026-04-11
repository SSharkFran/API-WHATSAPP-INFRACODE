# Phase 2: CRM Identity & Data Integrity — Research

**Researched:** 2026-04-11
**Domain:** WhatsApp LID/JID identity resolution, CRM data integrity, tenant schema migrations, BullMQ job patterns
**Confidence:** HIGH (all findings from direct codebase inspection)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **LID Fallback UX:** When `phoneNumber` is null, show "Aguardando número" (not "Contato desconhecido", which is for permanently unresolvable contacts).
- **`formatPhone()` Scope:** pt-BR only (`+55` → formatted). All other country codes → E.164 as-is. Garbage → "Contato desconhecido". No external i18n library (dependency-free).
- **Reconciliation Job Cadence:** Event-driven on `connection.update: open`. No periodic polling. BullMQ job ID `lid-reconcile:{instanceId}` for deduplication. Max 3 retries per contact per connection event.
- **Tenant Migration Failure Strategy:** Log error, skip failing tenant, continue API startup. Structured error log `{ tenantId, migration, error }` at Pino error level. Startup summary log listing all tenants with status.

### Claude's Discretion

_(None surfaced during discussion.)_

### Deferred Ideas (OUT OF SCOPE)

_(None surfaced during discussion.)_
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CRM-01 | LID/JID normalized at ingestion — real number stored from the start, never internal code | Plan 2.1: `persistLidPhoneMapping` already maps LID→real JID reactively; needs proactive E.164 storage at `upsert` + `rawJid` field + BullMQ reconciliation |
| CRM-02 | Formatted number displayed on all CRM surfaces — no `@lid` or raw JID visible to operator | Plan 2.2: existing `formatPhone()` in crm-screen.tsx falls back to raw digits for LIDs (line 83); needs "Aguardando número" path + pt-BR E.164 formatting |
| CRM-03 | Custom capture fields saving and loading correctly | Plan 2.3: `ContactPersistentMemory` and `PersistentMemoryService` are the persistence layer; the CRM UI does not expose or render these fields — the bug is a missing UI surface, not a backend persistence failure |
| CRM-04 | Full conversation history displayed per contact, no loss between sessions | Plan 2.3: messages endpoint uses `take: limit` (default 60) — cross-session history is limited; query uses `remoteJid: { contains: phone8 }` which breaks for LID contacts |
| CRM-05 | Contact tags working end-to-end: create, assign, filter | Plan 2.3: tags flow is complete (PATCH conversation → `tags` TEXT[] column); tag filter is not yet wired in the contacts list query |
| CRM-06 | Visual interface without broken states: missing data, raw text, silent errors | Plan 2.2 + 2.3: LID contacts show raw digits; null phoneNumber renders as empty string; N+1 query causes performance degradation visible as slow list load |
| CRM-07 | Send message from CRM using correct identifier (never LID) | Plan 2.2: `handleSend` uses `targetJid: selected.jid` where `jid` comes from `c.contact.phoneNumber` which may be `@lid` — needs `targetJid` to come from a reliable `rawJid` field |
</phase_requirements>

---

## Summary

Phase 2 fixes four distinct bug classes across the CRM stack. The research reveals the current codebase is more advanced than the plan description suggests in some areas, and more broken in others.

**LID normalization (Plan 2.1):** The system already has a reactive LID→phone mapping path via `persistLidPhoneMapping()` triggered by `phone-number-share` and `chat-phone-mapping` worker events. However, at the moment a new inbound message arrives from a `@lid` contact, the `storedContactPhoneNumber` resolves to the raw LID digits (e.g., `"19383773"`) rather than E.164 — because `realPhoneFromRemoteJid` is null for `@lid` JIDs and the contact has no prior `sharedPhoneJid` in its `fields`. The `phoneNumber` column in `Contact` therefore stores LID digits. The fix requires adding a `rawJid TEXT` column, storing the `@lid` string there at upsert, leaving `phoneNumber` null, and running a BullMQ reconciliation job on connect.

**Display normalization (Plan 2.2):** The existing `formatPhone()` helper in crm-screen.tsx (line 78–85) strips suffixes and formats digits, but line 83 explicitly falls back to raw digits for values > 13 chars (intended for LIDs). The "Aguardando número" label requires a code path that detects `phoneNumber === null` before calling `formatPhone()`. The `ContactCard` component already has `isLidJid()` detection but uses "ID WhatsApp" as the sub-label — this must change to "Aguardando número" per the locked decision.

**Custom fields, tags, history (Plan 2.3):** Custom fields (`ContactPersistentMemory`) are AI-extracted per conversation via `extractAndSave()` and stored correctly in the DB — but the CRM contacts API and UI never expose this data to the operator. The actual bug is the missing UI surface for `ContactPersistentMemory.data` fields (they are only fed back as chatbot context, not shown in the panel). Tags are correctly stored in `Conversation.tags TEXT[]` and persisted via PATCH; the only missing piece is that the contacts list query has no `tags` filter clause. The N+1 loop and over-fetch are confirmed at lines 76–85 and 63 of `crm/routes.ts`.

**Tenant migrations (Plan 2.4):** `TenantPrismaRegistry.ensureSchema()` currently runs the entire `buildTenantSchemaSql()` array on every cold cache access. This is idempotent (all statements use `IF NOT EXISTS`) but has no version tracking — every startup re-runs all ALTER TABLE statements. Plan 2.4 adds a `schema_migrations` table and a `runMigrations()` function that wraps `ensureSchema()` with version gating.

**Primary recommendation:** Start with Plan 2.4 (migration infrastructure) before any other plan, as Plans 2.1 and 2.3 require adding new columns (`rawJid`, `phoneNumber` nullable change) that must go through the new migration system.

---

## Standard Stack

### Core (already in project)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| BullMQ | already installed (`Queue` imported in `app.ts`, `message-queue.ts`) | Background job queue for LID reconciliation job | Existing pattern: `createSendMessageQueue`, `createWebhookQueue` |
| ioredis | already installed | BullMQ connection, Redis client | Required by BullMQ; already instantiated |
| Pino | already installed | Structured logging for migration errors | Project-wide logger; `console.*` calls are to be replaced with Pino per Phase 3 scope |

[VERIFIED: direct codebase inspection of `apps/api/src/queues/`, `apps/api/src/app.ts`]

### Supporting (new for this phase)

No new npm dependencies required. All functionality is achievable with:
- Raw PostgreSQL via `platformPrisma.$executeRawUnsafe()` (existing pattern for schema SQL)
- BullMQ `Queue` + `Worker` (existing pattern)
- Prisma tenant client (existing pattern via `TenantPrismaRegistry`)

---

## Architecture Patterns

### Pattern 1: Worker Event → Orchestrator Handler (LID reconciliation trigger point)

**What:** Baileys worker emits events via `parentPort.postMessage()`; `InstanceOrchestrator.handleWorkerMessage()` dispatches on `event.type`.

**When to use:** Adding new reactive behavior on Baileys lifecycle events.

**How to hook the "CONNECTED" event for reconciliation:**

```typescript
// In service.ts — handleWorkerMessage(), the "status" event branch (line ~1211)
// Already fires when event.status === "CONNECTED" at line 1235.
// Add: enqueue LID reconciliation job here.

if (event.status === "CONNECTED") {
  // existing webhook + alert code...

  // NEW: enqueue reconciliation (job ID deduplicated per instanceId)
  await this.lidReconciliationQueue.add(
    `lid-reconcile:${instance.id}`,
    { tenantId, instanceId: instance.id },
    { jobId: `lid-reconcile:${instance.id}`, removeOnComplete: 10, removeOnFail: 100 }
  );
}
```

[VERIFIED: service.ts lines 1211–1277 — CONNECTED branch confirmed]

### Pattern 2: BullMQ Queue + Worker Registration (existing pattern to follow)

**What:** Queues are created in `apps/api/src/queues/` via factory functions; Workers are instantiated in the service that processes them.

**Pattern from `message-queue.ts`:**

```typescript
// apps/api/src/queues/lid-reconciliation-queue.ts  (new file)
export const createLidReconciliationQueue = (connection: IORedis): Queue =>
  new Queue(QUEUE_NAMES.LID_RECONCILIATION, {
    connection: connection as never,
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: 100,
      removeOnFail: 500,
      backoff: { type: "exponential", delay: 5_000 }
    }
  });
```

Add `LID_RECONCILIATION: "lid-reconciliation"` to `QUEUE_NAMES` in `queue-names.ts`.

[VERIFIED: `apps/api/src/queues/message-queue.ts`, `webhook-queue.ts`, `queue-names.ts`]

### Pattern 3: Tenant Schema SQL Execution (for schema_migrations table)

**What:** `TenantPrismaRegistry.ensureSchema()` at `database.ts:83` runs `buildTenantSchemaSql()` via `platformPrisma.$executeRawUnsafe()`. The same mechanism is used for `runMigrations()`.

**New `schema_migrations` table DDL:**

```sql
CREATE TABLE IF NOT EXISTS {schema}."schema_migrations" (
  "version"    TEXT        PRIMARY KEY,
  "appliedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**`runMigrations(tenantId)` logic:**

```typescript
async function runMigrations(
  platformPrisma: PlatformPrisma,
  tenantId: string,
  logger: pino.Logger
): Promise<"success" | "skipped" | "failed"> {
  const schemaName = resolveTenantSchemaName(tenantId);
  const schema = `"${schemaName}"`;

  // 1. Ensure migrations table exists
  await platformPrisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS ${schema}."schema_migrations" ("version" TEXT PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW());`
  );

  // 2. Fetch applied versions
  const applied = await platformPrisma.$queryRawUnsafe<{ version: string }[]>(
    `SELECT "version" FROM ${schema}."schema_migrations";`
  );
  const appliedSet = new Set(applied.map(r => r.version));

  // 3. Apply unapplied migrations in order
  for (const migration of MIGRATIONS) {
    if (appliedSet.has(migration.version)) continue;
    await platformPrisma.$executeRawUnsafe(migration.sql);
    await platformPrisma.$executeRawUnsafe(
      `INSERT INTO ${schema}."schema_migrations" ("version") VALUES ('${migration.version}');`
    );
  }
  return "success";
}
```

[VERIFIED: `database.ts` lines 94–111; `tenant-schema.ts` — full ALTER TABLE pattern confirmed]

### Pattern 4: Contact Upsert at Inbound Message (Plan 2.1 insertion point)

**What:** `handleInboundMessage()` in `service.ts` at lines ~1923–1978 is where contacts are created/updated from inbound messages.

**Current flow (broken for LID):**
1. `event.remoteJid` ends with `@lid`
2. `realPhoneFromRemoteJid` = null (because `normalizeWhatsAppPhoneNumber()` rejects `@lid` strings)
3. `storedContactPhoneNumber` = `sharedPhoneNumber ?? null ?? existingContact.phoneNumber ?? remoteNumber`
4. `remoteNumber` = the raw LID digits (e.g., `"19383773"`) — this is what gets stored in `phoneNumber`

**Fix target:** At the `prisma.contact.upsert()` call (line 1961), when `remoteJid.endsWith("@lid")`:
- Set `phoneNumber = null` (requires schema change: `phoneNumber` column must allow NULL)
- Set `rawJid = event.remoteJid` (new column)
- Use `instanceId + rawJid` as the upsert key (requires new unique constraint)

**Critical schema constraint:** The current `Contact` model has `@@unique([instanceId, phoneNumber])` and `phoneNumber TEXT NOT NULL`. Both must change for Plan 2.1:
- `phoneNumber TEXT` → nullable
- Add `rawJid TEXT`
- Add `@@unique([instanceId, rawJid])` for LID contacts
- The upsert key must switch to `rawJid`-based for `@lid` remoteJids

[VERIFIED: `prisma/schema.prisma` lines 223–238; `service.ts` lines 1939–1978]

### Pattern 5: `formatPhone()` Replacement (Plan 2.2)

**Current state in crm-screen.tsx (lines 78–85):**
- Strips suffix, extracts digits
- Formats 11-digit BR as `(DDD) NNNNN-NNNN`, 10-digit as `(DDD) NNNN-NNNN`
- Falls back to raw digits for values > 13 chars (intended as LID catch-all at line 83)
- **Does NOT produce `+55` prefix** — format is `(68) 9254-9342`, not `+55 68 92549342`

**CONTEXT.md locked decision for new `formatPhone()`:**
- `+55` numbers → `+55 DDD NNNNN-NNNN` (11-digit) or `+55 DDD NNNN-NNNN` (10-digit)
- Other country codes → E.164 as-is
- null input → `"Aguardando número"`
- Garbage → `"Contato desconhecido"`
- `cleanPhone()` in `crm/routes.ts` strips suffixes only — `formatPhone()` must wrap it

**Existing `cleanPhone()` in crm/routes.ts (line 32–33):**
```typescript
const cleanPhone = (raw: string | null | undefined): string =>
  (raw ?? "").replace(/@[^@]*$/, "").replace(/\D/g, "");
```

The new `formatPhone()` utility goes in `apps/api/src/lib/format-phone.ts` (server-side, called before API response) and a mirrored version in the panel's `lib/` for client-side rendering.

[VERIFIED: crm-screen.tsx lines 78–85; crm/routes.ts lines 32–33]

### Pattern 6: N+1 Fix (Plan 2.3)

**Current broken code (crm/routes.ts lines 76–85):**
```typescript
const memories = await Promise.all(
  deduped.map(c =>
    prisma.clientMemory.findFirst({
      where: { phoneNumber: { contains: cleanPhone(c.contact.phoneNumber).slice(-8) } },
      ...
    }).catch(() => null)
  )
);
```

**Fix — single `findMany` with OR:**
```typescript
const phone8List = deduped.map(c => cleanPhone(c.contact.phoneNumber).slice(-8)).filter(Boolean);
const memories = phone8List.length > 0
  ? await prisma.clientMemory.findMany({
      where: { OR: phone8List.map(p => ({ phoneNumber: { contains: p } })) },
      select: { phoneNumber: true, name: true, serviceInterest: true, status: true, scheduledAt: true, notes: true }
    })
  : [];
// Then match by phone8 suffix
const memoryMap = new Map(memories.map(m => [cleanPhone(m.phoneNumber).slice(-8), m]));
```

[VERIFIED: crm/routes.ts lines 60–85 — full query confirmed]

### Pattern 7: Over-fetch Fix (Plan 2.3)

**Current broken code (crm/routes.ts line 63):**
```typescript
take: (pageSize + skip) * 2,
```

For page=1, pageSize=40: `take = 80`. For page=5, pageSize=40: `take = 360`. The deduplication then slices `[skip, skip+pageSize]` from the fetched results — correct in logic but fetches far too many rows.

**Fix:** Use correct offset/limit via `skip` + `take`:
```typescript
// The deduplication-by-contactId approach is fundamentally incompatible with
// DB-level pagination. Options:
// A) Keep in-process dedup but cap take at pageSize * 2 with a stable orderBy
// B) Use DISTINCT ON contactId at DB level (raw SQL)
// C) Change to conversation-centric view (no dedup needed)
// Simplest safe fix: take: pageSize * 3 cap, document the tradeoff
```

**Recommended approach for this phase:** Cap `take` at `Math.min((pageSize + skip) * 2, 500)` and add a comment. A correct fix requires moving to a `DISTINCT ON` query or a different data model — defer deeper refactor to when conversation/contact model is revisited.

[VERIFIED: crm/routes.ts line 63]

### Pattern 8: Tags Filter (Plan 2.3)

**Current state:** Tags are stored correctly in `Conversation.tags TEXT[]`. The list query in `crm/routes.ts` has no tag filter — `convWhere` only filters by `status` and `contact` (for search). The `TagManager` component in crm-screen.tsx is for assigning tags, not filtering.

**Fix:** Add `tags` param to `listContactsQuerySchema` and append `tags: { hasSome: tagsArray }` to `convWhere` when provided.

[VERIFIED: crm/routes.ts lines 9–67; crm-screen.tsx — no tag filter UI or query param found]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Job deduplication on rapid reconnects | Custom in-memory dedup Map | BullMQ `jobId` option | BullMQ silently drops duplicate jobIds; survives restarts; O(1) |
| Schema version tracking | Timestamp-based or file-based migrations | `schema_migrations` table (per-tenant, per-schema) | Already in PostgreSQL; transactional; no external tool needed |
| LID digits as phone display | Slice/regex on LID string | Leave `phoneNumber = null`, show "Aguardando número" | LID digits are not phone numbers; no regex can recover a real phone from them |
| Custom phone formatting | `libphonenumber-js` | Simple regex for pt-BR +55 (locked decision: no deps) | Locked by CONTEXT.md; pt-BR only scope doesn't justify the dependency |

---

## Common Pitfalls

### Pitfall 1: `phoneNumber NOT NULL` blocks Plan 2.1
**What goes wrong:** The current Prisma schema has `phoneNumber String` (non-nullable) and `@@unique([instanceId, phoneNumber])`. Attempting to upsert a `@lid` contact with `phoneNumber = null` will fail at the DB level.
**Why it happens:** Prisma generates `TEXT NOT NULL` for non-optional String fields.
**How to avoid:** Plan 2.1 must start with a schema migration:
  1. Add `rawJid String?` column to `Contact`
  2. Make `phoneNumber String?` (nullable)
  3. Add `@@unique([instanceId, rawJid])` — conditional unique index (only when rawJid is not null)
  4. Run Prisma `db push` or migration on the platform schema; run SQL migration on all tenant schemas
**Warning signs:** `null value in column "phoneNumber" violates not-null constraint` error at runtime.

[VERIFIED: `prisma/schema.prisma` lines 223–238]

### Pitfall 2: Unique constraint collision — LID contact and real-phone contact can coexist
**What goes wrong:** When a `@lid` contact exists with `phoneNumber = null` and `rawJid = "123@lid"`, and then `persistLidPhoneMapping()` fires revealing the real phone, both the `null-phoneNumber` record and a `real-phone` record may exist for the same human contact.
**Why it happens:** The current `persistLidPhoneMapping()` already handles this case via a `$transaction` that merges conversations and deletes the LID-only record. This logic is correct and should be preserved.
**How to avoid:** The reconciliation job must re-use `persistLidPhoneMapping()` rather than writing its own merge logic.
**Warning signs:** Duplicate contact rows for the same WhatsApp user.

[VERIFIED: service.ts lines 1334–1382 — merge transaction confirmed]

### Pitfall 3: Message history query breaks for LID contacts
**What goes wrong:** The messages endpoint (crm/routes.ts line 126) fetches messages via `remoteJid: { contains: phone8 }` where `phone8 = cleanPhone(contact.phoneNumber).slice(-8)`. When `contact.phoneNumber` is null (after Plan 2.1 fix), `phone8 = ""` and the query returns all messages for the instance.
**Why it happens:** `cleanPhone(null)` returns `""`, `"".slice(-8)` returns `""`, `contains: ""` matches everything.
**How to avoid:** After Plan 2.1, the messages query must fall back to `rawJid`-based matching: `remoteJid: { equals: contact.rawJid }` when `phoneNumber` is null.
**Warning signs:** All instance messages appearing in a single contact's history view.

[VERIFIED: crm/routes.ts lines 126–133]

### Pitfall 4: `ensureSchema()` vs `runMigrations()` ordering
**What goes wrong:** `ensureSchema()` runs on every cold cache access (lazy). If `runMigrations()` is called at startup but `ensureSchema()` runs later and re-applies `buildTenantSchemaSql()`, the raw ALTER TABLE statements bypass the migration version tracking.
**Why it happens:** `buildTenantSchemaSql()` still contains ALTER TABLE statements that run outside the migration system.
**How to avoid:** After Plan 2.4, convert `buildTenantSchemaSql()` to only emit the original `CREATE TABLE IF NOT EXISTS` statements (baseline). All `ALTER TABLE` statements become versioned migrations in `MIGRATIONS[]`. `ensureSchema()` calls `runMigrations()` instead of iterating `buildTenantSchemaSql()` directly.
**Warning signs:** New columns appearing on fresh tenants but not on existing tenants (or vice versa).

[VERIFIED: `database.ts` lines 94–111; `tenant-schema.ts` — 25+ ALTER TABLE statements confirmed]

### Pitfall 5: `ContactCard` uses `isLidJid(c.jid)` — `jid` field may not always be populated
**What goes wrong:** `CrmContact.jid` is typed as `jid?: string` (optional). The API response sets it to `c.contact.phoneNumber ?? ""`. After Plan 2.1, when `phoneNumber` is null, `jid` will be `""` — `isLidJid("")` returns false, so LID contacts won't trigger "Aguardando número".
**Why it happens:** The API response maps `jid` from `phoneNumber` (the field being nulled out).
**How to avoid:** The API must return `rawJid` as a separate field. The UI must check `rawJid?.endsWith("@lid")` for the "Aguardando número" path.
**Warning signs:** Contacts with null phoneNumber showing as "(68) " or empty string in the CRM list.

[VERIFIED: crm/routes.ts lines 91–93; crm-screen.tsx lines 16, 66, 148–150]

### Pitfall 6: `ContactPersistentMemory` ≠ CRM custom fields (naming confusion)
**What goes wrong:** The plan description says "fix the custom fields persistence bug in chatbot/CRM save path". Research reveals `ContactPersistentMemory` is AI-extracted data stored per conversation — it works correctly. The "custom fields" the operator would enter manually in a CRM UI do not exist as a distinct data path. The `Contact.fields JSONB` column exists but is used for internal tracking (`lastRemoteJid`, `sharedPhoneJid`), not operator-entered data.
**Why it happens:** The terminology "custom fields" in the requirements (CRM-03) refers to the panel UI for capturing structured client info — which is served by `PersistentMemoryService` on the backend but has no UI exposure in the CRM contacts panel.
**How to avoid:** Plan 2.3 implementer must understand that CRM-03 is a UI gap (display `ContactPersistentMemory.data` in the panel) plus possibly a read-only or editable field surface. Not a backend persistence bug.
**Warning signs:** Looking for a broken write path that doesn't exist; missing the actual gap (read path in the UI).

[VERIFIED: `persistent-memory.service.ts` full file; crm-screen.tsx — no `PersistentMemory` data rendered]

---

## Code Examples

### Contact upsert insertion point (Plan 2.1)

```typescript
// service.ts — line ~1961 (handleInboundMessage)
// Current:
const contact = await prisma.contact.upsert({
  where: { instanceId_phoneNumber: { instanceId: instance.id, phoneNumber: storedContactPhoneNumber } },
  update: { displayName: ..., fields: nextContactFields },
  create: { instanceId: instance.id, phoneNumber: storedContactPhoneNumber, ... }
});

// After Plan 2.1 fix — for @lid remoteJid:
const isLid = event.remoteJid.endsWith("@lid");
if (isLid) {
  // upsert by rawJid, leave phoneNumber null
  const contact = await prisma.contact.upsert({
    where: { instanceId_rawJid: { instanceId: instance.id, rawJid: event.remoteJid } },
    update: { displayName: ..., fields: nextContactFields },
    create: { instanceId: instance.id, phoneNumber: null, rawJid: event.remoteJid, ... }
  });
} else {
  // existing path unchanged
}
```

[VERIFIED: service.ts lines 1961–1978]

### CONNECTED event hook for reconciliation (Plan 2.1)

```typescript
// service.ts — handleWorkerMessage(), inside if (event.status === "CONNECTED") block
// Currently at line ~1235:
if (event.status === "CONNECTED") {
  // ... existing code ...

  // Add: enqueue reconciliation job
  await this.lidReconciliationQueue.add(
    "reconcile",
    { tenantId, instanceId: instance.id },
    {
      jobId: `lid-reconcile:${instance.id}`,  // deduplication key
      removeOnComplete: 10,
      removeOnFail: 100
    }
  );
}
```

[VERIFIED: service.ts lines 1235–1258]

### Reconciliation worker logic (Plan 2.1)

```typescript
// For each contact with rawJid != null and phoneNumber == null:
const unresolved = await prisma.contact.findMany({
  where: { instanceId, phoneNumber: null, rawJid: { not: null } },
  select: { id: true, rawJid: true }
});

for (const contact of unresolved) {
  // Try to find a matching real-phone contact (persistLidPhoneMapping already handles merge)
  await persistLidPhoneMapping(prisma, instanceId, contact.rawJid!, resolvedJid);
  // resolvedJid: look up from sock.signalRepository or existing sharedPhoneJid in fields
}
```

### `formatPhone()` utility (Plan 2.2)

```typescript
// apps/api/src/lib/format-phone.ts  (server-side)
export function formatPhone(raw: string | null | undefined): string {
  if (raw == null) return "Aguardando número";
  const digits = raw.replace(/@[^@]*$/, "").replace(/\D/g, "");
  if (!digits) return "Contato desconhecido";

  // pt-BR: starts with 55, 12 or 13 digits total
  if (digits.startsWith("55")) {
    const local = digits.slice(2);
    if (local.length === 11) return `+55 ${local.slice(0,2)} ${local.slice(2,7)}-${local.slice(7)}`;
    if (local.length === 10) return `+55 ${local.slice(0,2)} ${local.slice(2,6)}-${local.slice(6)}`;
  }

  // International: return E.164-style with leading +
  if (digits.length > 8) return `+${digits}`;
  return "Contato desconhecido";
}
```

### `runMigrations()` integration with `ensureSchema()` (Plan 2.4)

```typescript
// database.ts — modify ensureSchema() to call runMigrations() after CREATE TABLE baseline
public async ensureSchema(platformPrisma: PlatformPrisma, tenantId: string): Promise<string> {
  // ... existing lock/cache logic ...
  const ensurePromise = (async () => {
    const schemaName = resolveTenantSchemaName(tenantId);
    // 1. Apply baseline DDL (CREATE TABLE IF NOT EXISTS only — no ALTER TABLE)
    for (const sql of buildBaselineSchemaSql(schemaName)) {
      await platformPrisma.$executeRawUnsafe(sql);
    }
    // 2. Apply versioned migrations
    await runMigrations(platformPrisma, schemaName, tenantId);
    this.ensuredSchemas.add(tenantId);
    return schemaName;
  })();
  // ...
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| One schema per tenant via raw SQL | Already implemented in `tenant-schema.ts` | Existing | Migrations must use `$executeRawUnsafe` not Prisma migrate |
| `@lid` stored as phoneNumber digits | Must move to `rawJid` column + null phoneNumber | Phase 2 | Requires schema migration before code changes |
| All ALTER TABLE on every ensureSchema call | Version-tracked migration table | Phase 2 | Eliminates repeated idempotent writes on every cache miss |

**Deprecated/outdated:**
- `take: (pageSize + skip) * 2` over-fetch pattern: replaced by correct limit/offset
- N+1 `clientMemory.findFirst()` per contact: replaced by single `findMany` with OR

---

## Runtime State Inventory

> Phase 2 is not a rename/refactor phase. However, schema changes affect live tenant data.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | `Contact.phoneNumber` stores LID digits (e.g., `"19383773"`) for existing `@lid` contacts | Data migration: update existing contacts where `phoneNumber` matches LID pattern → set `rawJid`, set `phoneNumber = null` |
| Stored data | `Contact.fields JSONB` contains `lastRemoteJid` = `@lid` string for existing contacts | No migration needed — these are internal fields; reconciliation job handles them |
| Live service config | None | — |
| OS-registered state | None | — |
| Secrets/env vars | None | — |
| Build artifacts | Prisma generated client will need regeneration after schema changes | `prisma generate` after schema.prisma edits |

**Data migration note for Plan 2.1:** After adding `rawJid` column and making `phoneNumber` nullable, a one-time SQL script must:
1. Find all contacts where `phoneNumber` does not match E.164 pattern and `fields->>'lastRemoteJid'` ends with `@lid`
2. Copy `phoneNumber` value to `rawJid` (with `@lid` suffix restored)
3. Set `phoneNumber = null`

---

## Open Questions

1. **`signalRepository.getPNForLID()` availability in worker context**
   - What we know: `persistLidPhoneMapping()` is called from `handlePhoneNumberShareEvent()` and `handleChatPhoneMappingEvent()` — these are worker events, meaning the worker is the one that knows about LID→JID mappings, not the orchestrator.
   - What's unclear: The reconciliation worker (BullMQ) runs in the orchestrator process, not the Baileys worker. It does not have direct access to `sock.signalRepository`. The only source of LID→phone mappings visible to the orchestrator is what the Baileys worker has already reported via `phone-number-share` or `chat-phone-mapping` events, stored in `Contact.fields.sharedPhoneJid`.
   - Recommendation: The reconciliation job should call `persistLidPhoneMapping()` using data already in the DB (contacts with `lastRemoteJid = @lid` and `sharedPhoneJid` available). For contacts with no `sharedPhoneJid` yet, the job cannot resolve them — log and skip. The timing window note in STATE.md is the right signal: instrument and log.

2. **`phoneNumber` unique constraint with nullable values**
   - What we know: PostgreSQL treats `NULL` as distinct in unique indexes — two rows with `phoneNumber = null` do not violate `UNIQUE(instanceId, phoneNumber)`.
   - What's unclear: Prisma's behavior with `@@unique([instanceId, phoneNumber])` when `phoneNumber` is nullable — Prisma may generate a partial index or may not.
   - Recommendation: Add a `@@unique([instanceId, rawJid])` constraint for LID contacts and keep the existing constraint for real-phone contacts. Use conditional upsert logic based on whether the remoteJid is `@lid`.

3. **CRM-03 scope — read-only vs editable custom field surface**
   - What we know: `ContactPersistentMemory.data` stores AI-extracted fields. There is no PATCH endpoint or UI to manually edit these fields.
   - What's unclear: Whether CRM-03 requires only displaying the AI-extracted fields, or also a manual edit surface for operators.
   - Recommendation: For Phase 2, implement display only (read-only rendering of `data` fields in the contact detail panel). Manual editing can be a follow-on.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 2 is purely code and schema changes. No new external dependencies beyond what is already running (PostgreSQL, Redis, Node.js). BullMQ and ioredis are already installed.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (inferred from project structure; needs confirmation — no test files found in scan) |
| Config file | Not found — Wave 0 gap |
| Quick run command | `pnpm test --filter=api` (assumed; verify against package.json) |
| Full suite command | `pnpm test` |

[ASSUMED — no test files found in `apps/api/src`. The Phase 1 plans reference test scaffolds; confirm actual test runner used.]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CRM-01 | `@lid` inbound contact stored with null phoneNumber, non-null rawJid | unit | `pnpm test --filter=api -- crm-01` | ❌ Wave 0 |
| CRM-01 | Reconciliation job resolves existing null-phoneNumber contacts | integration | `pnpm test --filter=api -- lid-reconciliation` | ❌ Wave 0 |
| CRM-02 | `formatPhone(null)` returns "Aguardando número" | unit | `pnpm test --filter=api -- format-phone` | ❌ Wave 0 |
| CRM-02 | `formatPhone("+5511987654321")` returns "+55 11 98765-4321" | unit | same | ❌ Wave 0 |
| CRM-03 | Contact detail API returns `persistentMemory` fields | unit | `pnpm test --filter=api -- crm-contact-detail` | ❌ Wave 0 |
| CRM-04 | Messages endpoint returns all sessions (no arbitrary LIMIT truncation) | unit | `pnpm test --filter=api -- crm-messages` | ❌ Wave 0 |
| CRM-05 | Tags filter param added to contacts list query | unit | `pnpm test --filter=api -- crm-contacts-list` | ❌ Wave 0 |
| CRM-06 | No `@lid` string in any API response from contacts endpoints | integration | manual / curl-based | ❌ Wave 0 |
| CRM-07 | `handleSend` uses `rawJid` as `targetJid`, not `phoneNumber` | unit | `pnpm test --filter=panel -- crm-screen` | ❌ Wave 0 |

### Wave 0 Gaps

- [ ] `apps/api/src/lib/format-phone.test.ts` — covers CRM-01 display logic and CRM-02 formatting
- [ ] `apps/api/src/modules/crm/routes.test.ts` — covers CRM-03, CRM-04, CRM-05, CRM-06
- [ ] Test framework configuration (vitest or jest config file)

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | yes | Existing `requireTenantId` + `auth: "tenant"` config on all CRM routes |
| V5 Input Validation | yes | `patchContactSchema` (Zod) on PATCH routes; new `tags` query param needs Zod validation |
| V6 Cryptography | no | — |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Tenant data leakage via `$executeRawUnsafe` | Information Disclosure | `quoteIdentifier()` already sanitizes schema names; no user input reaches raw SQL except through `resolveTenantSchemaName()` which validates pattern |
| Phone number enumeration via contains search | Information Disclosure | Low risk — already auth-gated; only tenant's own contacts are searched |
| BullMQ job injection | Tampering | Jobs enqueued from authenticated server context only; Redis not externally exposed |

---

## Sources

### Primary (HIGH confidence — all VERIFIED by direct codebase inspection)

- `apps/api/src/modules/crm/routes.ts` — N+1 bug (lines 76–85), over-fetch (line 63), cleanPhone utility (line 32), tags storage
- `apps/api/src/modules/instances/service.ts` — contact upsert path (lines 1923–1978), `persistLidPhoneMapping` (lines 1280–1419), CONNECTED event hook (lines 1235–1258)
- `apps/api/src/lib/tenant-schema.ts` — 25+ ALTER TABLE statements confirmed, full schema structure
- `apps/api/src/lib/database.ts` — `ensureSchema()` pattern (lines 83–111)
- `apps/api/src/queues/message-queue.ts`, `webhook-queue.ts`, `queue-names.ts` — BullMQ queue factory pattern
- `apps/panel/components/tenant/crm-screen.tsx` — formatPhone (lines 78–85), isLidJid (line 66), ContactCard (lines 147–174), handleSend (lines 392–411), saveTags (lines 473–483)
- `prisma/schema.prisma` — Contact model (lines 223–238), Conversation model (lines 241–258)
- `apps/api/src/modules/chatbot/persistent-memory.service.ts` — full PersistentMemoryService implementation
- `apps/api/src/modules/instances/baileys-session.worker.ts` — connection.update handler (lines 726–764)

### Secondary (MEDIUM confidence)

- None required — all research grounded in direct code inspection.

### Tertiary (LOW confidence)

- [ASSUMED] Test framework is Vitest — no test files found in scan to confirm.
- [ASSUMED] `pnpm test --filter=api` is the correct test invocation — verify against root `package.json`.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Test framework is Vitest; test command is `pnpm test --filter=api` | Validation Architecture | Planner specifies wrong test command; Wave 0 test scaffolds use wrong runner |
| A2 | `ContactPersistentMemory` data fields are the "custom fields" CRM-03 refers to | Summary, Pitfall 6 | If CRM-03 refers to operator-entered fields in a different system, the fix target changes |

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries confirmed by import inspection
- Architecture patterns: HIGH — all patterns verified from actual code in the relevant files
- Pitfalls: HIGH — each pitfall derived from specific line-number-cited code
- Schema migration design: HIGH — based on existing `$executeRawUnsafe` pattern and confirmed SQL structure

**Research date:** 2026-04-11
**Valid until:** 2026-05-11 (stable codebase; only changes if Phase 2 execution modifies the files inspected here)
