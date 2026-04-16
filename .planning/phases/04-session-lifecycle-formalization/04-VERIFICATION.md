---
phase: 04-session-lifecycle-formalization
verified: 2026-04-15T12:00:00Z
status: human_needed
score: 4/5 roadmap success criteria verified
overrides_applied: 0
gaps: []
deferred:
  - truth: "API restart during an active conversation finds the correct ATIVA status in Redis and ConversationSession row in PostgreSQL (SC1)"
    addressed_in: "Phase 5 (implicit — sessionId wiring placeholder explicitly deferred per 04-04-SUMMARY)"
    evidence: "04-04-SUMMARY documents 'sessionId: '' placeholder — full sessionId wiring deferred to Phase 5'. openSession() is implemented and tested in isolation but never called from the hot message path. SessionStateService is only passed to SessionLifecycleService, not to InstanceOrchestrator. Phase 5 Plan 5.2 wires intent results into state transitions that will complete the openSession call."
human_verification:
  - test: "Send a test message to a WhatsApp instance and wait 10 minutes (or use SESSION_TIMEOUT_MS=120000 for 2 min)"
    expected: "Receive exactly one 'Ainda deseja continuar o atendimento?' message — never two, never zero (SC2)"
    why_human: "Requires live WhatsApp connection and BullMQ worker running with SESSION_LIFECYCLE_V2=true; cannot verify deduplication behavior without running the full stack"
  - test: "After receiving the confirmation message, do not reply for another SESSION_TIMEOUT_MS window"
    expected: "Session transitions to INATIVA and ConversationSession.endedAt is written to the database (SC3)"
    why_human: "Requires live BullMQ worker processing jobs and real PostgreSQL writes; unit tests cover the logic but not the end-to-end timer chain"
  - test: "Set humanTakeover=true for a contact via admin command, restart the API, then send a message from that contact"
    expected: "No AI reply generated — human takeover persisted via Conversation.humanTakeover in PostgreSQL (SC4)"
    why_human: "Requires live WhatsApp connection, API restart, and verification that bot stays silent"
  - test: "Kill the worker thread for an active instance (or simulate a crash) and observe the instance status"
    expected: "Instance status becomes DISCONNECTED in PostgreSQL within 5 seconds (SC5)"
    why_human: "Requires running API process and manual worker crash simulation; this is pre-existing behavior not introduced by Phase 4"
---

# Phase 4: Session Lifecycle Formalization — Verification Report

**Phase Goal:** Every conversation has a formal lifecycle — from the first message to confirmed closure — with states persisted to Redis and PostgreSQL that survive restarts, timeouts implemented via BullMQ deduplication, and human takeover that never resets on server restart.
**Verified:** 2026-04-15T12:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | Formal session states exist: ATIVA, AGUARDANDO_CLIENTE, CONFIRMACAO_ENVIADA, INATIVA, ENCERRADA (SESS-01) | VERIFIED | `SessionStatus` const enum exported from `conversation-session-manager.ts` lines 10-18; all 5 values confirmed |
| 2 | Session state infrastructure persists to Redis (24h TTL) and PostgreSQL (SESS-02) | VERIFIED (infrastructure) | `SessionStateService.openSession()` writes Redis HSET + PG INSERT; `closeSession()` writes endedAt/durationSeconds; 9+1 tests green. NOTE: `openSession()` not yet wired into the hot message path — deferred (see Deferred section) |
| 3 | Inactivity timeout via BullMQ deduplication fires after configured silence period (SESS-03/04) | VERIFIED | `SessionLifecycleService.recordActivity()` calls `queue.add()` with `deduplication.extend=true, replace=true`; deduplication key `session-timeout:{tenantId}:{instanceId}:{remoteJid}` is globally unique; guarded by `SESSION_LIFECYCLE_V2=true` feature flag |
| 4 | State machine ATIVA → CONFIRMACAO_ENVIADA → INATIVA (never direct ATIVA → ENCERRADA) (SESS-05) | VERIFIED | `processTimeoutJob()` transitions ATIVA→CONFIRMACAO_ENVIADA on first timeout, CONFIRMACAO_ENVIADA→INATIVA on second; worker reads Redis state before acting (Pitfall 6 guard); 10 tests cover all transitions |
| 5 | humanTakeover persisted in PostgreSQL — survives API restarts (SESS-06/07) | VERIFIED | `Conversation.humanTakeover` column exists in PG (tenant-schema.ts line 121); written on takeover (service.ts line 2502); checked on every inbound message (service.ts line 2693: `isAiBlocked = activeConversation.humanTakeover`); Redis fast-path (`isHumanTakeover()`) is implemented in `SessionStateService` for the BullMQ timer path |
| 6 | Session start/end/duration timestamps recorded (SESS-08) | VERIFIED | `ConversationSession` table has `startedAt`, `endedAt`, `durationSeconds`; `closeSession()` computes durationSeconds and writes all three fields; tests 7+8 in session-state.service.test.ts verify the UPDATE |
| 7 | Close intent detection from Portuguese phrases (SESS-09 stub) | VERIFIED | `session-intents.ts` exports `recognizeCloseIntent()` with 13 Portuguese phrases; normalized accent-insensitive matching; called from `handleInboundMessage()` to emit `session.close_intent_detected`; 2 tests verify true/false cases |
| 8 | InstanceEventBus decouples InstanceOrchestrator from SessionLifecycleService (SESS-01/03/07) | VERIFIED | `InstanceEventBus` typed class in `instance-events.ts` exports all 3 event types; `service.ts` has 3 emit calls (session.activity, session.close_intent_detected, admin.command); `session-lifecycle.service.ts` subscribes to both session events; NO direct import from service.ts to session-lifecycle.service.ts |
| 9 | Human takeover prevents timer resets (SESS-07 fast path) | VERIFIED | `recordActivity()` calls `sessionStateService.isHumanTakeover()` before enqueuing BullMQ job; returns early if true; Test 3 in session-lifecycle.service.test.ts covers this |
| 10 | API restart finds ATIVA status in Redis for ongoing session (SC1) | DEFERRED | `openSession()` built and tested in isolation but not wired into hot message path — deferred per plan notes |

**Score:** 4/5 roadmap success criteria verified (SC1 deferred, SC2/3/4/5 require human verification)

### Deferred Items

Items not yet met but explicitly addressed in later milestone phases.

| # | Item | Addressed In | Evidence |
|---|------|-------------|---------|
| 1 | `openSession()` called on first inbound message, inserting ConversationSession row and writing Redis hash (SC1 full wiring) | Phase 5 | 04-04-SUMMARY.md: "sessionId: '' placeholder — full sessionId wiring deferred to Phase 5". Plan 04-02 explicitly states "SessionStateService NOT wired into InstanceOrchestrator in this plan — wiring happens in Plan 4.3". Plan 04-04 makes no mention of wiring openSession. Phase 5 Plan 5.2 wires intent results into state transitions that will complete the sessionId + openSession integration |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/instances/conversation-session-manager.ts` | ConversationSessionManager + ConversationSession + SessionStatus | VERIFIED | 309 lines; exports `ConversationSessionManager`, `ConversationSession`, `SessionStatus`; LRU cap 500; `clearAll()`, `startGc()`, `stopGc()` all present |
| `apps/api/src/modules/instances/__tests__/conversation-session-manager.test.ts` | Unit tests 8+ | VERIFIED | 164 lines; 8 test cases covering all behaviors including LRU cap and processing guard |
| `apps/api/src/modules/instances/session-state.service.ts` | SessionStateService — Redis + PG persistence | VERIFIED | 225 lines; `openSession`, `getSessionState`, `isHumanTakeover`, `updateStatus`, `closeSession`, `setHumanTakeover` all present; remoteJid validation (T-04-02-01); humanTakeover write-gate (T-04-02-02) |
| `apps/api/src/modules/instances/__tests__/session-state.service.test.ts` | Unit tests 9+ | VERIFIED | 235 lines; 10 test cases (9 from plan + 1 extra for setHumanTakeover) |
| `apps/api/src/lib/tenant-schema.ts` | ConversationSession CREATE TABLE + indexes + ALTER TABLE guards | VERIFIED | 5 matches; CREATE TABLE IF NOT EXISTS with all required columns, 2 indexes, 2 ALTER TABLE IF NOT EXISTS guards |
| `apps/api/prisma/tenant.prisma` (at root `/prisma/tenant.prisma`) | model ConversationSession | VERIFIED | `model ConversationSession` present in `/prisma/tenant.prisma` |
| `apps/api/src/queues/session-timeout-queue.ts` | createSessionTimeoutQueue factory | VERIFIED | exists; exports `createSessionTimeoutQueue`; uses `QUEUE_NAMES.SESSION_TIMEOUT` |
| `apps/api/src/workers/session-timeout.worker.ts` | BullMQ worker handler | VERIFIED | exists; `createSessionTimeoutProcessor` exported; reads Redis state before acting; safe no-op on null state |
| `apps/api/src/modules/instances/session-lifecycle.service.ts` | SessionLifecycleService — state machine + BullMQ | VERIFIED | 269 lines; `recordActivity`, `processTimeoutJob`, `recognizeCloseIntent`, `scheduleSecondTimeout`, `close` all present; feature flag guard; worker redis.duplicate() (T-04-03-05) |
| `apps/api/src/modules/instances/__tests__/session-lifecycle.service.test.ts` | Unit tests 10+ | VERIFIED | 274 lines; 10 test cases covering all SESS-03/04/05/07/09 |
| `apps/api/src/lib/instance-events.ts` | InstanceEventBus typed EventEmitter + all event interfaces | VERIFIED | 58 lines; `InstanceEventBus`, `SessionActivityEvent`, `SessionCloseIntentEvent`, `AdminCommandEvent`, `InstanceDomainEvent` all exported; typed overloads on emit/on/off |
| `apps/api/src/lib/session-intents.ts` | recognizeCloseIntent pure function | VERIFIED | 42 lines; 13 Portuguese closure phrases; NFD accent normalization |
| `apps/api/src/modules/instances/__tests__/instance-eventbus-wiring.test.ts` | 5 emit behavior tests | VERIFIED | 302 lines; 5 tests verifying admin vs client event routing |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `apps/api/src/modules/instances/service.ts` | `conversation-session-manager.ts` | `new ConversationSessionManager()` | WIRED | `grep "new ConversationSessionManager" service.ts` → 1 match at line ~296; `sessionManager` referenced 15 times; 0 matches for `conversationSessions` |
| `apps/api/src/modules/instances/session-state.service.ts` | Redis hash | `redis.hset / redis.hgetall / redis.hget` | WIRED | `session:${tenantId}:${instanceId}:${remoteJid}` key pattern; expire with 86400 TTL |
| `apps/api/src/modules/instances/session-state.service.ts` | ConversationSession table | `prisma.$executeRawUnsafe INSERT / UPDATE` | WIRED | INSERT on openSession; UPDATE on closeSession with endedAt/durationSeconds |
| `apps/api/src/modules/instances/session-lifecycle.service.ts` | `session-timeout-queue.ts` | `queue.add('check-inactivity', ...)` with deduplication | WIRED | `deduplication.extend=true`, `deduplication.replace=true`, dedup key format verified |
| `apps/api/src/workers/session-timeout.worker.ts` | `session-state.service.ts` | `sessionStateService.getSessionState / updateStatus / closeSession` | WIRED | All 3 methods called in worker processor |
| `apps/api/src/app.ts` | `session-lifecycle.service.ts` | `new SessionLifecycleService(deps)` + onClose hook | WIRED | Lines 195-208: instantiated with all deps; line 297: `await sessionLifecycleService.close()` in onClose |
| `apps/api/src/modules/instances/service.ts` | `instance-events.ts` | `this.eventBus.emit('session.activity', ...)` | WIRED | 3 emit calls at lines 2218, 2227, 2239 |
| `apps/api/src/modules/instances/session-lifecycle.service.ts` | `instance-events.ts` | `eventBus.on('session.activity', ...)` | WIRED | Lines 96-106: subscription wired with `.catch()` guard; also subscribes to session.close_intent_detected |
| `apps/api/src/app.ts` | `instance-events.ts` | `new InstanceEventBus()` + pass to both consumers | WIRED | Line 80: `const eventBus = new InstanceEventBus()`; line 167: passed to InstanceOrchestrator; line 206: passed to SessionLifecycleService |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `session-state.service.ts` openSession | `sessionId` (UUID) | `randomUUID()` → Redis HSET → PG INSERT | Yes — generates UUID, writes to both stores | FLOWING |
| `session-state.service.ts` closeSession | `durationSeconds` | `startedAt` from Redis HGETALL → computed | Yes — reads real Redis state and writes to PG | FLOWING |
| `session-lifecycle.service.ts` recordActivity | BullMQ job | `queue.add()` with deduplication | Yes — enqueues real BullMQ job when enabled | FLOWING (feature-flag gated) |
| `service.ts` handleInboundMessage | `isAdminOrInstanceSender` | Admin identity resolution via existing AdminIdentityService | Yes — real admin check | FLOWING |
| `session-state.service.ts` | Redis key `session:{tenantId}:{instanceId}:{remoteJid}` | NOT CALLED from hot path | No — openSession never invoked from message processing | DISCONNECTED (deferred) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `SessionStatus` enum has all 5 values | `grep "ATIVA\|AGUARDANDO\|CONFIRMACAO\|INATIVA\|ENCERRADA" conversation-session-manager.ts` | All 5 present | PASS |
| `conversationSessions` Map removed from service.ts | `grep -c "conversationSessions" service.ts` | 0 | PASS |
| `sessionManager` delegating in service.ts | `grep -c "sessionManager" service.ts` | 15 | PASS |
| `deduplication.extend=true` in recordActivity | `grep "extend: true" session-lifecycle.service.ts` | 1 match at line 153 | PASS |
| No circular import service.ts → session-lifecycle.service.ts | `grep "session-lifecycle.service" service.ts` | 0 | PASS |
| ConversationSession table in tenant-schema.ts | `grep -c "ConversationSession" tenant-schema.ts` | 5 (CREATE TABLE + 2 indexes + 2 ALTER TABLE) | PASS |
| eventBus passed to both consumers in app.ts | `grep -c "eventBus" app.ts` | 3 (instantiation + InstanceOrchestrator + SessionLifecycleService) | PASS |
| SESSION_LIFECYCLE_V2 feature flag guard | `grep "SESSION_LIFECYCLE_V2" session-lifecycle.service.ts` | line 59: `this.enabled = deps.config.SESSION_LIFECYCLE_V2 === "true"` | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| SESS-01 | 04-01, 04-04 | Formal session states: ATIVA, AGUARDANDO_CLIENTE, CONFIRMACAO_ENVIADA, INATIVA, ENCERRADA | SATISFIED | `SessionStatus` const enum in `conversation-session-manager.ts`; `InstanceEventBus` decoupling |
| SESS-02 | 04-02 | Session state persisted in Redis (24h TTL) + PostgreSQL — not just in memory | SATISFIED (infrastructure) | `SessionStateService` with openSession/closeSession fully implemented; ConversationSession table in tenant-schema; NOTE: openSession not yet wired into hot path (deferred) |
| SESS-03 | 04-03 | Inactivity timeout of 10 minutes triggers "Ainda deseja continuar?" message | SATISFIED | `SessionLifecycleService.recordActivity()` enqueues BullMQ job with configurable delay; worker sends message on first timeout |
| SESS-04 | 04-03 | BullMQ deduplication with extend:true — timer resets per message | SATISFIED | `deduplication: { extend: true, replace: true }` in `queue.add()` call; dedup key is globally unique per session |
| SESS-05 | 04-03 | Session never closed abruptly — always tries confirmation first | SATISFIED | State machine: ATIVA → CONFIRMACAO_ENVIADA → INATIVA; `processTimeoutJob()` never goes directly ATIVA → ENCERRADA |
| SESS-06 | 04-02 | humanTakeover persisted in DB — not lost on worker restart | SATISFIED | `Conversation.humanTakeover` boolean column in PostgreSQL; written via `prisma.conversation.update()` at service.ts line 2502; Redis fast-path `setHumanTakeover()` also implemented |
| SESS-07 | 04-02, 04-03, 04-04 | When humanTakeover active, bot stops responding completely | SATISFIED | service.ts line 2693: `isAiBlocked = activeConversation.humanTakeover`; `recordActivity()` skips BullMQ enqueue via `isHumanTakeover()` check |
| SESS-08 | 04-02 | Start time, end time, duration recorded per session | SATISFIED | `ConversationSession` table has startedAt/endedAt/durationSeconds; `closeSession()` computes and writes all three |
| SESS-09 | 04-03, 04-04 | Auto-closure from client intent: "obrigado", "era só isso", "pode encerrar" etc. | SATISFIED (stub) | `session-intents.ts` has 13 Portuguese phrases with accent normalization; called from `handleInboundMessage()` to emit `session.close_intent_detected`; intentionally stub — Phase 5 replaces with Groq LLM classifier |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `service.ts` | 2224 | `sessionId: ''` empty string in session.activity payload | Info | Intentional placeholder per plan; real sessionId wiring deferred to Phase 5; empty string is safe default for BullMQ timeout dedup key |
| `conversation-session-manager.ts` | 149 | `console.log` instead of structured logger | Warning | No pino logger in ConversationSessionManager (plan spec showed logger option but implementation omits it); functional issue but no behavioral regression |

### Human Verification Required

#### 1. Inactivity Timer — Exactly One Confirmation Message (SC2)

**Test:** With `SESSION_LIFECYCLE_V2=true` and `SESSION_TIMEOUT_MS=120000` (2 minutes) in `.env`, start a WhatsApp conversation with a test contact via an active instance. Send one message, then go silent for 2+ minutes.
**Expected:** Receive exactly one "Ainda deseja continuar o atendimento? Se não houver resposta, encerraremos em breve." message — not two, not zero.
**Why human:** Requires live WhatsApp connection, BullMQ worker processing jobs, and Redis TTL/delay interaction to be validated at runtime.

#### 2. Session Closure After Second Timeout (SC3)

**Test:** After receiving the "still there?" message (from test above), do not reply for another `SESSION_TIMEOUT_MS` window (2 minutes in staging). Then query the database.
**Expected:** `SELECT "endedAt", "durationSeconds", "status" FROM "ConversationSession" WHERE "remoteJid" = '...' LIMIT 1` returns a row with `status='INATIVA'`, non-null `endedAt`, and positive `durationSeconds`.
**Why human:** End-to-end timer chain (first job → updateStatus → second job → closeSession → PG write) must be validated with real infrastructure.

#### 3. Human Takeover Survives API Restart (SC4)

**Test:** Trigger human takeover for a test contact via the admin command path (e.g., send the takeover command from the admin's WhatsApp number). Restart the API server. Send a message from the test contact.
**Expected:** No AI reply generated. The bot remains silent, human takeover persists.
**Why human:** Requires live WhatsApp connection, API restart, and observing absence of bot response.

#### 4. Worker Crash → DISCONNECTED in 5 Seconds (SC5 — pre-existing behavior)

**Test:** Find a running instance, kill its worker thread (or simulate a crash), observe the instance card in the management panel.
**Expected:** Instance status shows DISCONNECTED within 5 seconds. (Note: worker.on('exit') in service.ts rejects pending requests but does NOT write DISCONNECTED to PG; this may need a separate heartbeat mechanism.)
**Why human:** Requires manual crash simulation; also flags a potential gap — worker exit handler at lines 1068-1088 does not call `prisma.instance.update({ data: { status: 'DISCONNECTED' } })`. The DISCONNECTED write at line 642 is in the explicit `disconnectInstance()` path, not the crash path.

### Gaps Summary

No blocking gaps found in the automated verification scope. All 9 SESS requirements have implementation evidence. The infrastructure for SESS-02's Redis/PG persistence is complete; the hot-path wiring of `openSession()` is a known deferred item (explicitly documented in plan summaries, partial wiring intended for Phase 5).

**Potential concern for human verification:** SC5 (worker crash → DISCONNECTED status in PG within 5 seconds) may not be satisfied by the current code — `worker.on('exit')` in service.ts at line 1068 does not write DISCONNECTED to PostgreSQL. This is likely pre-existing behavior from before Phase 4 and may require a separate fix. Confirm in staging.

---

_Verified: 2026-04-15T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
