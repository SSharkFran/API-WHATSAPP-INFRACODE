---
phase: 06-metrics-daily-summary
fixed_at: 2026-04-18T00:00:00Z
review_path: .planning/phases/06-metrics-daily-summary/06-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 06: Code Review Fix Report

**Fixed at:** 2026-04-18T00:00:00Z
**Source review:** .planning/phases/06-metrics-daily-summary/06-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (CR-01, WR-01, WR-02, WR-03)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### CR-01: SQL Injection via String Interpolation in Migration Version INSERT

**Files modified:** `apps/api/src/lib/run-migrations.ts`
**Commit:** 584e264
**Applied fix:** Replaced string interpolation of `migration.version` inside the SQL literal with a positional parameter `$1`, passing `migration.version` as the second argument to `$executeRawUnsafe`.

### WR-01: `startOfToday` Uses Local Server Time Instead of UTC in `getTodayMetrics` and `getDashboard`

**Files modified:** `apps/api/src/modules/tenant/service.ts`
**Commit:** 985aabc
**Applied fix:** Replaced both occurrences of `startOfToday.setHours(0, 0, 0, 0)` with `startOfToday.setUTCHours(0, 0, 0, 0)` (in `getDashboard` at line 377 and `getTodayMetrics` at line 476), matching the UTC convention already used in `DailySummaryService.buildSessionMetricsSummary`.

### WR-02: `getTenantTodayMetrics` and `getTenantActiveQueue` Surface Raw Errors to the Next.js Page

**Files modified:** `apps/panel/lib/api.ts`
**Commit:** a1e10ea
**Applied fix:** Wrapped both new fetchers in try/catch blocks. `getTenantTodayMetrics` returns a zero-state `TodayMetricsSnapshot` on non-redirect errors; `getTenantActiveQueue` returns an empty array. Both re-throw redirect errors (401 path) to preserve the existing `isRedirectError` pattern used throughout the file.

### WR-03: `documentCount` Increment Assumes Column Is Never NULL

**Files modified:** `apps/api/src/modules/instances/session-metrics-collector.ts`
**Commit:** 3235a83
**Applied fix:** Changed `"documentCount" = "documentCount" + 1` to `"documentCount" = COALESCE("documentCount", 0) + 1` in `onDocumentSent`, matching the defensive pattern already used by `onHandoff` for `handoffCount`.

---

_Fixed: 2026-04-18T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
