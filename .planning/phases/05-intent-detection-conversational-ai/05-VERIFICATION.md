---
phase: 05-intent-detection-conversational-ai
verified: 2026-04-16T17:30:00Z
status: human_needed
score: 4/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Verify IA-02 requirements alignment: REQUIREMENTS.md specifies DUVIDA_GENERICA as a required intent label, but the roadmap Plan 5.1 description and implementation use PERGUNTA + CONTINUACAO + OUTRO instead. Confirm whether IA-02 is considered satisfied by this superset, or if REQUIREMENTS.md should be updated to reflect the final label set."
    expected: "Either: (a) team accepts PERGUNTA/CONTINUACAO/OUTRO as meeting IA-02's intent for 'DUVIDA_GENERICA', OR (b) REQUIREMENTS.md is updated to use the same label names as the implementation."
    why_human: "This is a requirements/implementation naming inconsistency that requires a product/team decision. No automated check can determine intent equivalence between DUVIDA_GENERICA and PERGUNTA+CONTINUACAO+OUTRO."
  - test: "Validate SC1 end-to-end with INTENT_CLASSIFIER_V2=true and SESSION_LIFECYCLE_V2=true: send the message 'era só isso, muito obrigado' and verify the chatbot returns a graceful closing response AND the session status transitions to CONFIRMACAO_ENVIADA in Redis."
    expected: "Client receives a warm goodbye message from GeneralAgent (not a FAQ reply or the honest fallback). Redis session hash shows status=CONFIRMACAO_ENVIADA after the message is processed."
    why_human: "Feature flags are off by default. This test requires a running instance with both flags enabled. The code wiring exists but the end-to-end flow (classifyIntent → close_intent_detected → SessionLifecycleService transition + GeneralAgent response) cannot be verified statically."
  - test: "Validate SC2 end-to-end with INTENT_CLASSIFIER_V2=true: send 'quero falar com um humano' and verify the bot goes silent, admin receives a WhatsApp notification with conversation history, and humanTakeover=1 is set in Redis."
    expected: "Admin receives a WhatsApp message via sendAutomatedTextMessage with action='intent_human_handoff_alert'. Redis hash key session:{tenantId}:{instanceId}:{jid} has humanTakeover='1'. Bot does not respond to subsequent client messages."
    why_human: "Requires a running WhatsApp instance with INTENT_CLASSIFIER_V2=true and a configured adminPhone to verify the admin notification actually arrives. Redis state verification requires database inspection."
---

# Phase 5: Intent Detection & Conversational AI — Verification Report

**Phase Goal:** The chatbot reliably classifies Brazilian Portuguese conversation intent before routing — automatically triggering closure confirmations, urgency flags, and human handoffs without any regex or keyword list.
**Verified:** 2026-04-16T17:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | classifyIntent() returns a valid IntentLabel from VALID_INTENT_LABELS whitelist | VERIFIED | `apps/api/src/lib/intent-classifier.service.ts` exports `VALID_INTENT_LABELS`, whitelist guard at line 97 (`VALID_INTENT_LABELS.includes(parsed.label as IntentLabel)`) |
| 2 | classifyIntent() returns { label: 'OUTRO', confidence: 0.5 } on any LLM failure — never throws | VERIFIED | Full function body in try/catch (lines 70–110); FALLBACK constant `{ label: "OUTRO", confidence: 0.5 }` returned on null response, JSON parse failure, and thrown errors |
| 3 | When chatbotResult is null and session is not blocked, client receives honest fallback message (never silence) | VERIFIED | `service.ts` lines 4589–4657: `!chatbotResult` guard → re-checks `isConversationAiBlocked` → sends `"Essa é uma ótima pergunta!"` via `sendAutomatedTextMessage` with `action="honest_fallback"` |
| 4 | Admin notification (Part B) fires ONLY when aprendizadoContinuo isEnabled=true AND verificationStatus="VERIFIED" | VERIFIED | `service.ts` lines 4614–4617: `aprendizadoContinuoModuleForFallback?.isEnabled === true && aprendizadoContinuoModuleForFallback.verificationStatus === "VERIFIED"` gate matches existing ESCALATE_ADMIN pattern |
| 5 | IA-02 intents DUVIDA_GENERICA recognized | PARTIAL | REQUIREMENTS.md specifies `DUVIDA_GENERICA` but implementation uses `PERGUNTA + CONTINUACAO + OUTRO`. ROADMAP Plan 5.1 description itself uses `PERGUNTA, CONTINUACAO, OUTRO` — the inconsistency exists between REQUIREMENTS.md and ROADMAP.md. Functionally the label set is a superset, but the label `DUVIDA_GENERICA` does not exist in the codebase. |

**Score:** 4/5 truths verified (Truth 5 partial due to requirements naming inconsistency)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/lib/intent-classifier.service.ts` | classifyIntent() + IntentLabel + VALID_INTENT_LABELS | VERIFIED | 112 lines, substantive; exports `classifyIntent`, `IntentLabel`, `IntentClassification`, `VALID_INTENT_LABELS`; full Groq API call via injected AiCaller |
| `apps/api/src/modules/instances/conversation-session-manager.ts` | ConversationSession.lastIntentClassification optional field | VERIFIED | `lastIntentClassification?` field added at line 61 |
| `apps/api/src/modules/instances/__tests__/intent-classifier.service.test.ts` | Unit tests for IA-01 classifier label + failure fallback | VERIFIED | 67 lines; covers 7+ behavior cases (ENCERRAMENTO, TRANSFERENCIA_HUMANO, PERGUNTA, null LLM response, thrown error, invalid label, raw string) |
| `apps/api/src/lib/instance-events.ts` | SessionUrgencyDetectedEvent type in InstanceDomainEvent union | VERIFIED | `SessionUrgencyDetectedEvent` interface at line 24; added to union at line 44 |
| `apps/api/src/lib/tenant-schema.ts` | urgencyScore column in ConversationSession (idempotent ALTER TABLE) | VERIFIED | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS "urgencyScore" INTEGER DEFAULT 0` at line 289 |
| `apps/api/src/modules/instances/__tests__/intent-wiring.test.ts` | Unit tests for IA-02 + IA-06 wiring | VERIFIED | 187 lines; 7 tests covering urgency event emission, setHumanTakeover, admin notification, no-adminPhone path |
| `apps/api/src/modules/chatbot/__tests__/chatbot-fallback.test.ts` | Unit tests for IA-03/IA-04 fallback behavior | VERIFIED | 373 lines; 5 tests covering honest fallback, blocked session silence, Part B suppression, Part B activation, no-adminPhone path |
| `apps/api/src/modules/chatbot/agents/__tests__/orchestrator.test.ts` | Unit tests for OrchestratorAgent fallback chain | VERIFIED | 119 lines; 6 tests covering sub-agent throws, GeneralAgent fallback, all-agents-fail returns null |
| `apps/api/src/queues/queue-names.ts` | KNOWLEDGE_SYNTHESIS queue name constant | VERIFIED | `KNOWLEDGE_SYNTHESIS: "knowledge-synthesis"` at line 5 |
| `apps/api/src/modules/chatbot/agents/orchestrator.agent.ts` | pino structured logging, no console calls | VERIFIED | `import type pino from "pino"` at line 7; `this.logger?.debug/warn/error` throughout; zero `console.log/warn/error` calls |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `service.ts` | `intent-classifier.service.ts` | `import classifyIntent` — called in INTENT_CLASSIFIER_V2 block | VERIFIED | Import at line 55; call at line 2239 with `this.makeAiCaller(tenantId, instance)` |
| `intent-classifier.service.ts` | AiCaller (Groq) | `callAi(SYSTEM_PROMPT, messages, { temperature: 0, model: CLASSIFIER_MODEL })` | VERIFIED | Line 79; uses injected AiCaller — `makeAiCaller` in service.ts builds real Groq fetch at line 5201 |
| `service.ts` | `instance-events.ts` | `this.eventBus.emit('session.urgency_detected', ...)` for URGENCIA_ALTA | VERIFIED | Line 2261 emits with `urgencyScore: 80` |
| `service.ts` | Redis (humanTakeover) | `this.redis.hset('session:tenantId:instanceId:remoteJid', { humanTakeover: '1' })` | VERIFIED | Lines 2285–2288; JID validated against `VALID_JID_PATTERN` before HSET |
| `service.ts` (honest fallback) | `getAprendizadoContinuoModuleConfig` | `aprendizadoContinuoModule?.isEnabled === true` module gate | VERIFIED | Lines 4614–4617; gate present in both null chatbotResult path and ESCALATE_ADMIN path |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `classifyIntent()` | LLM response → `IntentClassification` | Groq API via injected `AiCaller` (real fetch at `makeAiCaller` line 5201) | Yes — Groq API call with proper auth, model, temperature; response parsed; fallback on null/error | FLOWING |
| `honest_fallback` path | `chatbotResult` | `this.conversationAgent.reply()` result (null = no AI match) | Yes — null chatbotResult triggers real `sendAutomatedTextMessage` call | FLOWING |
| `URGENCIA_ALTA` path | `urgencyScore: 80` | Hardcoded constant after LLM classification | Hardcoded score (not dynamic) | STATIC (by design — IA-02 defines URGENCIA_ALTA as score 80; URG-01 full scoring is Phase 8) |

### Behavioral Spot-Checks

Step 7b: SKIPPED for full end-to-end scenarios requiring a running WhatsApp instance. Static code verification performed instead.

| Behavior | Check | Result | Status |
|----------|-------|--------|--------|
| classifyIntent returns FALLBACK on null LLM response | Code path: `if (!response) return FALLBACK` at line 84 | Code path verified | PASS (static) |
| fire-and-forget void calls eliminated | `grep "void this.chatbotService"` in service.ts | Zero matches | PASS |
| OrchestratorAgent has no console calls | `grep "console\."` in orchestrator.agent.ts | Zero matches | PASS |
| KNOWLEDGE_SYNTHESIS constant exists | `grep "KNOWLEDGE_SYNTHESIS"` in queue-names.ts | 1 match at line 5 | PASS |
| Honest fallback text exact match | `grep "Essa é uma ótima pergunta"` in service.ts | 1 match at line 4600 | PASS |
| T-5-01 delimiter in classifyIntent | `grep "<message>"` in intent-classifier.service.ts | Match at line 72 | PASS |
| INTENT_CLASSIFIER_V2 feature flag | `grep "INTENT_CLASSIFIER_V2"` in service.ts | 2 matches (flag check + comment) | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| IA-01 | Plans 5.1, 5.2 | LLM-based intent classifier for pt-BR (pre-pass before chatbot) | SATISFIED | `classifyIntent()` with Groq llama-3.1-8b-instant; wired behind `INTENT_CLASSIFIER_V2` flag |
| IA-02 | Plans 5.1, 5.2 | Intents: ENCERRAMENTO, TRANSFERENCIA_HUMANO, URGENCIA_ALTA, DUVIDA_GENERICA | PARTIAL | Three of four exact labels implemented (ENCERRAMENTO, URGENCIA_ALTA, TRANSFERENCIA_HUMANO). `DUVIDA_GENERICA` replaced by `PERGUNTA + CONTINUACAO + OUTRO` — a superset. ROADMAP Plan 5.1 description itself lists this same superset. Requires human decision on naming (see Human Verification). |
| IA-03 | Plans 5.3, 5.4 | Chatbot never stalls — always responds or informs | SATISFIED | Honest fallback sends message when `chatbotResult` is null; OrchestratorAgent fallback chain ensures `process()` always returns `string \| null`; `return null` at line 68 with IA-03 comment |
| IA-04 | Plan 5.3 | When bot cannot answer: informs client clearly AND (if module active) escalates to admin | SATISFIED | Part A `sendAutomatedTextMessage` always fires; Part B gated on `isEnabled === true && verificationStatus === "VERIFIED"`; admin notification includes client question text (`.slice(0, 300)`) |
| IA-05 | Plan 5.4 | Non-linear flow: adapts to context, no rigid script | SATISFIED | Four `void fire-and-forget` calls replaced with `setImmediate` + error-observable callbacks; OrchestratorAgent fallback chain handles sub-agent failures without stalling; no silent pipeline failures |
| IA-06 | Plan 5.2 | Human handoff via intent detected OR admin command — admin notified via WhatsApp | SATISFIED | `TRANSFERENCIA_HUMANO` → `redis.hset humanTakeover='1'` + `sendAutomatedTextMessage` with `action='intent_human_handoff_alert'` and conversation summary (10 msgs × 120 chars); uses echo-safe method (T-5-03) |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `service.ts` (multiple) | `console.warn` used in intent/honest-fallback blocks instead of structured logger | INFO | Deferred by Plan 5.4 (service.ts has no pino logger instance). Errors are observable but unstructured. No impact on functionality. |
| `service.ts` line 2267 | `urgencyScore: 80` hardcoded constant | INFO | By design — full URG-01 scoring is deferred to Phase 8. Score is not calculated from signal analysis, just from the URGENCIA_ALTA label. Not a stub — it's the defined Phase 5 value. |
| `service.ts` | `INTENT_CLASSIFIER_V2` defaults to `false` | INFO | LLM classifier path requires opt-in. Regex fallback is the production default. This is intentional (staging validation required per ROADMAP research flags). |

### Human Verification Required

#### 1. IA-02 Requirements Naming Alignment

**Test:** Review whether `DUVIDA_GENERICA` (specified in `REQUIREMENTS.md` IA-02) is considered satisfied by the implementation's `PERGUNTA + CONTINUACAO + OUTRO` label set.

**Expected:** Either update REQUIREMENTS.md to reflect `PERGUNTA, CONTINUACAO, OUTRO` (and remove `DUVIDA_GENERICA`) or confirm the intent is functionally equivalent and mark IA-02 as satisfied. The ROADMAP's own Plan 5.1 description already uses `PERGUNTA, CONTINUACAO, OUTRO`.

**Why human:** This is a product/requirements decision, not a code bug. No automated check can determine whether `DUVIDA_GENERICA` ≡ `PERGUNTA + CONTINUACAO + OUTRO` for business purposes.

#### 2. SC1 — Graceful Closing Response End-to-End

**Test:** With `INTENT_CLASSIFIER_V2=true` and `SESSION_LIFECYCLE_V2=true`, send "era só isso, muito obrigado" to the chatbot.

**Expected:** Client receives a warm closing message from GeneralAgent (not the honest fallback, not silence). Redis session hash shows `status=CONFIRMACAO_ENVIADA`.

**Why human:** Requires running WhatsApp instance with both feature flags enabled. The code wiring is verified statically but the end-to-end flow (classifyIntent → event emission → SessionLifecycleService status transition + GeneralAgent producing a closing response) cannot be validated without a live test.

#### 3. SC2 — Human Handoff End-to-End

**Test:** With `INTENT_CLASSIFIER_V2=true`, send "quero falar com um humano" to the chatbot.

**Expected:** Bot goes silent (humanTakeover=1 in Redis). Admin receives a WhatsApp notification via `sendAutomatedTextMessage` containing the last conversation exchanges with action `intent_human_handoff_alert`.

**Why human:** Requires a running instance, configured admin phone, and direct Redis/WhatsApp observation. The code wiring is verified but the admin notification delivery and humanTakeover persistence require live validation.

### Gaps Summary

No hard blocking gaps were found — all required artifacts exist, are substantive, and are properly wired. The phase deliverables are functionally complete.

The IA-02 naming inconsistency (DUVIDA_GENERICA vs PERGUNTA/CONTINUACAO/OUTRO) is the only unresolved item. It is a naming alignment question between `REQUIREMENTS.md` and the implementation; functionally the intent coverage is a superset of what IA-02 requires. No routing logic depends on the `DUVIDA_GENERICA` label name anywhere in the codebase.

Feature flags (`INTENT_CLASSIFIER_V2`, `SESSION_LIFECYCLE_V2`) both default to `false`. This is intentional — the ROADMAP specifies staging validation before production enablement. The infrastructure is complete; activation requires these environment variables to be set.

---

_Verified: 2026-04-16T17:30:00Z_
_Verifier: Claude (gsd-verifier)_
