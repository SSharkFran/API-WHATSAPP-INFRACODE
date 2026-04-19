---
phase: 02-crm-identity-data-integrity
reviewed: 2026-04-18T00:00:00Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - apps/api/src/queues/lid-reconciliation-queue.ts
  - apps/api/src/workers/lid-reconciliation.worker.ts
  - apps/api/src/lib/run-migrations.ts
  - apps/api/src/lib/format-phone.ts
  - apps/panel/lib/format-phone.ts
  - apps/api/src/modules/crm/routes.ts
  - apps/panel/components/tenant/crm-screen.tsx
  - apps/api/src/lib/tenant-schema.ts
  - apps/api/src/modules/instances/service.ts
  - apps/api/src/queues/queue-names.ts
  - apps/api/src/app.ts
  - apps/api/src/modules/crm/__tests__/lid-normalization.test.ts
  - apps/api/src/modules/crm/__tests__/format-phone.test.ts
  - apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts
  - apps/api/src/lib/__tests__/run-migrations.test.ts
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-04-18T00:00:00Z
**Depth:** standard
**Files Reviewed:** 15
**Status:** issues_found

## Summary

Phase 02 introduces the @lid (Linked Identity Device) contact identity model: rawJid column on Contact, nullable phoneNumber, a BullMQ reconciliation queue/worker, schema migrations, and CRM UI updates. The core data model design is sound and the security boundary (tenant isolation, no LID digits written into phoneNumber) is respected throughout. The formatPhone function on both API and panel sides is correctly duplicated with consistent logic.

Four warnings were found: a jobId format mismatch between production code and tests that breaks deduplication guarantees; a silent swallow of load-contacts errors that leaves the UI frozen; a potential unique index collision on null rawJid for existing contacts on older PostgreSQL; and an unguarded `take` calculation in the contacts list query that can overshoot the 500-row cap. Four info-level items cover raw `console.log/warn` calls in production paths, a magic number duplication, and minor test coverage gaps.

---

## Warnings

### WR-01: jobId format mismatch — deduplication silently broken

**File:** `apps/api/src/modules/instances/service.ts:1253`

**Issue:** The production code enqueues the reconciliation job with a hyphen separator (`lid-reconcile-${instance.id}`), while the test file and the comment on line 1243 both document the format as a colon (`lid-reconcile:${instanceId}`). BullMQ deduplication is keyed on `jobId` equality; the inconsistency means if any caller uses the colon form a duplicate job will be enqueued instead of being silently skipped. The test in `lid-normalization.test.ts:186` also tests the colon form against a mock queue and will always pass regardless because the mock does not enforce the actual format used by production code.

**Fix:** Align production code to the documented format. In `service.ts` line 1253:
```typescript
// Before
jobId: `lid-reconcile-${instance.id}`,

// After
jobId: `lid-reconcile:${instance.id}`,
```
Optionally extract a constant shared by service.ts and the test so the format cannot drift again:
```typescript
// In a shared location, e.g. queue-names.ts or a constants file:
export const lidReconcileJobId = (instanceId: string) => `lid-reconcile:${instanceId}`;
```

---

### WR-02: silent error swallow freezes contact list in the UI

**File:** `apps/panel/components/tenant/crm-screen.tsx:359`

**Issue:** The `loadContacts` function catches all errors silently (`} catch { /* silent */ }`). When the API returns a non-2xx response or network error, `setContacts` is never called with new data and `setLoadingContacts(false)` still runs — leaving the UI showing stale data or an empty list with no user feedback. This is not just a UX issue: a 401/403 (auth failure) will appear identical to "no contacts", making auth problems invisible.

**Fix:**
```typescript
} catch (err) {
  console.error("[crm] loadContacts failed", err);
  showToast("Falha ao carregar contatos.", "err");
} finally { setLoadingContacts(false); }
```
The same pattern applies to `loadMessages` on line 378 (`} catch { /* silent */ }`), which would leave the message pane silently empty on any API failure.

---

### WR-03: UNIQUE INDEX on nullable rawJid can cause duplicate-row violations for existing contacts

**File:** `apps/api/src/lib/run-migrations.ts:265-269` and `apps/api/src/lib/tenant-schema.ts:114`

**Issue:** Migration `2026-04-19-040-contact-raw-jid-unique` creates a `UNIQUE INDEX` on `(instanceId, rawJid)`. In PostgreSQL, a plain `UNIQUE INDEX` treats each NULL as distinct, so multiple contacts with `rawJid IS NULL` in the same instance are allowed. However, a `UNIQUE CONSTRAINT` (not an index) would treat NULLs as equal in some older driver configurations. The actual DDL uses `CREATE UNIQUE INDEX` which is the correct PostgreSQL behaviour (NULLs are distinct), but both files must agree. Currently they do — however the baseline schema in `tenant-schema.ts:114` creates the index with the exact same name as the migration index, meaning running the migration on a freshly-provisioned tenant (which already has the index from baseline) will hit `IF NOT EXISTS` and silently succeed. This is correct, but if the baseline schema is ever updated to remove the index and the migration is already tracked as applied, the index will be missing. The risk is low today but the dual-maintenance path is fragile.

**Fix:** Consider adding a comment in `tenant-schema.ts` near the index creation explicitly noting that `run-migrations.ts:040` relies on this index existing (or vice versa), to make the coupling explicit:
```sql
-- NOTE: This index is also created by migration 2026-04-19-040-contact-raw-jid-unique.
-- Both are IF NOT EXISTS — safe to apply in either order. Keep in sync with run-migrations.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_instanceId_rawJid_key" ...
```

---

### WR-04: contacts list query `take` can exceed the documented 500-row hard cap

**File:** `apps/api/src/modules/crm/routes.ts:68`

**Issue:** The contacts query uses:
```typescript
take: Math.min((pageSize + skip) * 2, 500),
```
With `pageSize=100` (the allowed max) and `page=1`, `skip=0`, this evaluates to `Math.min(200, 500) = 200`. With `page=3`, `skip=200`, it evaluates to `Math.min(600, 500) = 500`. For large pages the deduplication window is 500 rows but the in-memory deduplication (`deduped.slice(skip, skip + pageSize)`) can return empty results if all 500 fetched rows after deduplication are exhausted before reaching the requested `skip`. The `take` formula is an approximation that works for small pages but is not guaranteed to return a full page for high page numbers combined with large `pageSize`. This is a correctness issue: callers may receive fewer results than `pageSize` without any indication that this is a pagination boundary vs. a data gap.

**Fix:** For a robust solution, either implement cursor-based pagination, or document clearly that page numbers beyond a threshold may return partial pages. As a minimal safeguard, add a `total` count field to the response so the client can detect when it has reached the true end of data.

---

## Info

### IN-01: `console.log`/`console.warn` in production code paths should use the structured logger

**File:** `apps/api/src/modules/instances/service.ts:1245`, `1303`

**Issue:** Lines 1245 and 1303 use `console.log` and `console.warn` instead of the pino logger that is available via `deps.logger` in the worker or `this.logger` in the orchestrator. The rest of the worker infrastructure (see `lid-reconciliation.worker.ts`) correctly uses structured pino logging. These `console.*` calls will not be captured by the log aggregator and do not include trace context.

**Fix:** Pass the logger into the CONNECTED-event handler and use `logger.info` / `logger.warn` with a structured context object (following the pattern already used in `lid-reconciliation.worker.ts:46,75`). Remove `console.log` calls from `persistLidPhoneMapping` and its callers.

---

### IN-02: Magic number `500` for `take` duplicated between routes and test expectation

**File:** `apps/api/src/modules/crm/routes.ts:68`, `174`

**Issue:** The value `500` appears as a hard-coded magic number in two places in `routes.ts` (the contacts query take cap and the messages query `take: 500`) with no named constant. If the cap is changed in one place it is easy to miss the other.

**Fix:**
```typescript
const MAX_QUERY_ROWS = 500; // hard cap to prevent runaway queries
```
Use this constant in both queries.

---

### IN-03: `formatPhone` — 10-digit non-BR number falls through to "Contato desconhecido"

**File:** `apps/api/src/lib/format-phone.ts:33-37` and `apps/panel/lib/format-phone.ts:33-37`

**Issue:** The final branch `if (digits.length > 10) return \`+${digits}\`` uses a strict greater-than, meaning exactly 10-digit numbers (e.g. a US number without country code) are silently classified as "Contato desconhecido". This is correct per the locked contract (the spec says "Too short to be a real phone number" for ≤10 digits), but the test suite does not cover the boundary case `digits.length === 10` to confirm the intentional exclusion is tested. If the contract changes, the boundary will be missed.

**Fix (info only):** Add a test case:
```typescript
it("returns 'Contato desconhecido' for exactly 10 digits (no country code)", () => {
  expect(formatPhone("1234567890")).toBe("Contato desconhecido");
});
```

---

### IN-04: `crm-contacts-batch.test.ts` only tests the mock, not actual routes.ts logic

**File:** `apps/api/src/modules/crm/__tests__/crm-contacts-batch.test.ts:13-47`

**Issue:** The batch test directly re-implements the `cleanPhone` helper and the `phone8List` construction inline in the test file rather than importing and testing the actual route handler. This means the tests will continue to pass even if the implementation in `routes.ts` is changed, as long as the copied helper logic in the test is not updated. The tests exercise the algorithm but not the actual production code path.

**Fix (info only):** Export `cleanPhone` from `routes.ts` (or move it to a shared utility) and import it in the test. For the batch query test, consider using a test-level Fastify instance with an injected mock prisma to test the actual route handler end-to-end.

---

_Reviewed: 2026-04-18T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
