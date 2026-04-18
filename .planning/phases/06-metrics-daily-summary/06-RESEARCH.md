# Phase 6: Metrics & Daily Summary — Research

**Researched:** 2026-04-17
**Domain:** Session metrics persistence, event-driven collector, dashboard panel, WhatsApp summary delivery
**Confidence:** HIGH (all findings based on direct codebase inspection)

---

## Summary

Phase 6 builds on a very concrete foundation. `ConversationSession` already exists and holds most session-level data fields. The migration system (`run-migrations.ts`) is healthy and ready for new versions. `InstanceEventBus` exists and emits four event types, but is missing the five events `SessionMetricsCollector` needs. `urgencyScore` already has a DB column on `ConversationSession` (migration `2026-04-11-037`), resolving a key design question: there is no need for a separate `ConversationMetric` table — instead, `ConversationSession` should be extended with `documentCount` only, and all metric queries run directly against it.

The daily summary already works end-to-end (`generateDailySummary` in `AdminCommandService`, invoked from `InstanceOrchestrator.runDailySummaryForAllInstances`). The extraction task is surgical: move the send logic into a standalone `DailySummaryService`, redirect `generateDailySummary` to query `ConversationSession` instead of `Conversation` counts, and keep the Redis deduplication and module-gate logic intact. The orchestrator becomes a thin caller.

The dashboard panel page (`apps/panel/app/(tenant)/tenant/page.tsx`) already has the structure and `StatCard` component pattern. A new sub-route `tenant/metrics/` is the right location for the metrics panel; a single new API endpoint `/tenant/metrics/today` returns all needed data in one server-side call.

**Primary recommendation:** Extend `ConversationSession` (not a new table), add five new `InstanceEventBus` event types, build `SessionMetricsCollector` as a subscriber, extract `DailySummaryService` from `InstanceOrchestrator`, and add `/tenant/metrics/today` + `/tenant/metrics/queue` API endpoints.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MET-01 | `ConversationMetric` table (or equivalent): sessions started/ended/inactive/handed-off | Extend `ConversationSession` with `documentCount`; `urgencyScore` column already exists; no new table needed |
| MET-02 | Average session duration per day | Query `AVG(durationSeconds)` from `ConversationSession WHERE DATE(startedAt) = today` |
| MET-03 | Average first-response time per session | `firstResponseMs` already in `ConversationSession`; query `AVG(firstResponseMs)` |
| MET-04 | Continuation rate after inactivity message | `closedReason` on `ConversationSession` distinguishes `timeout_no_response` vs resumed; rate = resumed / (resumed + timed-out) |
| MET-05 | Document count per session | Add `documentCount` INTEGER to `ConversationSession` via migration; increment on `document.sent` event |
| MET-06 | Daily WhatsApp summary to admin (module-gated) | `generateDailySummary` exists in `AdminCommandService`; extract + redirect query to `ConversationSession` |
| MET-07 | Dashboard panel with active queue + session status | New route `tenant/metrics/`, queries `ConversationSession` directly, urgency badge from `urgencyScore` column |
</phase_requirements>

---

## Key Design Decisions (Answered by Codebase Inspection)

### Q1: Separate `ConversationMetric` table or extend `ConversationSession`?

**Answer: Extend `ConversationSession`. Do NOT create a separate table.**

[VERIFIED: tenant-schema.ts + run-migrations.ts]

`ConversationSession` already contains: `id`, `instanceId`, `contactId`, `remoteJid`, `status`, `startedAt`, `endedAt`, `durationSeconds`, `firstResponseMs`, `handoffCount`, `closedReason`, `conversationId`.

Migration `2026-04-11-037` already added `urgencyScore INTEGER DEFAULT 0` to `ConversationSession`.

The only missing column for Phase 6 is `documentCount INTEGER NOT NULL DEFAULT 0`. All MET-01 through MET-05 metrics can be computed from this extended table. Creating a separate `ConversationMetric` table would duplicate data already captured in `ConversationSession` and require a join for every query.

Plan 6.1 description in the ROADMAP references a new `ConversationMetric` table — this is superseded by the codebase reality. The plan should add migration `2026-04-XX-038-session-document-count` instead.

### Q2: What events need to be added to `InstanceEventBus`?

**Answer: Five new event types.** [VERIFIED: instance-events.ts]

Current events: `session.activity`, `session.close_intent_detected`, `session.urgency_detected`, `admin.command`.

Missing events needed by `SessionMetricsCollector`:

| New Event Type | Payload Fields | Emitter Location |
|---------------|----------------|-----------------|
| `session.opened` | `tenantId`, `instanceId`, `remoteJid`, `sessionId`, `contactId?` | `SessionStateService.openSession()` or `InstanceOrchestrator` after open |
| `session.first_response` | `tenantId`, `instanceId`, `remoteJid`, `sessionId`, `firstResponseMs` | Where bot sends first outbound reply in session |
| `session.handoff` | `tenantId`, `instanceId`, `remoteJid`, `sessionId` | Where `humanTakeover` is set to true |
| `session.closed` | `tenantId`, `instanceId`, `remoteJid`, `sessionId`, `closedReason`, `durationSeconds` | `SessionStateService.closeSession()` |
| `document.sent` | `tenantId`, `instanceId`, `remoteJid`, `sessionId` | Where bot sends a document via Baileys |

Note: `session.urgency_detected` already exists and carries `urgencyScore`. `SessionMetricsCollector` can subscribe to it to write the score to the DB column.

### Q3: How should `urgencyScore` be persisted for the urgency queue dashboard?

**Answer: DB column already exists; just update it from the `session.urgency_detected` event.**

[VERIFIED: run-migrations.ts line 247-250]

Migration `2026-04-11-037` created `ConversationSession.urgencyScore INTEGER DEFAULT 0`. `SessionMetricsCollector` subscribes to `session.urgency_detected` and runs:

```sql
UPDATE "ConversationSession" SET "urgencyScore" = $1 WHERE "id" = $2
```

The Redis-only storage from Phase 5 is for real-time use during a session; the DB column is the durable record for the dashboard sort.

### Q4: How to extract the daily summary safely?

**Answer: Extract into `DailySummaryService`; keep orchestrator as thin caller.**

[VERIFIED: service.ts lines 365-418, admin-command.service.ts lines 1434-1493]

The current flow:
1. `InstanceOrchestrator.runDailySummaryForAllInstances()` — iterates workers, checks Redis dedup, reads module config, calls `adminCommandService.generateDailySummary()`, sends via `sendAutomatedTextMessage()`
2. `AdminCommandService.generateDailySummary()` — queries `Conversation` and `ClientMemory` tables (NOT `ConversationSession`)

Extraction strategy (safe, no behavioral change for existing functionality):
1. Create `DailySummaryService` at `apps/api/src/modules/instances/daily-summary.service.ts`
2. Move `runDailySummaryForAllInstances` logic into `DailySummaryService.sendForAllInstances()`
3. Add a new `buildSessionMetricsSummary(tenantId, instanceId)` method that queries `ConversationSession` for today's metrics
4. Update `generateDailySummary` to call both the existing `Conversation` query (backward compat) AND the new `ConversationSession` query, merging results
5. `InstanceOrchestrator.runDailySummaryForAllInstances` becomes a one-liner: `await this.dailySummaryService.sendForAllInstances(this.workers)`
6. Redis deduplication key pattern `daily-summary:sent:{tenantId}:{instanceId}:{today}` stays unchanged

**Critical: do NOT break the existing `generateDailySummary` signature** — it is called from tests (mocked in `instance-eventbus-wiring.test.ts` and `chatbot-fallback.test.ts`).

### Q5: What API endpoints does the dashboard need?

**Answer: Two new endpoints under `/tenant/`.**

[VERIFIED: tenant/routes.ts, tenant/service.ts getDashboard()]

Existing pattern: single GET endpoint returns all data for a page. Follow the same pattern.

| Endpoint | Method | Auth | Returns |
|---------|--------|------|---------|
| `/tenant/metrics/today` | GET | tenant (ADMIN, OPERATOR, VIEWER) | `TodayMetricsSnapshot` — session counts by status, avg duration, avg first response, continuation rate, document count |
| `/tenant/metrics/queue` | GET | tenant (ADMIN, OPERATOR) | `ActiveQueueEntry[]` — open sessions sorted by `urgencyScore DESC, startedAt ASC`, with contactId, remoteJid, urgencyScore, durationSeconds |

Both queries run directly against `ConversationSession` (raw SQL via `prisma.$queryRawUnsafe`), consistent with the pattern in `SessionStateService`.

---

## Standard Stack

### Core (all verified in codebase)
| Component | Location | Pattern |
|-----------|----------|---------|
| DB writes | `prisma.$executeRawUnsafe(sql, ...params)` | Raw SQL, parameterized, tenant schema |
| DB reads | `prisma.$queryRawUnsafe<T>(sql, ...params)` | Raw SQL with typed generic |
| Migrations | `MIGRATIONS[]` in `run-migrations.ts` | Version string `YYYY-MM-DD-NNN-slug` |
| Events | `InstanceEventBus` (`EventEmitter` subclass) | Typed emit/on overloads |
| Non-blocking writes | `setImmediate(() => { void collector.record(...) })` | Deferred, never in message pipeline hot path |
| Redis dedup | `redis.set(key, "1", "EX", 86400)` | 24h TTL |
| Panel routes | `apps/panel/app/(tenant)/tenant/{name}/page.tsx` | Next.js 14 App Router, `async` server component, `export const dynamic = "force-dynamic"` |
| Panel API calls | `request<T>("/tenant/...", "tenant")` in `apps/panel/lib/api.ts` | Typed fetch wrapper |
| API route registration | one-liner in `apps/api/src/modules/tenant/routes.ts` | `app.get(path, { config: { auth: "tenant" ... } }, handler)` |

[VERIFIED: direct inspection of all referenced files]

---

## Architecture Patterns

### Recommended File Locations

```
apps/api/src/
├── lib/
│   └── instance-events.ts          ← add 5 new event interfaces here
│   └── run-migrations.ts           ← add migration 038-session-document-count
├── modules/instances/
│   ├── session-metrics-collector.ts   ← NEW: event subscriber, writes to ConversationSession
│   ├── daily-summary.service.ts       ← NEW: extracted from InstanceOrchestrator
│   └── service.ts                     ← thin delegation to DailySummaryService
└── modules/tenant/
    ├── routes.ts                      ← add /tenant/metrics/today and /tenant/metrics/queue
    └── service.ts                     ← add getTodayMetrics() and getActiveQueue()

apps/panel/app/(tenant)/tenant/
└── metrics/
    └── page.tsx                       ← NEW: metrics panel page (server component)
```

### Pattern 1: SessionMetricsCollector (event subscriber)

```typescript
// Source: existing session-state.service.ts pattern
export class SessionMetricsCollector {
  constructor(private readonly deps: { eventBus: InstanceEventBus; tenantPrismaRegistry: TenantPrismaRegistry; logger: pino.Logger }) {
    this.deps.eventBus.on('session.opened', (e) => { setImmediate(() => void this.onSessionOpened(e as SessionOpenedEvent).catch(err => this.deps.logger.warn(err, 'metrics: session.opened failed'))); });
    this.deps.eventBus.on('session.closed', (e) => { setImmediate(() => void this.onSessionClosed(e as SessionClosedEvent).catch(err => this.deps.logger.warn(err, 'metrics: session.closed failed'))); });
    this.deps.eventBus.on('session.handoff', (e) => { setImmediate(() => void this.onHandoff(e as SessionHandoffEvent).catch(err => this.deps.logger.warn(err, 'metrics: session.handoff failed'))); });
    this.deps.eventBus.on('document.sent', (e) => { setImmediate(() => void this.onDocumentSent(e as DocumentSentEvent).catch(err => this.deps.logger.warn(err, 'metrics: document.sent failed'))); });
    this.deps.eventBus.on('session.urgency_detected', (e) => { setImmediate(() => void this.onUrgency(e as SessionUrgencyDetectedEvent).catch(err => this.deps.logger.warn(err, 'metrics: urgency failed'))); });
  }
}
```

**Key rule:** Every `setImmediate` callback must catch its own errors. Errors must NEVER propagate to the `emit()` call site (would crash the message pipeline).

### Pattern 2: Migration version for new column

```typescript
// Source: run-migrations.ts existing pattern
{
  version: "2026-04-17-038-session-document-count",
  description: "Add documentCount column to ConversationSession table",
  sql: (schema) =>
    `ALTER TABLE ${quoteSchema(schema)}."ConversationSession" ADD COLUMN IF NOT EXISTS "documentCount" INTEGER NOT NULL DEFAULT 0;`
}
```

### Pattern 3: Metrics query (direct SQL, parameterized)

```typescript
// Source: session-state.service.ts closeSession() pattern
const rows = await prisma.$queryRawUnsafe<MetricRow[]>(
  `SELECT
     COUNT(*) FILTER (WHERE "status" = 'ENCERRADA') AS "closedCount",
     COUNT(*) FILTER (WHERE "status" = 'INATIVA') AS "inactiveCount",
     COUNT(*) FILTER (WHERE "handoffCount" > 0) AS "handoffCount",
     ROUND(AVG("durationSeconds")) AS "avgDurationSeconds",
     ROUND(AVG("firstResponseMs")) AS "avgFirstResponseMs"
   FROM "ConversationSession"
   WHERE "instanceId" = $1
     AND "startedAt" >= $2`,
  instanceId,
  startOfToday
);
```

### Pattern 4: Continuation rate calculation

Continuation rate = sessions where client replied after receiving the inactivity message / all sessions that received the inactivity message.

`closedReason` values (from `SessionStateService.closeSession`):
- `timeout_no_response` = session timed out, client did NOT continue → denominator + numerator: no
- Any other closedReason on a session that had status `CONFIRMACAO_ENVIADA` at some point → client continued

Simpler proxy: rate = 1 - (count where `closedReason = 'timeout_no_response'` / count where `closedReason IS NOT NULL`). This requires no extra column.

### Anti-Patterns to Avoid

- **Blocking the message pipeline with sync DB writes:** All `SessionMetricsCollector` writes MUST use `setImmediate()` — never `await collector.record()` directly in the hot path.
- **Creating a separate `ConversationMetric` table:** All needed data is already on `ConversationSession`. A new table adds a join and a second write point for every session.
- **Calling `generateDailySummary` from outside `AdminCommandService`:** The function is mocked in tests; its signature must remain stable. Extend it, don't replace it.
- **Emitting new event types without updating the `InstanceDomainEvent` union:** TypeScript will catch this at compile time, but only if the union is kept current. Add all five new interfaces to `InstanceDomainEvent` in `instance-events.ts`.
- **Using `prisma.conversationSession.findMany()` (Prisma ORM) for tenant queries:** The tenant schema uses raw SQL exclusively. `prisma.$executeRawUnsafe` / `$queryRawUnsafe` is the established pattern.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Time-series aggregation store | Custom metrics DB or Redis sorted sets | PostgreSQL + index on `(instanceId, startedAt)` — already defined in `tenant-schema.ts` |
| Event deduplication for summary | Custom in-memory state | Redis key `daily-summary:sent:{id}:{date}` with `EX 86400` — already in service.ts |
| Non-blocking event handler | Try/catch wrapper utilities | Node.js built-in `setImmediate()` — established pattern in this codebase |
| Dashboard real-time push | WebSocket, SSE, polling | `export const dynamic = "force-dynamic"` on the Next.js server component — re-fetches on each page load, sufficient for non-realtime metrics |

---

## Common Pitfalls

### Pitfall 1: `session.opened` fires before `sessionId` is available in Redis
**What goes wrong:** `SessionMetricsCollector` receives `session.opened` but tries to look up `sessionId` from Redis, which may not be set yet (race between emit and Redis write).
**Why it happens:** `InstanceOrchestrator` may emit the event before `SessionStateService.openSession()` completes.
**How to avoid:** Emit `session.opened` AFTER `openSession()` resolves, and include `sessionId` in the event payload directly (not looked up from Redis in the collector).

### Pitfall 2: `documentCount` increment races with session close
**What goes wrong:** A document is sent at the same time the session closes. The increment UPDATE runs after the row is marked ENCERRADA, which is fine — but if the session row doesn't exist yet (opened and closed in < 1ms), the UPDATE silently affects 0 rows.
**Why it happens:** `setImmediate()` defers the write; session may close before the deferred increment runs.
**How to avoid:** Use `UPDATE ... WHERE id = $1` with an `ON CONFLICT DO NOTHING` fallback; log a warn (not error) when 0 rows updated — this is a benign edge case.

### Pitfall 3: Daily summary runs twice on restart near the scheduled hour
**What goes wrong:** API restarts at 07:59 UTC. On restart, the scheduler fires again near 08:00. Two summaries sent.
**Why it happens:** `scheduleDailySummaryTick()` recalculates `msUntilNextHour` from the current time — a restart at 07:59 means the timeout fires 1 minute later.
**How to avoid:** The existing Redis deduplication key `daily-summary:sent:{id}:{today}` already prevents double sends. `DailySummaryService` must check this key BEFORE sending, exactly as the current `runDailySummaryForAllInstances` does. Do NOT remove this check during extraction.

### Pitfall 4: `urgencyScore` written to DB column but Redis has stale value
**What goes wrong:** Dashboard shows correct urgency badge (from DB), but Phase 5's real-time urgency detection (from Redis) differs.
**Why it happens:** Two sources of truth for the same value.
**How to avoid:** `SessionMetricsCollector.onUrgency()` writes the DB column when the score increases. The DB value is for the dashboard sort; Redis is for real-time routing. Accept that they may briefly diverge. Document this as intentional.

### Pitfall 5: Next.js panel page makes N API calls (one per instance) for the queue view
**What goes wrong:** If a tenant has 5 instances, the queue endpoint is called 5 times, creating N waterfall requests.
**Why it happens:** Naively building a per-instance loop in the panel component.
**How to avoid:** `/tenant/metrics/queue` returns all active sessions across ALL instances for the tenant in one query (no `instanceId` filter — or optional filter parameter). The panel passes no instanceId and gets the full tenant-level queue.

---

## Runtime State Inventory

Phase 6 is additive, not a rename/refactor. No runtime state migration is required.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | `ConversationSession` rows in PG — existing rows have no `documentCount` column until migration runs | Migration adds column with `DEFAULT 0`; existing rows auto-fill with 0 |
| Stored data | Redis key `daily-summary:sent:{id}:{date}` — existing dedup keys | No action; migration preserves these keys |
| Live service config | None | None |
| OS-registered state | None | None |
| Secrets/env vars | None new required | None |
| Build artifacts | None | None |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (detected from existing `__tests__/` files) |
| Config file | `apps/api/vitest.config.ts` (assumed — matches Vitest convention) |
| Quick run command | `pnpm --filter api test --run` |
| Full suite command | `pnpm --filter api test --run --coverage` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MET-01 | `session.opened` event causes row write; `session.closed` updates it | unit | `pnpm --filter api test session-metrics-collector -t "opens session row"` | Wave 0 |
| MET-02 | `AVG(durationSeconds)` query returns correct value for today | unit | `pnpm --filter api test tenant.service -t "avg duration"` | Wave 0 |
| MET-03 | `AVG(firstResponseMs)` query returns correct value | unit | `pnpm --filter api test tenant.service -t "avg first response"` | Wave 0 |
| MET-04 | Continuation rate = 1 - (timed_out / total_closed) | unit | `pnpm --filter api test tenant.service -t "continuation rate"` | Wave 0 |
| MET-05 | `document.sent` event increments `documentCount` | unit | `pnpm --filter api test session-metrics-collector -t "document count"` | Wave 0 |
| MET-06 | `DailySummaryService.sendForAllInstances` sends message when module active; no-op when disabled | unit | `pnpm --filter api test daily-summary.service -t "sends when enabled"` | Wave 0 |
| MET-07 | `/tenant/metrics/queue` returns sessions sorted by urgencyScore DESC | unit | `pnpm --filter api test tenant.service -t "active queue sort"` | Wave 0 |

### Wave 0 Gaps
- [ ] `apps/api/src/modules/instances/__tests__/session-metrics-collector.test.ts` — covers MET-01, MET-03, MET-05
- [ ] `apps/api/src/modules/instances/__tests__/daily-summary.service.test.ts` — covers MET-06
- [ ] `apps/api/src/modules/tenant/__tests__/tenant-metrics.service.test.ts` — covers MET-02, MET-04, MET-07

---

## Environment Availability

Step 2.6: SKIPPED — Phase 6 is code/config-only changes. No new external dependencies (no new CLI tools, no new services). All infrastructure (PostgreSQL, Redis, BullMQ, Baileys) already exists.

---

## Security Domain

Phase 6 adds read-only metrics endpoints and a new event subscriber. Threat surface is low.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Existing tenant auth middleware (`config: { auth: "tenant" }`) — all new routes use it |
| V3 Session Management | no | Not applicable to metrics reads |
| V4 Access Control | yes | Tenant isolation: all queries must be scoped to `instanceId` values belonging to the requesting `tenantId` — never expose cross-tenant data |
| V5 Input Validation | yes | `instanceId` and date params validated before inclusion in raw SQL parameterized queries |
| V6 Cryptography | no | No new secrets |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-tenant data exposure in metrics query | Information Disclosure | All SQL queries MUST filter by `instanceId` values fetched from tenant's own schema, not from request body; never accept `instanceId` as a raw query param |
| SQL injection via `instanceId` in raw queries | Tampering | Use `$queryRawUnsafe` with positional params (`$1`, `$2`) — never string interpolation |
| Admin JID exposure in daily summary delivery | Information Disclosure | Admin JID read from Redis cache (`instance:{instanceId}:admin_jid`) set by Phase 3's `AdminIdentityService` — never from request body |

---

## Code Examples

### Adding new event types to `InstanceEventBus`

```typescript
// Source: apps/api/src/lib/instance-events.ts — verified structure
export interface SessionOpenedEvent {
  type: 'session.opened';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  contactId?: string | null;
}

export interface SessionClosedEvent {
  type: 'session.closed';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  closedReason: string;
  durationSeconds: number | null;
}

export interface SessionHandoffEvent {
  type: 'session.handoff';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
}

export interface DocumentSentEvent {
  type: 'document.sent';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string | null;
}

// Update the union:
export type InstanceDomainEvent =
  | SessionActivityEvent
  | SessionCloseIntentEvent
  | SessionUrgencyDetectedEvent
  | AdminCommandEvent
  | SessionOpenedEvent      // NEW
  | SessionClosedEvent      // NEW
  | SessionHandoffEvent     // NEW
  | DocumentSentEvent;      // NEW
```

### `setImmediate()` wrapper for non-blocking DB write

```typescript
// Source: pattern derived from existing codebase convention — setImmediate is Node built-in
private emit(eventFn: () => Promise<void>, label: string): void {
  setImmediate(() => {
    void eventFn().catch((err) => {
      this.logger.warn({ err }, `[SessionMetricsCollector] ${label} failed`);
    });
  });
}
```

### Continuation rate SQL

```sql
-- Source: derived from ConversationSession schema (verified closedReason values in session-state.service.ts)
SELECT
  COUNT(*) FILTER (WHERE "closedReason" = 'timeout_no_response') AS "timedOutCount",
  COUNT(*) FILTER (WHERE "closedReason" IS NOT NULL) AS "totalClosedCount"
FROM "ConversationSession"
WHERE "instanceId" = $1
  AND "startedAt" >= $2
```

Continuation rate = `1 - (timedOutCount / NULLIF(totalClosedCount, 0))`.

### Active queue query (sorted by urgency)

```sql
-- Source: derived from ConversationSession schema
SELECT
  cs."id",
  cs."instanceId",
  cs."remoteJid",
  cs."contactId",
  cs."startedAt",
  cs."urgencyScore",
  EXTRACT(EPOCH FROM (NOW() - cs."startedAt"))::INTEGER AS "elapsedSeconds"
FROM "ConversationSession" cs
WHERE cs."instanceId" = ANY($1::text[])   -- array of instanceIds for this tenant
  AND cs."status" = 'ATIVA'
ORDER BY cs."urgencyScore" DESC, cs."startedAt" ASC
LIMIT 50
```

---

## State of the Art

| Old Approach | Current Approach | Impact for Phase 6 |
|--------------|------------------|-------------------|
| `generateDailySummary` queries `Conversation` and `ClientMemory` tables | New: also queries `ConversationSession` for duration/response/count metrics | Summary becomes richer; old data still included for backward compat |
| `urgencyScore` in Redis only (Phase 5) | Add DB column write via `session.urgency_detected` event | Dashboard can sort by urgency without Redis lookup |
| Daily summary owned by `InstanceOrchestrator` | Extracted to `DailySummaryService` | Orchestrator stays thin; service is independently testable |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `ConversationSession` baseline table includes all columns listed in `tenant-schema.ts` for all existing tenants | Design Decisions Q1 | If some tenants pre-date the `ConversationSession` table, migration 038 will fail on their schema — low risk, migration system already handles per-tenant failures gracefully |
| A2 | `firstResponseMs` is actually written by the system today (not just the column existing) | MET-03 | If the column exists but is never populated, the AVG query returns NULL — needs verification in staging |

---

## Open Questions (RESOLVED)

1. **Is `firstResponseMs` being written today?**
   - What we know: The column exists (in `tenant-schema.ts` and migration `035`). `SessionStateService` has no code that writes it.
   - What's unclear: Whether Phase 4 plan wired up the write or left it for a future phase.
   - Recommendation: Search for `firstResponseMs` write calls in the codebase before writing the plan. If not written, Plan 6.1 must also add the write logic (detect first bot outbound message per session, compute delta from `startedAt`).
   - **RESOLVED:** Grepped entire `apps/api/src` — zero write calls for `firstResponseMs` found. Plan 06-01 Task 3 adds the `session.first_response` event emit in `service.ts` and `SessionMetricsCollector.onFirstResponse()` writes the DB column.

2. **Should the metrics page be a new route `tenant/metrics/` or a section added to the existing `tenant/` dashboard?**
   - What we know: The dashboard page (`page.tsx`) already shows 8 stat cards and an instance map. Adding session counts there would overcrowd it.
   - What's unclear: Product preference.
   - Recommendation: Create `tenant/metrics/page.tsx` as a new dedicated route, add it to the nav in `layout.tsx`. This is consistent with how `crm/` and `chatbot/` are separate routes.
   - **RESOLVED:** Plan 06-02 creates `apps/panel/app/(tenant)/tenant/metrics/page.tsx` as a dedicated sub-route, consistent with `crm/` and `chatbot/` patterns.

---

## Sources

### Primary (HIGH confidence)
- `apps/api/src/lib/instance-events.ts` — current InstanceEventBus event types and structure
- `apps/api/src/lib/tenant-schema.ts` — ConversationSession column definitions
- `apps/api/src/lib/run-migrations.ts` — migration history including urgencyScore (migration 037)
- `apps/api/src/modules/instances/session-state.service.ts` — closeSession() pattern, Redis key format
- `apps/api/src/modules/instances/service.ts` lines 365-418 — daily summary scheduler logic
- `apps/api/src/modules/chatbot/admin-command.service.ts` lines 1434-1493 — generateDailySummary() implementation
- `apps/api/src/modules/tenant/service.ts` lines 308-396 — getDashboard() pattern for new endpoints
- `apps/api/src/modules/tenant/routes.ts` — route registration pattern
- `apps/panel/app/(tenant)/tenant/page.tsx` — existing dashboard page structure
- `apps/panel/app/(tenant)/tenant/layout.tsx` — nav items, sidebar structure
- `apps/panel/lib/api.ts` — TenantDashboardSnapshot interface, getTenantDashboard() pattern
- `apps/api/src/modules/instances/__tests__/` — test file naming convention

### Secondary (MEDIUM confidence)
- ROADMAP.md Phase 6 description — original plan intent (some details superseded by codebase reality re: separate table)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all patterns verified by direct codebase inspection
- Architecture: HIGH — all decisions grounded in existing code
- Pitfalls: HIGH — derived from specific code paths inspected, not generic advice
- Event types: HIGH — `instance-events.ts` fully read; gaps are explicit
- Daily summary extraction: HIGH — both sides of the extraction fully read

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (codebase may evolve — re-verify instance-events.ts and run-migrations.ts before planning)
