# Phase 5: Intent Detection & Conversational AI - Research

**Researched:** 2026-04-15
**Domain:** LLM intent classification, session state machine wiring, conversational fallback patterns, BullMQ job reliability
**Confidence:** HIGH

---

## Summary

Phase 5 builds on top of Phase 4's `SessionLifecycleService`, `InstanceEventBus`, and `ConversationSessionManager`. The key insight from reading the codebase is that **most of the plumbing already exists**: Phase 4 left deliberate stubs — `session-intents.ts::recognizeCloseIntent` (regex-based, marked for replacement), `InstanceOrchestrator` already emits `session.close_intent_detected` when a closure phrase is detected, and `SessionLifecycleService` already subscribes to that event and transitions to `CONFIRMACAO_ENVIADA`. Phase 5's job is to replace the static keyword list with an LLM pre-pass, wire the remaining intents (`URGENCIA_ALTA`, `TRANSFERENCIA_HUMANO`) through `InstanceEventBus`, and harden the fallback paths.

The existing `IntentRouter` inside `OrchestratorAgent` already classifies `HANDOFF` (maps to `[TRANSBORDO_HUMANO]`) and `ESCALATE` (maps to admin notification). Phase 5's new `IntentClassifierService` is a **pre-pass upstream of** `ConversationAgent.reply()` — it runs before chatbot evaluation and feeds session state, not conversation routing. These are complementary, not competing classifiers. The pre-pass uses the same Groq infrastructure (`GroqKeyRotator`, `callAiWithFallback` pattern, `llama-3.1-8b-instant` model) already established in Phase 4.

The `GeneralAgent` fallback path is already wired but currently returns `null` on complete failure (line 4337 area of `service.ts`). The "graceful I don't know" response (Plan 5.3) requires checking the `evaluateConfig` path — when `chatbotResult` is `null`, the orchestrator currently sends nothing. That silent null must become an honest client message. The `aprendizadoContinuo` module gating for admin notification must follow the existing `getAprendizadoContinuoModuleConfig(...)` pattern — never assume module is enabled.

**Primary recommendation:** Implement `IntentClassifierService` as a pure function over `AgentContext` (no new class construction needed, reuse existing `callAi` caller), replace `recognizeCloseIntent` in `session-intents.ts` with the LLM classifier, and wire the new intents through the existing `InstanceEventBus` event types — extending `InstanceDomainEvent` to add `URGENCIA_ALTA` and human handoff events as needed.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| IA-01 | Classificador de intenção via LLM (pré-processamento antes do chatbot principal) para pt-BR | `IntentClassifierService` replaces `session-intents.ts` regex stub; runs before `ConversationAgent.reply()` |
| IA-02 | Intenções reconhecidas: ENCERRAMENTO, TRANSFERENCIA_HUMANO, URGENCIA_ALTA, DUVIDA_GENERICA | New label set distinct from `IntentRouter`'s GENERAL/FAQ/ESCALATE/SCHEDULE/HANDOFF |
| IA-03 | Chatbot não trava em situações inesperadas | `processConversationTurn` null result path + `OrchestratorAgent` fallback chain |
| IA-04 | Quando não sabe a resposta: informa cliente e (se módulo ativo) escala ao admin | `evaluateConfig` null/NO_MATCH path → honest message; `aprendizadoContinuo` module gate |
| IA-05 | Conversa não linear: fluxo adapta-se ao contexto, não segue script fixo rígido | `OrchestratorAgent` fallback branches; void fire-and-forget → BullMQ jobs |
| IA-06 | Transferência para humano via intenção detectada ou comando admin — notifica admin via WhatsApp | TRANSFERENCIA_HUMANO intent → `humanTakeover: true` in DB + admin WhatsApp notification |
</phase_requirements>

---

## Standard Stack

### Core (already in project — no new installs required)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Groq API (via `fetch`) | — | LLM inference for intent classification | Already used via `callAiWithFallback`; `GroqKeyRotator` handles key rotation and 429 backoff |
| `llama-3.1-8b-instant` | Groq-hosted | Router/classifier model | Already used in `IntentRouter`; ~80ms latency, high TPM on free tier |
| `llama-3.3-70b-versatile` | Groq-hosted | Specialist response generation | Already used in all specialist agents |
| BullMQ | ^5.x | Reliable async job queuing | Already in project; `SESSION_TIMEOUT` queue established in Phase 4 |
| pino | Already in project | Structured logging | Phase 4 standardized on pino — all new services must use it |

[VERIFIED: codebase grep — all libraries confirmed present]

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Raw `fetch` to Groq | `groq-sdk` npm package | SDK adds ~350KB, fetch already works with key rotation; no benefit |
| New `IntentClassifier` class | Extend `IntentRouter` | `IntentRouter` is inside chatbot pipeline; pre-pass must be upstream of chatbot — separate service is cleaner |
| BullMQ for all fire-and-forgets | `setImmediate` | BullMQ survives restarts; `setImmediate` is in-process only — use BullMQ for message sends, `setImmediate` for deferred writes (Phase 6 pattern) |

**Installation:** No new packages required. Phase 5 reuses existing dependencies.

---

## Architecture Patterns

### Recommended Project Structure

New files for Phase 5:

```
apps/api/src/lib/
  intent-classifier.service.ts     # Plan 5.1 — replaces session-intents.ts stub

apps/api/src/lib/
  session-intents.ts               # MODIFIED: replace recognizeCloseIntent with LLM call

apps/api/src/modules/instances/
  __tests__/
    intent-classifier.service.test.ts
    intent-wiring.test.ts
```

No new top-level modules. `IntentClassifierService` belongs in `src/lib/` alongside `instance-events.ts` and `session-intents.ts` — it is a shared utility, not a module-scoped service.

### Pattern 1: IntentClassifierService as Stateless Async Function

The new pre-pass classifier does not need to be a class with constructor injection. It needs:
- `callAi: AiCaller` (already injected into `AgentContext`)
- `text: string` (the raw message)
- Returns a discriminated union: `{ label: IntentLabel; confidence: number }`

```typescript
// Source: [ASSUMED] — pattern consistent with IntentRouter in intent-router.ts
export type IntentLabel =
  | 'ENCERRAMENTO'
  | 'URGENCIA_ALTA'
  | 'TRANSFERENCIA_HUMANO'
  | 'PERGUNTA'
  | 'CONTINUACAO'
  | 'OUTRO';

export interface IntentClassification {
  label: IntentLabel;
  confidence: number;
}

export async function classifyIntent(
  text: string,
  callAi: AiCaller
): Promise<IntentClassification> {
  // single LLM call, temperature: 0, model: llama-3.1-8b-instant
  // prompt: "Classify the following Brazilian Portuguese message into exactly one of:
  //          ENCERRAMENTO, URGENCIA_ALTA, TRANSFERENCIA_HUMANO, PERGUNTA, CONTINUACAO, OUTRO.
  //          Reply with ONLY the label."
  // parse response; fallback to { label: 'OUTRO', confidence: 0.5 } on error
}
```

**Why stateless function:** `IntentRouter` (the existing chatbot-internal classifier) is already a class because it needs module config. The pre-pass has no constructor dependencies — a function is simpler and easier to test.

### Pattern 2: Caching in ConversationSession Context

Do NOT re-classify the same message. The cache location:

```typescript
// ConversationSession in conversation-session-manager.ts already has a history field.
// Phase 5 adds a lastIntentClassification field to the in-memory session object.
// This is ephemeral — does not need Redis persistence (intent is per-message, not per-session).

interface ConversationSession {
  history: ChatMessage[];
  leadAlreadySent: boolean;
  // Add:
  lastIntentClassification?: { text: string; label: IntentLabel; confidence: number };
}
```

[VERIFIED: conversation-session-manager.ts line 10-18 — ConversationSession interface is in this file and can be extended]

### Pattern 3: InstanceEventBus Extension for New Intents

The current `InstanceDomainEvent` union (Phase 4) covers `session.activity`, `session.close_intent_detected`, and `admin.command`. Phase 5 needs at minimum:

- `session.close_intent_detected` — already exists, already subscribed in `SessionLifecycleService`. Phase 5 **replaces the emit source** (from regex to LLM) but keeps the event shape.
- For `URGENCIA_ALTA`: emit `session.urgency_detected` (new event type) — consumer in Phase 5 sets urgency score on `ConversationSession` in Redis; Phase 6 surfaces it.
- For `TRANSFERENCIA_HUMANO` intent (vs. `HANDOFF` marker from `OrchestratorAgent`): the chatbot pipeline already handles `[TRANSBORDO_HUMANO]` marker → `HUMAN_HANDOFF` action → `humanTakeover: true` in Conversation table + admin notification (lines 4181-4202 of `service.ts`). The pre-pass LLM detection should reuse **this same path** — emit `session.close_intent_detected` with `intentLabel: 'TRANSFERENCIA_HUMANO'` **or** directly call the existing handoff path.

```typescript
// Extend InstanceDomainEvent in instance-events.ts:
export interface SessionUrgencyDetectedEvent {
  type: 'session.urgency_detected';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  urgencyScore: number; // 80 for URGENCIA_ALTA from intent
}

export type InstanceDomainEvent =
  | SessionActivityEvent
  | SessionCloseIntentEvent
  | SessionUrgencyDetectedEvent  // NEW
  | AdminCommandEvent;
```

[VERIFIED: instance-events.ts — current union shape; extension follows established pattern]

### Pattern 4: Graceful "I Don't Know" Response Path

The null/silent path in `processConversationTurn`:

```typescript
// service.ts line 4165: chatbotResult = await this.conversationAgent.reply(...)
// service.ts lines 2337-2338: if (!responseText) { return null; }  ← this propagates up
// After evaluateInbound returns null, processConversationTurn does nothing — client sees silence

// Fix: in evaluateConfig (service.ts), when the AI path produces null/empty responseText,
// return an honest fallback instead of returning null:
const HONEST_FALLBACK = "Essa é uma ótima pergunta! Não tenho essa informação no momento. Vou verificar com nossa equipe e retorno em breve.";

if (!responseText) {
  // Trigger admin notification if aprendizadoContinuo is enabled (Part B)
  // Return client-facing message regardless (Part A — always fires)
  return {
    action: 'AI',
    matchedRuleId: null,
    matchedRuleName: 'fallback:honest',
    responseText: HONEST_FALLBACK,
  };
}
```

[VERIFIED: service.ts lines 2337-2342, 2431-2443 — null return path confirmed]

### Pattern 5: aprendizadoContinuo Module Gate

The admin notification in Plan 5.3 MUST follow the existing module check pattern:

```typescript
// Source: [VERIFIED] service.ts line 2054 — exact pattern to follow
const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(sanitizedChatbotModules);
if (aprendizadoContinuoModule?.isEnabled === true) {
  // Part B: notify admin with structured question context
}
// Part A always fires (no module check needed)
```

Never use `module?.isEnabled` without the `=== true` guard — the existing code uses explicit triple-equals everywhere.

### Pattern 6: Where IntentClassifierService Runs in the Pipeline

The call order in `processConversationTurn` (service.ts line 4039+):

```
1. isConversationAiBlocked check
2. memoryAgent.getContext()
3. fiadoAgent.process() → short-circuit if fiado response
4. ConversationAgent.reply() → evaluateInbound → evaluateConfig → OrchestratorAgent
   ↑ IntentRouter runs INSIDE here (chatbot-level routing)

NEW: IntentClassifierService pre-pass runs BEFORE step 4, AFTER step 3
     It reads rawTextInput (available as params.inputText at this point)
     It emits events via eventBus (already available in InstanceOrchestrator)
     The session intent result is cached in the ConversationSession object
```

**Critical constraint:** The pre-pass result must NOT block the chatbot pipeline. If the LLM classifier fails, the chatbot continues normally. The pre-pass is fire-and-observe, not fire-and-gate.

For `ENCERRAMENTO` and `TRANSFERENCIA_HUMANO`: the intent pre-pass should emit the event AND the chatbot pipeline should also detect them (via `recognizeCloseIntent` stub replacement and `[TRANSBORDO_HUMANO]` marker respectively). Two detection paths is fine — `SessionLifecycleService` handles duplicate close intents gracefully (it checks state before acting).

### Anti-Patterns to Avoid

- **Replacing `IntentRouter` with `IntentClassifierService`:** They serve different purposes. `IntentRouter` routes the chatbot to specialized agents (FAQ, SCHEDULE, etc.). `IntentClassifierService` drives session state transitions. Keep both.
- **Blocking chatbot on classifier failure:** The pre-pass must have a `try/catch` that falls back to `OUTRO` — never propagates errors to the chatbot pipeline.
- **Hardcoding intent labels in `IntentRouter`:** The pre-pass adds new intents (`ENCERRAMENTO`, `URGENCIA_ALTA`) that are orthogonal to `IntentRouter`'s intent vocabulary. Do not merge the two label sets.
- **Notifying admin when `aprendizadoContinuo` is disabled:** Check the module config explicitly. The roadmap rule: "Module disabled = Part A only, never Part B."
- **Setting `humanTakeover` directly in `ConversationSession` PostgreSQL table without going through `SessionStateService`:** All session state writes must use `SessionStateService` to keep Redis and PostgreSQL in sync (Phase 4 pattern).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LLM key rotation | Manual retry logic | `GroqKeyRotator` (already exists in `src/lib/groq-key-rotator.ts`) | Handles 429 backoff, key blacklisting, multiple keys — already battle-tested in Phase 4 |
| Groq API calls | New HTTP client | `callAiWithFallback` in `ChatbotService` + pass `callAi: AiCaller` via `AgentContext` | All API calls must go through the key rotator to respect rate limits |
| JSON parsing from LLM | Regex only | Pattern from `IntentRouter`: `const match = /\{[\s\S]*?\}/.exec(response)` | LLM output is unreliable; always extract JSON with regex fallback |
| Module enable/disable checks | Custom guard | `getAprendizadoContinuoModuleConfig(modules)?.isEnabled === true` | Consistent with all existing module checks; null-safe |
| Admin WhatsApp notification | New send method | `sendAutomatedTextMessage()` already in `InstanceOrchestrator` | Registers echo ignore key to prevent re-processing as inbound message |

**Key insight:** The Groq key rotation infrastructure (`GroqKeyRotator`) must be used for ALL Groq calls. The pre-pass classifier runs 1 LLM call per inbound message — at scale, this will hit rate limits without rotation.

---

## Common Pitfalls

### Pitfall 1: Double-Emitting Close Intent
**What goes wrong:** `recognizeCloseIntent` in `session-intents.ts` still runs at line 2226 of `service.ts`. Phase 5 adds a pre-pass LLM classifier that also emits `session.close_intent_detected`. Result: two events emitted for one message, session transitions happen twice.
**Why it happens:** Phase 4 left the regex stub in place as a placeholder. Phase 5 must replace it, not add to it.
**How to avoid:** When `IntentClassifierService` is wired in, remove (or disable via feature flag) the `recognizeCloseIntent` call at line 2226 of `service.ts`. Do not run both simultaneously.
**Warning signs:** Session transitions to `CONFIRMACAO_ENVIADA` twice for the same message; `SessionLifecycleService` logs show two `close_intent_detected` events.

### Pitfall 2: Pre-pass Classifier Adds Latency to EVERY Message
**What goes wrong:** Every inbound client message incurs an extra ~80ms Groq API call before chatbot evaluation. Under load, this doubles time-to-first-response.
**Why it happens:** `IntentClassifierService` is invoked synchronously in the message pipeline.
**How to avoid:** (a) Run classification concurrently with memory context fetch (`memoryAgent.getContext()`). (b) Cache result in session to avoid re-classification on retries. (c) Use `llama-3.1-8b-instant` (lowest latency model on Groq). (d) If classification fails, continue — do not await a retry.
**Warning signs:** Average response time increases by >100ms after Phase 5 deployment.

### Pitfall 3: TRANSFERENCIA_HUMANO Intent Does Not Persist humanTakeover
**What goes wrong:** Intent pre-pass emits an event, `SessionLifecycleService` handles it, but `humanTakeover` in the `Conversation` PostgreSQL table is not set. After restart, bot resumes responding to that client.
**Why it happens:** The existing `HUMAN_HANDOFF` flow (lines 4181-4202) sets `paused_by_human` tag in `clientMemory` but the Phase 4 `humanTakeover` in `ConversationSession` table may be separate.
**How to avoid:** When `TRANSFERENCIA_HUMANO` is detected, call the SAME code path as `HUMAN_HANDOFF`: `clientMemoryService.upsert` with `paused_by_human` tag AND update `Conversation.humanTakeover = true` in PostgreSQL via `SessionStateService.setHumanTakeover()`.
**Warning signs:** Bot responds to client after API restart following a TRANSFERENCIA_HUMANO intent.

### Pitfall 4: Admin Notification Without Conversation Summary
**What goes wrong:** Plan 5.2 says "notify admin via WhatsApp with conversation summary" on `TRANSFERENCIA_HUMANO`. The existing `HUMAN_HANDOFF` path (line 4198) sends a hardcoded string without conversation history.
**Why it happens:** `formulateEscalationQuestionForAdmin` exists but is used for escalation, not handoff summaries.
**How to avoid:** For the Phase 5 `TRANSFERENCIA_HUMANO` path, build the summary using the session history already available in `ConversationSession.history`. Limit to last 5 exchanges. Use `formulateEscalationQuestionForAdmin` as a template.
**Warning signs:** Admin receives "Transbordo solicitado" with no context about why.

### Pitfall 5: "I Don't Know" Fallback Fires on EVERY Null Response
**What goes wrong:** The honest fallback message fires when the chatbot pipeline returns null for ANY reason — including anti-spam blocks, humanTakeover, or disabled chatbot. Client receives "Vou verificar com a equipe" even when the bot was intentionally silent.
**Why it happens:** The null check in `processConversationTurn` is a catch-all.
**How to avoid:** Distinguish between "intentionally silent" null (humanTakeover, anti-spam) and "AI failure" null. Only fire the honest fallback when `chatbotResult === null` AND `!isConversationAiBlocked`. Check `evaluateInbound` returns `null` specifically because `config.isEnabled` is false vs. because the AI failed — add return codes.
**Warning signs:** Clients receive "Vou verificar" messages during humanTakeover.

### Pitfall 6: pt-BR ENCERRAMENTO Accuracy — Staging Validation Required
**What goes wrong:** The LLM classifier misclassifies messages as `ENCERRAMENTO` when client is just being polite ("obrigado" mid-conversation) or vice versa.
**Why it happens:** Brazilian Portuguese uses "obrigado" in both closure contexts and mid-conversation acknowledgements.
**How to avoid:** The roadmap explicitly flags this: "Validate with at least 50 real Brazilian closure expressions in staging before enabling in production." Build a feature flag `INTENT_CLASSIFIER_V2=true` so production can stay on the regex stub while staging validates the LLM classifier. The LLM prompt must include conversational context (last 3 exchanges), not just the current message.
**Warning signs:** Sessions entering `CONFIRMACAO_ENVIADA` in the middle of active service conversations.

---

## Code Examples

### LLM Classifier Prompt Pattern

```typescript
// Source: [VERIFIED] intent-router.ts line 59-92 — established pattern in this codebase
const systemPrompt = [
  "Você é um classificador de intenção para chatbot de WhatsApp em português do Brasil.",
  "Analise a ÚLTIMA mensagem do cliente considerando o contexto das mensagens anteriores.",
  "Classifique em EXATAMENTE uma das categorias:",
  "- ENCERRAMENTO: cliente quer encerrar (obrigado/tchau/era só isso/pode fechar/finalizado)",
  "- URGENCIA_ALTA: situação urgente, pressão de tempo, problema crítico",
  "- TRANSFERENCIA_HUMANO: cliente pede explicitamente para falar com humano/atendente",
  "- PERGUNTA: dúvida ou pergunta sobre produto/serviço",
  "- CONTINUACAO: resposta a uma pergunta anterior, confirmação ou continuação natural",
  "- OUTRO: qualquer outra coisa",
  "",
  "REGRAS:",
  "- 'obrigado' isolado no meio de conversa ativa → CONTINUACAO, não ENCERRAMENTO",
  "- 'obrigado' após resolver o que o cliente veio buscar → ENCERRAMENTO",
  "- Use o contexto das últimas mensagens para decidir",
  "",
  'Retorne APENAS JSON válido: {"label":"ENCERRAMENTO","confidence":0.92}'
].join("\n");
```

### Event Bus Extension Pattern

```typescript
// Source: [VERIFIED] instance-events.ts — extend the existing union
export interface SessionUrgencyDetectedEvent {
  type: 'session.urgency_detected';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  urgencyScore: number;
}

// Add to InstanceDomainEvent union and add typed overloads to InstanceEventBus class
```

### aprendizadoContinuo Module Gate Pattern

```typescript
// Source: [VERIFIED] service.ts line 2054 — exact pattern used throughout codebase
const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(sanitizedChatbotModules);
const shouldNotifyAdmin = aprendizadoContinuoModule?.isEnabled === true;

// Part A — always fires:
const clientResponse = HONEST_FALLBACK_MESSAGE;

// Part B — only if module active:
if (shouldNotifyAdmin && adminPhone) {
  await this.sendAutomatedTextMessage(
    tenantId, instanceId, adminPhone, adminJid,
    formattedEscalationQuestion,
    { action: "bot_unknown_escalation", kind: "chatbot" }
  );
}
```

### Replacing recognizeCloseIntent with LLM Classifier

```typescript
// Source: [VERIFIED] session-intents.ts — current stub to replace
// Current (line 2226 of service.ts):
if (rawTextInput && recognizeCloseIntent(rawTextInput)) {
  this.eventBus.emit('session.close_intent_detected', { ... });
}

// Phase 5 replacement:
// 1. Remove the recognizeCloseIntent call at service.ts line 2226
// 2. Move close intent detection to IntentClassifierService pre-pass
// 3. Keep session-intents.ts as fallback for test environments (or delete file)
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Regex keyword list (`session-intents.ts`) | Groq LLM pre-pass classifier | Phase 5 | Handles paraphrases, context-aware closure detection |
| Hard-coded `recognizeCloseIntent` in `service.ts` | `IntentClassifierService` emitting domain events | Phase 5 | Decoupled — lifecycle service reacts via event, not direct call |
| Silent null response when AI fails | Honest client-facing fallback message | Phase 5 | Client never sees silence; IA-03/IA-04 requirements met |
| Fire-and-forget void calls for background work | BullMQ jobs for message sends | Phase 5 | Survives restarts, observable, retryable |

**Deprecated/outdated after Phase 5:**
- `session-intents.ts` `recognizeCloseIntent` static phrase list: replaced by LLM classification. The file can be deleted or kept as a testing fallback.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `IntentClassifierService` should be a stateless function, not a class | Architecture Patterns | If it needs constructor deps (e.g., logger injection), it becomes a class — planner should decide |
| A2 | `URGENCIA_ALTA` intent should set urgency score on `ConversationSession` (in-memory + Redis) rather than a separate DB table | Architecture Patterns | Phase 6 expects an `urgencyScore` field; if the schema doesn't have it yet, Wave 0 must add it |
| A3 | The `TRANSFERENCIA_HUMANO` intent pre-pass should reuse the existing `HUMAN_HANDOFF` action path rather than creating a parallel flow | Architecture Patterns | If they have different behaviors, two separate paths are needed — verify with existing `humanTakeover` logic |
| A4 | No new npm packages are required for Phase 5 | Standard Stack | If `groq-sdk` is preferred over raw fetch for new code, package.json changes needed |

---

## Open Questions

1. **sessionId placeholder in InstanceEventBus events**
   - What we know: Phase 4 emits events with `sessionId: ''` (placeholder, line 2223 of `service.ts`)
   - What's unclear: Phase 5 needs the real sessionId to properly scope `URGENCIA_ALTA` and `ENCERRAMENTO` events
   - Recommendation: Wave 0 of Phase 5 must resolve the sessionId — either from `ConversationSession` key in `ConversationSessionManager` or from `SessionStateService.getSessionState()`. The sessionId must be a deterministic key like `${tenantId}:${instanceId}:${remoteJid}`.

2. **ConversationSession urgencyScore field**
   - What we know: Phase 5 plan says "set urgency score on `ConversationSession`"; the Prisma schema for `ConversationSession` table was added in Phase 4 via `buildTenantSchemaSql`
   - What's unclear: Whether `urgencyScore` column was included in the Phase 4 schema or needs to be added in Phase 5
   - Recommendation: Read `tenant-schema.ts` in Wave 0 to confirm column existence. If missing, add via migration in Plan 5.2 Wave 0.

3. **Feature flag name for LLM classifier**
   - What we know: Roadmap says "validate with 50+ real expressions in staging before enabling in production"; Phase 4 used `SESSION_LIFECYCLE_V2=true` pattern
   - What's unclear: Whether to use an env var flag (`INTENT_CLASSIFIER_V2=true`) or the existing tenant `modules` config
   - Recommendation: Use `INTENT_CLASSIFIER_V2=true` env var (same pattern as `SESSION_LIFECYCLE_V2`) so it's an infrastructure flag, not per-tenant config. All tenants on the instance see the same classifier version.

---

## Environment Availability

Step 2.6: SKIPPED (Phase 5 is code-only changes — no new external services or CLI tools required beyond what's already running in the project)

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 3.2.4 |
| Config file | `apps/api/vitest.config.ts` (minimal — uses `test/setup.ts`) |
| Quick run command | `pnpm --filter api test` |
| Full suite command | `pnpm --filter api test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IA-01 | `classifyIntent()` returns correct label for pt-BR closure phrases | unit | `pnpm --filter api test -- intent-classifier` | ❌ Wave 0 |
| IA-01 | `classifyIntent()` returns `OUTRO` on LLM failure | unit | `pnpm --filter api test -- intent-classifier` | ❌ Wave 0 |
| IA-02 | `ENCERRAMENTO` intent emits `session.close_intent_detected` via eventBus | unit | `pnpm --filter api test -- intent-wiring` | ❌ Wave 0 |
| IA-02 | `URGENCIA_ALTA` intent emits `session.urgency_detected` event | unit | `pnpm --filter api test -- intent-wiring` | ❌ Wave 0 |
| IA-02 | `TRANSFERENCIA_HUMANO` sets `humanTakeover: true` and sends admin notification | unit | `pnpm --filter api test -- intent-wiring` | ❌ Wave 0 |
| IA-03 | `OrchestratorAgent.process()` never returns undefined — always string or null | unit | `pnpm --filter api test -- orchestrator` | ❌ Wave 0 |
| IA-04 | `evaluateInbound` returning null results in honest fallback message to client | unit | `pnpm --filter api test -- chatbot-fallback` | ❌ Wave 0 |
| IA-04 | Admin NOT notified when `aprendizadoContinuo` is disabled | unit | `pnpm --filter api test -- chatbot-fallback` | ❌ Wave 0 |
| IA-05 | Sub-agent failure causes `GeneralAgent` fallback, not silence | unit | `pnpm --filter api test -- orchestrator` | ❌ Wave 0 |
| IA-06 | Human handoff notifies admin with conversation summary text | unit | `pnpm --filter api test -- intent-wiring` | ❌ Wave 0 |
| SESS-09 | `recognizeCloseIntent` replaced — LLM classifier is the single source | integration | Manual (staging, 50 phrases) | N/A |

### Sampling Rate

- **Per task commit:** `pnpm --filter api test`
- **Per wave merge:** `pnpm --filter api test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `apps/api/src/modules/instances/__tests__/intent-classifier.service.test.ts` — covers IA-01
- [ ] `apps/api/src/modules/instances/__tests__/intent-wiring.test.ts` — covers IA-02, IA-06
- [ ] `apps/api/src/modules/chatbot/__tests__/chatbot-fallback.test.ts` — covers IA-03, IA-04
- [ ] `apps/api/src/modules/chatbot/agents/__tests__/orchestrator.test.ts` — covers IA-05 (check if exists first)

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | n/a |
| V3 Session Management | yes | Session state via `SessionStateService` — never update session state directly, always go through the service |
| V4 Access Control | yes | Admin notification path: must verify `isAdminOrInstanceSender` before trusting admin context |
| V5 Input Validation | yes | LLM response must be validated against `VALID_INTENT_LABELS` before using — never trust raw LLM output as intent label |
| V6 Cryptography | no | n/a |

### Known Threat Patterns for Groq LLM Pre-pass

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection via client message | Tampering | Wrap client message in delimiters: `<message>{text}</message>` — never interpolate directly into the prompt without isolation |
| LLM hallucinating non-existent intent label | Tampering | Validate label against `VALID_INTENT_LABELS` whitelist before acting; fallback to `OUTRO` |
| Rate limit exhaustion causing all Groq keys to go cold | DoS | `GroqKeyRotator` handles this; pre-pass should fail silently to `OUTRO` if all keys are on cooldown — never block the pipeline |
| Admin notification loop | Elevation of Privilege | `sendAutomatedTextMessage` already handles echo-ignore via `rememberAutomatedOutboundEcho` — must use this method, not raw `sendMessage` |

---

## Sources

### Primary (HIGH confidence)

- [VERIFIED: codebase] `apps/api/src/modules/chatbot/agents/intent-router.ts` — existing classifier pattern, model selection, JSON extraction
- [VERIFIED: codebase] `apps/api/src/lib/instance-events.ts` — InstanceEventBus type signatures and domain event union
- [VERIFIED: codebase] `apps/api/src/lib/session-intents.ts` — stub to replace, exact file to modify
- [VERIFIED: codebase] `apps/api/src/modules/instances/session-lifecycle.service.ts` — Phase 4 subscription to `session.close_intent_detected` already implemented
- [VERIFIED: codebase] `apps/api/src/modules/chatbot/service.ts` lines 2337-2443 — null response path and fallback handling
- [VERIFIED: codebase] `apps/api/src/modules/instances/service.ts` lines 2214-2236 — existing close intent detection and event emission (stub to replace)
- [VERIFIED: codebase] `apps/api/src/modules/instances/service.ts` lines 4165-4202 — `HUMAN_HANDOFF` action path (reuse for TRANSFERENCIA_HUMANO)
- [VERIFIED: codebase] `apps/api/src/modules/chatbot/agents/orchestrator.agent.ts` — fallback chain from sub-agent to `GeneralAgent`

### Secondary (MEDIUM confidence)

- [ASSUMED] Groq `llama-3.1-8b-instant` continues to be available for classifier use; verified via codebase that it is the current router model choice

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified in codebase; no new installs required
- Architecture: HIGH — patterns derived from existing code (IntentRouter, ConversationAgent, SessionLifecycleService)
- Pitfalls: HIGH — three pitfalls (double-emit, latency, silent null) derived from reading actual code paths
- Test infrastructure: HIGH — Vitest confirmed, test pattern established in Phase 4 tests

**Research date:** 2026-04-15
**Valid until:** 2026-05-15 (stable stack — Groq API models may change; re-verify model availability if >30 days)
