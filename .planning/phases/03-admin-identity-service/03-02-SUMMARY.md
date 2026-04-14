---
phase: 03-admin-identity-service
plan: "02"
subsystem: admin-identity
tags:
  - redis
  - jid-resolution
  - baileys
  - admin-identity
  - lid
dependency_graph:
  requires:
    - 03-01
  provides:
    - instance:{id}:admin_jid Redis key (SET on connection open, DEL on disconnect)
    - cachedAdminJid field in AdminIdentityInput
    - @lid resolution via Redis-cached JID in AdminIdentityService
  affects:
    - apps/api/src/modules/instances/baileys-session.worker.ts
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/modules/instances/admin-identity.service.ts
tech_stack:
  added: []
  patterns:
    - Redis SET/GET/DEL for ephemeral per-instance JID cache (no TTL — lifecycle managed by connection events)
    - onWhatsApp() call at connection open to resolve phone to JID while socket is authenticated
    - LID candidate injection: resolvedLidPhone prepended to adminSenderCandidates
key_files:
  created: []
  modified:
    - apps/api/src/modules/instances/baileys-session.worker.ts
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/modules/instances/admin-identity.service.ts
    - apps/api/src/modules/instances/__tests__/admin-identity.service.test.ts
decisions:
  - No TTL on instance:{id}:admin_jid Redis key — lifecycle is connection-driven (SET on open, DEL on DISCONNECTED/PAUSED)
  - Redis GET in handleInboundMessage() keeps AdminIdentityService synchronous and Redis I/O in the orchestrator layer
  - resolvedLidPhone prepended first in adminSenderCandidates so it takes priority when present
metrics:
  duration: ~25 minutes
  completed_date: "2026-04-14"
  tasks_completed: 2
  files_modified: 4
---

# Phase 03 Plan 02: Redis JID Cache for Admin LID Resolution Summary

Redis-cached JID resolution for @lid admin identification: worker calls `sock.onWhatsApp(adminPhone)` at connection open, posts `admin-jid-resolved` to orchestrator which writes `instance:{id}:admin_jid` to Redis (no TTL), cleared on DISCONNECTED/PAUSED. `handleInboundMessage()` GETs the cached JID and passes it to `AdminIdentityService.resolve()` which injects the primary admin phone as a synthetic candidate when the @lid matches.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add adminPhone to WorkerInitPayload and post admin-jid-resolved at connection open | 58adbcc | baileys-session.worker.ts, service.ts |
| 2 | Wire cachedAdminJid into AdminIdentityService + update @lid test scenario | c2ae9a3 | admin-identity.service.ts, service.ts, admin-identity.service.test.ts |

## What Was Built

**Task 1 — Worker-to-Orchestrator JID resolution pipeline:**

- `WorkerInitPayload` interface gained `adminPhone?: string | null`
- `spawnWorker()` resolves `adminPhone` from `chatbotConfig.leadsPhoneNumber` or `platformConfig.adminAlertPhone` before spawning the worker, passes it via `workerData`
- In `connection.update: open` handler (baileys-session.worker.ts), after posting `profile`, calls `nextSocket.onWhatsApp(adminPhone)` in a try/catch. On success posts `{ type: "admin-jid-resolved", resolvedJid }` to parent
- `handleWorkerEvent()` in service.ts handles `admin-jid-resolved`: calls `this.redis.set("instance:{id}:admin_jid", resolvedJid)` with no TTL
- Status handler: when `event.status === "DISCONNECTED" || event.status === "PAUSED"`, calls `this.redis.del("instance:{id}:admin_jid")`

**Task 2 — AdminIdentityService LID resolution via cached JID:**

- `AdminIdentityInput` interface gained `cachedAdminJid?: string | null`
- `AdminIdentityService.resolve()`: before building `adminSenderCandidates`, checks if `remoteJid.endsWith("@lid")` AND `cachedAdminJid` is present AND `jidsMatch(cachedAdminJid, [remoteJid])` — if so, injects `adminCandidatePhones[0]` as `resolvedLidPhone` at the front of `adminSenderCandidates`
- `handleInboundMessage()`: GETs `instance:{id}:admin_jid` from Redis and includes `cachedAdminJid` in `AdminIdentityInput`
- Scenario 4 in test split into two tests: no-false-positive (existing behavior without cache) + new @lid-resolves-via-Redis (new behavior with `cachedAdminJid`). All 6 tests green.

## Deviations from Plan

None — plan executed exactly as written.

The plan specified using `worker.postMessage` for init but the codebase uses `workerData` (passed at Worker construction). The plan's interface description was correct; only the delivery mechanism differed. Adapted accordingly — no deviation to the behavior or contracts.

## Known Stubs

None — all paths are fully wired. The `cachedAdminJid` flows from Redis through to the identity check.

## Threat Flags

No new network endpoints or auth paths introduced. Redis key `instance:{id}:admin_jid` is an internal ephemeral cache — no external surface.

## Self-Check: PASSED

All files exist. Both commits (58adbcc, c2ae9a3) present in git log. All 6 unit tests green.
