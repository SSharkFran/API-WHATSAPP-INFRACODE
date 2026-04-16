---
phase: 05-intent-detection-conversational-ai
plan: "03"
subsystem: honest-fallback
tags: [honest-fallback, tdd, ia-03, ia-04, ia-05, orchestrator-hardening]
dependency_graph:
  requires:
    - 05-01: classifyIntent + INTENT_CLASSIFIER_V2 flag
    - 04-02: InstanceEventBus (used in surrounding service.ts context)
  provides:
    - Honest fallback message ("Essa é uma ótima pergunta!") sent to client when chatbotResult is null (IA-03)
    - Module-gated admin notification (Part B) when aprendizadoContinuo isEnabled+VERIFIED (IA-04)
    - T-5-04 mitigation: re-check isConversationAiBlocked before firing fallback
    - T-5-10 mitigation: Part B only fires on isEnabled === true && verificationStatus === "VERIFIED"
    - Hardened OrchestratorAgent.process() with explicit IA-03 null comment
    - 5 chatbot-fallback tests (IA-03/IA-04 behaviors)
    - 6 orchestrator tests (IA-03/IA-05 fallback chain)
  affects:
    - apps/api/src/modules/instances/service.ts (processConversationTurn null chatbotResult path)
    - apps/api/src/modules/chatbot/agents/orchestrator.agent.ts (explicit null comment added)
tech_stack:
  added: []
  patterns:
    - Re-check isConversationAiBlocked immediately before honest fallback (double-check pattern, T-5-04)
    - getAprendizadoContinuoModuleConfig module gate: same triple-equals pattern as ESCALATE_ADMIN at line 4359
    - sendAutomatedTextMessage for both client (Part A) and admin (Part B) — echo-safe
    - .catch() on admin sendAutomatedTextMessage so notification failure never blocks client response
    - vi.spyOn on private agent properties for OrchestratorAgent fallback chain tests
key_files:
  created:
    - apps/api/src/modules/chatbot/__tests__/chatbot-fallback.test.ts
    - apps/api/src/modules/chatbot/agents/__tests__/orchestrator.test.ts
  modified:
    - apps/api/src/modules/instances/service.ts
    - apps/api/src/modules/chatbot/agents/orchestrator.agent.ts
decisions:
  - "Inserted honest fallback block BEFORE const rawResponse (line 4573) and AFTER ESCALATE_ADMIN return — ensures all explicit action checks run first, fallback only fires on genuine null result"
  - "Did NOT add logger injection to OrchestratorAgent — plan explicitly permits leaving console.log if pino not yet injectable; migration deferred to Phase 3"
  - "chatbotResult null guard uses !chatbotResult (not NO_MATCH action) — chatbot service already converts NO_MATCH to null before returning to processConversationTurn"
metrics:
  duration: "~30 minutes"
  completed: "2026-04-16T12:00:00Z"
  tasks_completed: 2
  files_created: 2
  files_modified: 2
---

# Phase 5 Plan 3: Graceful "I Don't Know" Response Summary

**One-liner:** Honest fallback message ("Essa é uma ótima pergunta!") sent to client when chatbotResult is null, with module-gated admin notification via aprendizadoContinuo gate, re-check of isConversationAiBlocked to prevent firing during intentional silence (T-5-04), and hardened OrchestratorAgent with explicit null return comment.

## What Was Built

### Task 1: Honest fallback path in processConversationTurn + chatbot-fallback tests (TDD)

**`apps/api/src/modules/instances/service.ts`** — new block inserted after ESCALATE_ADMIN return (line 4571), before `const rawResponse`:

```typescript
// IA-03/IA-04: Honest fallback when AI cannot produce a response
if (!chatbotResult) {
  // T-5-04: Re-check isConversationAiBlocked (state may have changed during pipeline)
  const stillBlocked = await this.isConversationAiBlocked(prisma, params.conversationId);
  if (stillBlocked) return; // preserve intentional silence

  // Part A — always fires (IA-03)
  const HONEST_FALLBACK_MESSAGE = "Essa é uma ótima pergunta! ...";
  await this.sendAutomatedTextMessage(..., { action: "honest_fallback", kind: "chatbot" });
  this.appendConversationHistory(params.session, "assistant", HONEST_FALLBACK_MESSAGE);

  // Part B — only if aprendizadoContinuo isEnabled+VERIFIED (IA-04, T-5-10)
  const shouldNotifyAdmin =
    aprendizadoContinuoModule?.isEnabled === true &&
    aprendizadoContinuoModule.verificationStatus === "VERIFIED";
  if (shouldNotifyAdmin && adminPhoneForFallback) {
    await this.sendAutomatedTextMessage(..., { action: "honest_fallback_admin_notify", kind: "chatbot" })
      .catch(err => console.warn("[honest-fallback] falha ao notificar admin:", err));
  }
  return;
}
```

**`apps/api/src/modules/chatbot/__tests__/chatbot-fallback.test.ts`** (new, 5 tests):
- Test 1: chatbotResult null + not blocked → client receives HONEST_FALLBACK_MESSAGE
- Test 2: chatbotResult null + isConversationAiBlocked true → no honest fallback (silence)
- Test 3: chatbotResult null + aprendizadoContinuo DISABLED → Part A fires, Part B suppressed
- Test 4: chatbotResult null + aprendizadoContinuo ENABLED+VERIFIED + adminPhone → Part A + Part B, admin message contains question text
- Test 5: chatbotResult null + aprendizadoContinuo ENABLED but adminPhone null → Part A fires, Part B skipped

### Task 2: OrchestratorAgent fallback chain hardening + orchestrator tests (TDD)

**`apps/api/src/modules/chatbot/agents/orchestrator.agent.ts`** — explicit IA-03 comment added to innermost catch:
```typescript
return null; // IA-03: never return undefined — null signals "no response available"
```

**`apps/api/src/modules/chatbot/agents/__tests__/orchestrator.test.ts`** (new, 6 tests):
- Test 1: FaqAgent throws → GeneralAgent catches → returns string
- Test 2: SchedulingAgent throws → GeneralAgent catches → returns string
- Test 3: GeneralAgent also throws → returns null (not undefined, not re-throw)
- Test 4: IntentRouter throws → falls back to GENERAL → GeneralAgent returns string
- Test 5: process() with null callAi → always string | null, never undefined
- Test 6: EscalationAgent throws → GeneralAgent catches → returns string

## Commits

| Commit | Description |
|--------|-------------|
| `cfd3499` | test(05-03): add failing tests for IA-03/IA-04 honest fallback (RED) |
| `fe7da54` | chore(05-03): restore plan 01/02 files deleted by git reset |
| `dfb3bee` | feat(05-03): add honest fallback path to processConversationTurn (IA-03/IA-04) |
| `e7eb57c` | feat(05-03): harden OrchestratorAgent fallback chain + add 6-test orchestrator suite |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] git reset --soft caused plan 01/02 files to be deleted in working tree**
- **Found during:** RED test commit setup
- **Issue:** The initial git reset --soft to rebase onto af436e9 reverted the working tree state, deleting files that were added in commits 759fd12 through af436e9. The commit `cfd3499` accidentally deleted 15 files.
- **Fix:** `git checkout af436e9 -- <files>` restored all deleted files, then committed with `fe7da54`.
- **Files modified:** `.planning/phases/05-intent-detection-conversational-ai/`, `apps/api/src/lib/intent-classifier.service.ts`, `apps/api/src/modules/instances/__tests__/intent-classifier.service.test.ts`, `apps/api/src/modules/instances/__tests__/intent-wiring.test.ts`

**2. [Rule 3 - Blocking] @infracode/types dist not built in worktree**
- **Found during:** First test run attempt
- **Issue:** The worktree's `packages/types/` had no `dist/` folder, causing vitest to fail with "Failed to resolve entry for package @infracode/types".
- **Fix:** Built types package using tsc from `apps/api/node_modules/.bin/tsc`.
- **Files modified:** `packages/types/dist/` (generated — not committed, runtime artifact)

**3. [Rule 1 - Bug] Test approach mismatch: processConversationTurnCore does not exist**
- **Found during:** RED test run
- **Issue:** Initial test file called `processConversationTurnCore` but the private method is named `processConversationTurn`.
- **Fix:** Updated test file to call `processConversationTurn` via private access pattern.

**4. Orchestrator tests passed without implementation changes**
- **Found during:** Task 2 RED phase
- **Issue:** All 6 orchestrator tests passed immediately (no RED phase needed). The existing `orchestrator.agent.ts` fallback chain already handles all failure scenarios correctly.
- **Fix:** Added only the IA-03 comment to the explicit `return null` (required by acceptance criteria), no behavioral changes needed.

## Test Results

- `pnpm --filter api exec vitest run chatbot-fallback` → **5 passed**
- `pnpm --filter api exec vitest run orchestrator` → **6 passed**
- Full suite `pnpm --filter api exec vitest run` → **100 passed | 29 failed | 2 skipped**

The 29 pre-existing failures are:
- `run-migrations.test.ts` (6 RED stubs — another plan)
- `crm-contacts-batch.test.ts` (3 RED stubs — another plan)
- `format-phone.test.ts` (8 RED stubs — another plan)
- `lid-normalization.test.ts` (7 RED stubs — another plan)
- `instance-eventbus-wiring.test.ts` (5 failures — `prisma.conversation.create is not a function` missing from test mock — pre-existing)

No regressions introduced by this plan.

## Known Stubs

None. The honest fallback is fully wired — `HONEST_FALLBACK_MESSAGE` is sent on every null chatbotResult where session is not blocked. Part B admin notification is a real `sendAutomatedTextMessage` call gated on module config.

## Threat Flags

No new network endpoints introduced. Threat mitigations from the plan's register implemented:
- **T-5-04**: Re-check `isConversationAiBlocked` immediately before sending honest fallback — confirmed
- **T-5-09**: Client question text bounded to 300 chars in admin notification (`.slice(0, 300)`) — confirmed
- **T-5-10**: Part B only fires when `isEnabled === true && verificationStatus === "VERIFIED"` — confirmed

## Self-Check: PASSED

Files exist:
- `apps/api/src/modules/chatbot/__tests__/chatbot-fallback.test.ts` — FOUND
- `apps/api/src/modules/chatbot/agents/__tests__/orchestrator.test.ts` — FOUND
- `apps/api/src/modules/instances/service.ts` (modified) — FOUND
- `apps/api/src/modules/chatbot/agents/orchestrator.agent.ts` (modified) — FOUND

Commits verified:
- `cfd3499` — FOUND
- `fe7da54` — FOUND
- `dfb3bee` — FOUND
- `e7eb57c` — FOUND

Acceptance criteria grep checks:
- `grep "honest_fallback" service.ts` → 2 matches (action strings)
- `grep "Essa é uma ótima pergunta" service.ts` → 1 match
- `grep "honest_fallback_admin_notify" service.ts` → 1 match
- `grep "isEnabled === true" service.ts` → 8 matches (existing ESCALATE_ADMIN + new fallback gate)
- `grep "isConversationAiBlocked" service.ts` → 9 matches (entry guard + re-check in fallback)
- `grep "return null.*IA-03" orchestrator.agent.ts` → 1 match
