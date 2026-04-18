---
phase: 06-metrics-daily-summary
reviewed: 2026-04-18T00:00:00Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - apps/api/src/modules/instances/session-metrics-collector.ts
  - apps/api/src/modules/instances/__tests__/session-metrics-collector.test.ts
  - apps/api/src/lib/instance-events.ts
  - apps/api/src/lib/run-migrations.ts
  - apps/api/src/modules/instances/service.ts
  - apps/api/src/app.ts
  - apps/api/src/modules/instances/daily-summary.service.ts
  - apps/api/src/modules/instances/__tests__/daily-summary.service.test.ts
  - apps/api/src/modules/tenant/service.ts
  - apps/api/src/modules/tenant/routes.ts
  - apps/panel/app/(tenant)/tenant/metrics/page.tsx
  - apps/panel/app/(tenant)/tenant/layout.tsx
  - apps/panel/lib/api.ts
  - apps/api/src/modules/tenant/__tests__/tenant-metrics.service.test.ts
findings:
  critical: 1
  warning: 3
  info: 3
  total: 7
status: issues_found
---

# Phase 06: Code Review Report

**Reviewed:** 2026-04-18T00:00:00Z
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

This phase introduces session-level metrics collection, a daily summary scheduler, two new REST endpoints (`/tenant/metrics/today` and `/tenant/metrics/queue`), and a frontend metrics page. The overall architecture is sound: event-driven writes are isolated in `SessionMetricsCollector`, raw SQL queries are protected by positional parameters (`$1`, `$2`), and deduplication is layered (in-process `Map` + Redis key) for the daily summary. One critical SQL injection vector was found in `run-migrations.ts` (pre-existing but exposed by the new migration being added). Three warnings cover a local-timezone bug that shifts "today" boundaries on non-UTC servers, an unhandled-error path in the panel's new metric fetchers, and a missing `documentCount` NULL guard in the database query. Three info items note minor quality gaps.

---

## Critical Issues

### CR-01: SQL Injection via String Interpolation in Migration Version INSERT

**File:** `apps/api/src/lib/run-migrations.ts:312-313`

**Issue:** The migration version string is interpolated directly into the SQL text instead of being passed as a parameterised value:

```ts
await platformPrisma.$executeRawUnsafe(
  `INSERT INTO ${quoteSchema(schema)}."schema_migrations" ("version") VALUES ('${migration.version}');`
);
```

`migration.version` comes from the `MIGRATIONS` constant in the same file, so the current values are safe — but this pattern is fragile. Any future migration whose `version` string contains a single-quote (e.g., a typo like `2026-05-01-039-it's-done`) would produce malformed SQL. More importantly, the `quoteSchema(schema)` expansion is already validated by the regex guard on line 279, yet the version string has no analogous guard. If the codebase is ever refactored to load migrations from an external source (file system, database), this becomes an exploitable injection point.

**Fix:** Pass the version as a positional parameter:

```ts
await platformPrisma.$executeRawUnsafe(
  `INSERT INTO ${quoteSchema(schema)}."schema_migrations" ("version") VALUES ($1)`,
  migration.version
);
```

---

## Warnings

### WR-01: `startOfToday` Uses Local Server Time Instead of UTC in `getTodayMetrics` and `getDashboard`

**File:** `apps/api/src/modules/tenant/service.ts:377` and `476`

**Issue:** Both `getDashboard()` and `getTodayMetrics()` compute the start of the current day with `setHours(0, 0, 0, 0)`, which uses the **server process's local timezone**, not UTC:

```ts
const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0); // local time, not UTC
```

By contrast, `DailySummaryService.buildSessionMetricsSummary()` (line 132) and the panel copy in `metrics/page.tsx` (which labels data as "UTC") both use `setUTCHours(0, 0, 0, 0)`. When the server runs in a non-UTC timezone (common in cloud environments that inherit the host OS locale), `getTodayMetrics` will return data from a different day boundary than what the panel describes. This produces visually confusing or incorrect metrics for all users.

**Fix:** Replace both occurrences with the UTC variant, matching `buildSessionMetricsSummary`:

```ts
const startOfToday = new Date();
startOfToday.setUTCHours(0, 0, 0, 0);
```

### WR-02: `getTenantTodayMetrics` and `getTenantActiveQueue` Surface Raw Errors to the Next.js Page

**File:** `apps/panel/lib/api.ts:403-412`

**Issue:** The two new panel fetchers do not wrap their `request()` call in a try/catch, unlike every other fetcher in the same file (e.g., `getTenantDashboard`, `getTenantInstances`):

```ts
export async function getTenantTodayMetrics(): Promise<TodayMetricsSnapshot> {
  return request<TodayMetricsSnapshot>("/tenant/metrics/today", "tenant");
  // No try/catch — any HTTP error throws to the Next.js page
}
```

The metrics page (`page.tsx:44`) calls both functions inside `Promise.all` with no error boundary. A transient API error (network blip, 500 from the API) will cause an unhandled server-component exception, rendering the entire `/tenant/metrics` page as a Next.js error page rather than showing a graceful empty-state. The `isRedirectError` re-throw pattern from the 401 redirect path also needs to be preserved.

**Fix:** Wrap in try/catch and either return a safe empty default or re-throw only redirect errors, consistent with sibling functions:

```ts
export async function getTenantTodayMetrics(): Promise<TodayMetricsSnapshot> {
  try {
    return await request<TodayMetricsSnapshot>("/tenant/metrics/today", "tenant");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    // Return a zero-state so the page renders instead of crashing
    return {
      startedCount: 0, endedCount: 0, inactiveCount: 0,
      handoffCount: 0, avgDurationSeconds: null,
      avgFirstResponseMs: null, continuationRate: null,
    };
  }
}

export async function getTenantActiveQueue(): Promise<ActiveQueueEntry[]> {
  try {
    return await request<ActiveQueueEntry[]>("/tenant/metrics/queue", "tenant");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return [];
  }
}
```

### WR-03: `documentCount` Increment Assumes Column Is Never NULL — Unsafe on Partially-Migrated Schema

**File:** `apps/api/src/modules/instances/session-metrics-collector.ts:109-111`

**Issue:** The SQL for `document.sent` uses bare addition:

```sql
SET "documentCount" = "documentCount" + 1
```

Migration `2026-04-17-038-session-document-count` adds this column with `NOT NULL DEFAULT 0`, but rows created *before* that migration ran on a given tenant will have `documentCount = 0` (default fills in existing rows via `DEFAULT`). This is safe only if `ADD COLUMN … NOT NULL DEFAULT` back-fills existing rows atomically, which PostgreSQL does in-place for non-volatile expressions. So in practice this is safe — however, if a future migration makes the column nullable (or if a tenant runs on an older schema), `NULL + 1` evaluates to `NULL` in PostgreSQL, silently dropping the increment. The identical pattern in `onHandoff` (line 89) uses `COALESCE("handoffCount", 0) + 1` as a safeguard. For consistency and defensive correctness:

**Fix:** Apply the same `COALESCE` guard:

```sql
SET "documentCount" = COALESCE("documentCount", 0) + 1
```

---

## Info

### IN-01: `onUrgencyDetected` Silently Ignores Zero-Row Updates

**File:** `apps/api/src/modules/instances/session-metrics-collector.ts:122-128`

**Issue:** All other write handlers in `SessionMetricsCollector` check `rowsAffected === 0` and emit a `logger.warn`. The `onUrgencyDetected` handler does not capture the return value of `$executeRawUnsafe`, making silent session-not-found failures undetectable in logs.

**Fix:**

```ts
private async onUrgencyDetected(event: SessionUrgencyDetectedEvent): Promise<void> {
  const prisma = await this.deps.tenantPrismaRegistry.getClient(event.tenantId);
  const rowsAffected = await prisma.$executeRawUnsafe(
    `UPDATE "ConversationSession" SET "urgencyScore" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
    event.urgencyScore,
    event.sessionId
  );
  if ((rowsAffected as number) === 0) {
    this.logger.warn(
      { sessionId: event.sessionId },
      '[metrics] onUrgencyDetected: 0 rows updated — session not found'
    );
  }
}
```

### IN-02: `dailySummaryInterval` Timeout Not Cleared on `close()` When No Tick Has Fired Yet

**File:** `apps/api/src/modules/instances/service.ts:326-336`

**Issue:** `startSchedulers()` schedules the first daily summary tick via `setTimeout` (to align to the next clock-hour boundary), storing the handle in `this.dailySummaryInterval`. `stopSchedulers()` calls `clearTimeout` on this handle — which is correct. However, the recursive `scheduleDailySummaryTick()` call at line 335 (inside the timeout callback) reassigns `this.dailySummaryInterval` to the *next* interval's handle. If `close()` is called between when the first tick fires and when the recursive assignment completes, `stopSchedulers()` may clear the old handle (already fired and nulled by JS) while the new `setTimeout` handle is never cancelled. This is a low-probability race but could leave a dangling timeout after server shutdown in test environments.

This is an informational note — the window is extremely small in production, and the timeout only calls a no-op scheduler after `workers` is emptied during close.

### IN-03: Commented-Out `handoffCount` Field in Daily Summary Test Mock

**File:** `apps/api/src/modules/instances/__tests__/daily-summary.service.test.ts:42`

**Issue:** The `makePrismaMock` factory returns a row with `handoffCount: "1"` (line 42), but `buildSessionMetricsSummary` uses the column `transferredCount` in its query and result parsing. The test mock field `handoffCount` is not consumed by the implementation and may mislead future contributors about the schema shape. The correct field name in the query alias is `transferredCount` (service line 139).

**Fix:** Rename the mock field from `handoffCount` to `transferredCount` to match the actual SQL alias:

```ts
// In makePrismaMock():
transferredCount: "1",   // was: handoffCount: "1"
```

---

_Reviewed: 2026-04-18T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
