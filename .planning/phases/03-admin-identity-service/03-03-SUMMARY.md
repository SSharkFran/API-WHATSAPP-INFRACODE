---
phase: 03-admin-identity-service
plan: "03"
subsystem: panel + api
tags: [security, error-states, integration-test, platform-routes]
dependency_graph:
  requires: [03-01]
  provides: [admin-platform-routes-test, panel-403-error-states, ForbiddenError]
  affects:
    - apps/api/test/admin-platform-routes.test.ts
    - apps/panel/app/(super-admin)/admin/
    - apps/panel/lib/api.ts
tech_stack:
  added: []
  patterns: [ForbiddenError, server-component-error-handling, discriminated-catch]
key_files:
  created:
    - apps/api/test/admin-platform-routes.test.ts
    - apps/panel/app/(super-admin)/admin/loading.tsx
    - apps/panel/app/(super-admin)/admin/tenants/loading.tsx
    - apps/panel/app/(super-admin)/admin/billing/loading.tsx
  modified:
    - apps/panel/lib/api.ts
    - apps/panel/app/(super-admin)/admin/page.tsx
    - apps/panel/app/(super-admin)/admin/tenants/page.tsx
    - apps/panel/app/(super-admin)/admin/billing/page.tsx
    - apps/panel/app/(super-admin)/admin/settings/page.tsx
decisions:
  - ForbiddenError class added to lib/api.ts; all getAdmin* wrappers must re-throw it (not swallow) so page-level catch instanceof ForbiddenError works
  - Server components use try/catch + isRedirectError guard; client component (settings) uses useState error pattern
  - loading.tsx files added for skeleton states with aria-busy on server component pages
metrics:
  duration: "~90 minutes (including bug fix)"
  completed: "2026-04-14"
  tasks_completed: 2
  files_modified: 8
  checkpoint: approved
---

# Phase 03 Plan 03: Platform Route Audit + Panel Error States Summary

## What was built

**Task 1 — Integration tests** (`apps/api/test/admin-platform-routes.test.ts`): 6 tests confirming all `/api/admin/*` routes return 401/403 for unauthenticated requests and 403 for JWTs without `PLATFORM_OWNER` role. Uses `buildApp()` + `app.inject()` pattern.

**Task 2 — Panel error states**: All four super-admin pages now handle auth failures:
- `ForbiddenError` class in `lib/api.ts`; `request()` throws it on HTTP 403
- Server components catch `ForbiddenError` → render `ShieldOff` EmptyState with `role="alert"`
- 401 → `redirect("/login")`
- Loading states via `loading.tsx` with `aria-busy="true"`

**Bug fixed post-checkpoint**: `getAdminTenants()`, `getAdminBilling()`, `getAdminPlans()` were swallowing `ForbiddenError` and re-throwing as generic `Error`. Added `if (error instanceof ForbiddenError) { throw error; }` to all three wrappers.

## Checkpoint result

Human-verified approved: all four pages show ShieldOff EmptyState on 403, no blank/broken pages.
