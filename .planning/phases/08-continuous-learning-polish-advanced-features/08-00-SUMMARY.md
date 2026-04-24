---
phase: "08"
plan: "00"
subsystem: test-scaffolding
tags: [wave-0, tdd, aprendizado-continuo, follow-up, urgency, confirmation-gate]
dependency_graph:
  requires: []
  provides:
    - Wave 0 test stubs for APR-01, APR-02, APR-04, APR-05, FOL-01, FOL-02, URG-01
  affects:
    - Plans 01-04 (all have pre-existing test targets via these stubs)
tech_stack:
  added: []
  patterns:
    - it.todo() stubs for graceful runner skip before implementation exists
    - Wave 0 Nyquist compliance pattern (stubs before implementation)
key_files:
  created:
    - apps/api/src/modules/instances/__tests__/aprendizado-continuo.interface.test.ts
    - apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts
    - apps/api/src/modules/chatbot/__tests__/knowledge-audit.test.ts
    - apps/api/src/modules/instances/__tests__/follow-up.service.test.ts
  modified:
    - apps/api/src/modules/instances/__tests__/session-metrics-collector.test.ts
decisions:
  - Wave 0 stubs use it.todo() for graceful runner skip rather than failing imports (except APR-01 which intentionally imports non-existent Plan 01 path)
  - Pre-existing test failures (10 files, 17 tests) documented as out-of-scope; not fixed per deviation scope boundary
metrics:
  duration_minutes: 15
  completed_date: "2026-04-24"
  tasks_completed: 3
  tasks_total: 3
  files_created: 4
  files_modified: 1
---

# Phase 08 Plan 00: Wave 0 Test Scaffolds Summary

Wave 0 test scaffolding for Phase 8 — 5 test files created/extended covering APR-01 Null Object, APR-02/APR-04 confirmation gate, APR-05 knowledge audit, FOL-01/FOL-02 follow-up service, and URG-01 urgency DB persistence.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | APR-01 Null Object interface test stub | 5c85708 | aprendizado-continuo.interface.test.ts |
| 2 | Confirmation gate + knowledge audit stubs | aa2df93 | escalation-confirmation-gate.test.ts, knowledge-audit.test.ts |
| 3 | Follow-up service + session metrics urgency stubs | b6188a2 | follow-up.service.test.ts, session-metrics-collector.test.ts |

## What Was Built

### Task 1 — APR-01 Null Object interface test stub
Created `aprendizado-continuo.interface.test.ts` with 7 test stubs:
- 6 tests for `DisabledAprendizadoContinuoModule` behaviors (isEnabled=false, empty phone/JID arrays, async resolves to null/empty)
- 1 test for `ActiveAprendizadoContinuoModule.isEnabled()` returns true
- Imports from `../aprendizado-continuo.disabled.js` (intentionally fails until Plan 01 creates the file — Wave 0 design)

### Task 2 — Confirmation gate + knowledge audit stubs
Created two files with `it.todo()` stubs:
- `escalation-confirmation-gate.test.ts`: 5 stubs covering confirmation echo, SIM/ok/claro disambiguation, Redis TTL=600
- `knowledge-audit.test.ts`: 2 stubs covering confirmedAt and confirmedByJid audit metadata
- Both import from existing service files (`escalation.service.ts`, `knowledge.service.ts`)

### Task 3 — Follow-up + urgency stubs
- Created `follow-up.service.test.ts`: 5 stubs for FollowUpService 24h window, business hours, blocked persistence, force-override
- Extended `session-metrics-collector.test.ts`: appended `describe('SessionMetricsCollector — urgency_detected (URG-01)')` with 1 `it.todo` stub
- Existing 5 tests in session-metrics-collector preserved

## Deviations from Plan

### Out-of-Scope Pre-existing Failures Documented

**Found during:** All tasks (visible in full test suite run)
**Issue:** 10 test files with 17 failing tests pre-existed before this plan ran. Failures include `chatbot-fallback.test.ts`, `instance-eventbus-wiring.test.ts`, `tenant-metrics.service.test.ts`, and integration test files.
**Action:** Per deviation scope boundary, these were NOT fixed. They are pre-existing failures from earlier phases.
**Impact:** Full test suite exits with code 1, but this was true before this plan. New files created in this plan all exit 0 individually (except APR-01 which intentionally fails on import per Wave 0 design).

None of the 17 pre-existing failures were caused by this plan's changes.

## Known Stubs

All test files in this plan are intentionally stubs — this is the design. Plans 01-04 will replace/implement the actual behavior.

| File | Stub Type | Resolving Plan |
|------|-----------|----------------|
| aprendizado-continuo.interface.test.ts | Import fails (no implementation) | Plan 01 |
| escalation-confirmation-gate.test.ts | it.todo() | Plan 02 |
| knowledge-audit.test.ts | it.todo() | Plan 03 |
| follow-up.service.test.ts | it.todo() | Plan 04 |
| session-metrics-collector.test.ts (URG-01 block) | it.todo() | Plan 04 |

## Threat Flags

None. No production code paths modified. All changes are test-only files.

## Self-Check: PASSED

Files verified:
- FOUND: apps/api/src/modules/instances/__tests__/aprendizado-continuo.interface.test.ts
- FOUND: apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts
- FOUND: apps/api/src/modules/chatbot/__tests__/knowledge-audit.test.ts
- FOUND: apps/api/src/modules/instances/__tests__/follow-up.service.test.ts
- FOUND: apps/api/src/modules/instances/__tests__/session-metrics-collector.test.ts (extended)

Commits verified:
- FOUND: 5c85708 test(08-00): add Wave 0 stub — APR-01 Null Object interface tests
- FOUND: aa2df93 test(08-00): add Wave 0 stubs — APR-02/APR-04 confirmation gate and APR-05 knowledge audit
- FOUND: b6188a2 test(08-00): add Wave 0 stubs — FOL-01/FOL-02 follow-up and URG-01 urgency metrics
