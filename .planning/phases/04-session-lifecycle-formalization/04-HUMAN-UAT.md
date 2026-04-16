---
status: partial
phase: 04-session-lifecycle-formalization
source: [04-VERIFICATION.md]
started: 2026-04-15T00:00:00Z
updated: 2026-04-15T00:00:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Exactly one confirmation message
expected: With SESSION_LIFECYCLE_V2=true and a short inactivity timeout (e.g. 2 min), after session goes idle the BullMQ deduplication should fire exactly one confirmation message to the client — no double-firing even if recordActivity() was called multiple times before the timeout
result: [pending]

### 2. Session closure after second timeout
expected: After the confirmation message is sent (CONFIRMACAO_ENVIADA state), if the client remains silent through the second timeout window, the session transitions to INATIVA, endedAt is written to PostgreSQL, and durationSeconds is calculated correctly
result: [pending]

### 3. humanTakeover survives API restart
expected: After triggering human takeover for a session, restarting the API process, and sending a new client message to that session, the bot remains silent (humanTakeover flag is read from PostgreSQL on startup, not only from in-memory state)
result: [pending]

### 4. Worker crash → DISCONNECTED status (pre-existing concern, SC5)
expected: When the WhatsApp worker exits unexpectedly (crash, not clean disconnect), the instance status is written as DISCONNECTED to PostgreSQL. Currently worker.on('exit') at service.ts:1068 only rejects pending requests without writing DISCONNECTED to PG — confirm or fix before declaring SC5 satisfied
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
