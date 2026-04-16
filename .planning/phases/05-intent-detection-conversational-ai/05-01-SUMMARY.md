---
phase: 05-intent-detection-conversational-ai
plan: "01"
subsystem: intent-classifier
tags: [intent-detection, llm-classifier, groq, feature-flag, tdd]
dependency_graph:
  requires: []
  provides:
    - classifyIntent stateless async function (apps/api/src/lib/intent-classifier.service.ts)
    - IntentLabel type + VALID_INTENT_LABELS whitelist
    - ConversationSession.lastIntentClassification cache field
    - INTENT_CLASSIFIER_V2 feature flag wiring in processConversationTurn
  affects:
    - apps/api/src/modules/instances/service.ts (processConversationTurn pipeline)
    - apps/api/src/modules/instances/conversation-session-manager.ts (ConversationSession interface)
tech_stack:
  added:
    - classifyIntent: stateless async function injecting AiCaller (llama-3.1-8b-instant, temperature 0)
  patterns:
    - AiCaller injection pattern (same as IntentRouter in chatbot/agents/)
    - JSON extraction regex /\{[\s\S]*?\}/ (same as IntentRouter)
    - Feature flag via process.env.INTENT_CLASSIFIER_V2
    - GroqKeyRotator reuse via chatbotService.getNextGroqApiKey() / reportGroqKeyResult()
key_files:
  created:
    - apps/api/src/lib/intent-classifier.service.ts
    - apps/api/src/modules/instances/__tests__/intent-classifier.service.test.ts
  modified:
    - apps/api/src/modules/instances/conversation-session-manager.ts
    - apps/api/src/modules/instances/service.ts
decisions:
  - "makeAiCaller private method added to InstanceOrchestrator — chatbotService.callAiWithFallback is private, so we build a minimal Groq fetch wrapper using existing key rotator public API"
  - "lastIntentClassification cache keyed on raw text — skips re-classification if same message arrives in rapid succession (debounce protection)"
  - "INTENT_CLASSIFIER_V2=false by default — regex stub preserved as else branch for safe rollout"
metrics:
  duration: "~15 minutes"
  completed: "2026-04-16T13:15:02Z"
  tasks_completed: 2
  files_created: 2
  files_modified: 2
---

# Phase 5 Plan 1: LLM Intent Pre-pass Classifier Summary

**One-liner:** Groq LLM intent classifier for Brazilian Portuguese using llama-3.1-8b-instant with whitelist validation, prompt injection mitigations, and feature-flag wiring behind INTENT_CLASSIFIER_V2.

## What Was Built

### Task 1: `intent-classifier.service.ts` + unit tests (TDD)

Created `apps/api/src/lib/intent-classifier.service.ts` with:

- `IntentLabel` type: `ENCERRAMENTO | URGENCIA_ALTA | TRANSFERENCIA_HUMANO | PERGUNTA | CONTINUACAO | OUTRO`
- `VALID_INTENT_LABELS` whitelist constant
- `IntentClassification` interface: `{ label: IntentLabel; confidence: number }`
- `classifyIntent(text, callAi, recentHistory?)` stateless async function

Security mitigations applied per threat model:
- **T-5-01**: Client text wrapped in `<message>${text}</message>` delimiters before LLM interpolation
- **T-5-02**: `VALID_INTENT_LABELS.includes(parsed.label)` whitelist guard rejects hallucinated labels
- **T-5-05**: Entire function body in try/catch — always returns `{ label: 'OUTRO', confidence: 0.5 }` on any failure

8 unit tests pass (GREEN):
- Tests 1-3: ENCERRAMENTO, TRANSFERENCIA_HUMANO, PERGUNTA label + confidence assertions
- Tests 4-5: null LLM response and thrown error → OUTRO fallback (never throws)
- Test 6: Invalid label not in whitelist → OUTRO fallback
- Test 7: Raw string (no JSON) → OUTRO fallback (JSON extraction fails gracefully)
- VALID_INTENT_LABELS contents assertion

### Task 2: ConversationSession extension + feature-flag wiring

**`conversation-session-manager.ts`**: Added `lastIntentClassification?` optional field to `ConversationSession` interface for caching last classification result (text + label + confidence). Prevents re-classification of same message.

**`service.ts`** changes:
- Imported `classifyIntent` from `intent-classifier.service.js` and `AiCaller` type
- Replaced bare `recognizeCloseIntent` block (lines 2226-2235) with feature-flagged dual path:
  - `INTENT_CLASSIFIER_V2=true`: LLM pre-pass via `classifyIntent()` with session cache check
  - `INTENT_CLASSIFIER_V2=false` (default): legacy regex fallback preserved in `else` branch
- Added `makeAiCaller(tenantId, instance)` private method that builds `AiCaller` using `chatbotService.getNextGroqApiKey()` + `chatbotService.reportGroqKeyResult()` — reuses existing Groq key rotator pool without exposing `callAiWithFallback` (which is private on ChatbotService)

## Commits

| Commit | Description |
|--------|-------------|
| `f6a0aa3` | test(05-01): add failing tests for classifyIntent (RED) + feat implementation (GREEN) |
| `7b5b2a1` | feat(05-01): wire classifyIntent into processConversationTurn behind INTENT_CLASSIFIER_V2 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `conversationSessionManager.getSession()` method does not exist**
- **Found during:** Task 2 implementation
- **Issue:** Plan referenced `this.conversationSessionManager.getSession(tenantId, instance.id, event.remoteJid)` but (a) the field is named `this.sessionManager` in `InstanceOrchestrator` and (b) `ConversationSessionManager` has no `getSession` method — it uses `get(key)` with a pre-built key.
- **Fix:** Used `this.sessionManager.buildKey(instance.id, event.remoteJid)` + `this.sessionManager.get(sessionKey)` — the correct API.
- **Files modified:** `apps/api/src/modules/instances/service.ts`

**2. [Rule 2 - Missing critical functionality] `makeAiCaller` method was absent**
- **Found during:** Task 2 implementation
- **Issue:** Plan said "if no such method exists, create a local wrapper." `makeAiCaller` did not exist on `InstanceOrchestrator` and `chatbotService.callAiWithFallback` is private.
- **Fix:** Added `makeAiCaller` private method using `chatbotService.getNextGroqApiKey()` + `chatbotService.reportGroqKeyResult()` — same pattern established by audio transcription at line 868.
- **Files modified:** `apps/api/src/modules/instances/service.ts`

**3. [Rule 1 - Bug] `logger.warn` not available in service.ts**
- **Found during:** Task 2 — service.ts uses `console.warn` throughout, no `logger` import.
- **Fix:** Changed `logger.warn({ err }, ...)` to `console.warn('[intent-classifier] pre-pass failed, continuing pipeline', err)` matching established logging style.
- **Files modified:** `apps/api/src/modules/instances/service.ts`

## Test Results

- `pnpm --filter api exec vitest run "intent-classifier.service.test"` → **8 passed**
- Full suite `pnpm --filter api exec vitest run` → **12 failed | 7 passed** (same as baseline before changes — no regressions introduced)

The 12 pre-existing failures are unrelated RED stubs from other plans (run-migrations, crm-contacts-batch, format-phone, lid-normalization tests).

## Known Stubs

None. `classifyIntent` is fully wired and callable. The `INTENT_CLASSIFIER_V2` feature flag defaults to false (regex fallback) — this is intentional, not a stub.

## Threat Flags

No new network endpoints, auth paths, or schema changes introduced beyond what is already in the plan's threat model (T-5-01, T-5-02, T-5-05 all mitigated).

## Self-Check: PASSED

Files exist:
- `apps/api/src/lib/intent-classifier.service.ts` — FOUND
- `apps/api/src/modules/instances/__tests__/intent-classifier.service.test.ts` — FOUND
- `apps/api/src/modules/instances/conversation-session-manager.ts` (modified) — FOUND
- `apps/api/src/modules/instances/service.ts` (modified) — FOUND

Commits verified:
- `f6a0aa3` — FOUND
- `7b5b2a1` — FOUND
