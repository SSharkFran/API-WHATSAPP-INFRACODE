# Roadmap: Infracode WhatsApp Platform — v1 Production

**Milestone:** Production-Readiness
**Created:** 2026-04-10
**Granularity:** Standard (8 phases, 3–5 plans each)
**Coverage:** 47/47 v1 requirements mapped

---

## Phases

- [ ] **Phase 1: Security Hardening** — Fix four critical pre-launch blockers before any real client onboards
- [ ] **Phase 2: CRM Identity & Data Integrity** — LID/JID normalized at ingestion; custom fields, tags, history, and UI fully functional
- [ ] **Phase 3: Admin Identity Service** — Extract AdminIdentityService from InstanceOrchestrator; decouple from aprendizadoContinuo; Redis JID cache
- [ ] **Phase 4: Session Lifecycle Formalization** — Formal session states, Redis + PostgreSQL persistence, BullMQ deduplication timeouts, humanTakeover DB-persisted
- [ ] **Phase 5: Intent Detection & Conversational AI** — Groq LLM pre-pass classifier for pt-BR, non-linear conversation, graceful "I don't know", human handoff
- [ ] **Phase 6: Metrics & Daily Summary** — ConversationMetric table, session metrics collector, dashboard queue view, daily WhatsApp summary
- [ ] **Phase 7: Admin Commander & Document Dispatch** — Prefix commands + LLM free-text, document send pipeline (Baileys PDF), action history, personalized messages
- [ ] **Phase 8: Continuous Learning Polish & Advanced Features** — Null Object module pattern, confirmation gate before ingestion, urgency scoring, follow-up automation, audit log

---

## Phase Details

### Phase 1: Security Hardening

**Goal**: The codebase is deployable to any environment without CSRF exposure, authentication bypass, credential leakage, or plaintext API keys — the minimum bar before any real client account is created.

**Depends on**: Nothing (first phase — must complete before production onboarding)

**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04

**Plans**: 4 plans

- [ ] 01-01-PLAN.md — Wave 0: Test scaffolds for all 9 security behaviors (SEC-01..SEC-04)
- [ ] 01-02-PLAN.md — Wave 1: CORS allowlist + auth bypass guard (SEC-01, SEC-02)
- [ ] 01-03-PLAN.md — Wave 1: aiFallbackApiKey encryption + migration (SEC-03)
- [ ] 01-04-PLAN.md — Wave 1: Session files assertion + query-string token removal (SEC-04)

#### Plan 1.1 — CORS Allowlist Enforcement
Replace `origin: true` in `apps/api/src/app.ts` (line 191) with `origin: process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()) ?? false`. Add `ALLOWED_ORIGINS` as a required, non-defaulting Zod env var in `config.ts`. Validate that cross-origin requests from unlisted origins are rejected. Set `http://localhost:3000` for development.

**Addresses:** SEC-01, PITFALL 4

#### Plan 1.2 — Auth Bypass Restricted to Development Only
Change the bypass condition in `apps/api/src/plugins/auth.ts` (lines 45–66) from `ENABLE_AUTH !== 'true'` to `ENABLE_AUTH !== 'true' && NODE_ENV === 'development'`. Add a startup assertion that logs fatal and exits if `NODE_ENV !== 'development'` and `ENABLE_AUTH !== 'true'`. Add `ENABLE_AUTH=true` to all non-development deployment manifests.

**Addresses:** SEC-02, PITFALL 6

#### Plan 1.3 — aiFallbackApiKey Encryption
Apply the same `encrypt(value, config.API_ENCRYPTION_KEY)` / `decrypt()` pattern already used by `aiApiKeyEncrypted` to `aiFallbackApiKey` in `apps/api/src/modules/chatbot/service.ts` (lines 644, 671). Return only a masked value (`sk-...****`) in API responses. Run a one-time migration to encrypt any existing plaintext rows on deployment.

**Addresses:** SEC-03, PITFALL 5

#### Plan 1.4 — Session Files Out of Repository
Add `apps/api/data/` to `.gitignore`. Run `git rm -r --cached apps/api/data/` if any session files are tracked. Set `DATA_DIR` to an absolute path outside the repository in all environments. Add a startup assertion: if `DATA_DIR` resolves to a path inside the project root, log fatal and exit. Remove query-string token acceptance (`?accessToken=`, `?apiKey=`) except on WebSocket upgrade endpoints.

**Addresses:** SEC-04, PITFALL 3, minor SEC from query-string token exposure (CONCERNS.md)

**Success Criteria** (what must be TRUE):
1. A cross-origin request from any domain not in `ALLOWED_ORIGINS` receives a CORS rejection — verified with `curl -H "Origin: https://evil.com"` returning no `Access-Control-Allow-Origin` header.
2. A staging deployment that omits `ENABLE_AUTH=true` refuses to start and logs a fatal error — the bypass cannot silently reach any non-development environment.
3. The `aiFallbackApiKey` column in the database contains only encrypted ciphertext; reading it via psql returns no human-readable API key string.
4. `git ls-files apps/api/data/` returns empty — no session credential files are tracked in the repository.

**UAT Scenarios**:
- Reviewer clones the repo to a fresh machine: no WhatsApp session data present, `.gitignore` covers the data path.
- Reviewer deploys to a staging environment without `ENABLE_AUTH=true`: application refuses to start with a clear error message.
- Reviewer opens the database and queries `chatbot_config.ai_fallback_api_key`: value is unreadable ciphertext, not a Groq/Gemini key string.
- Reviewer opens browser DevTools and makes a request from a non-whitelisted origin: request is blocked at CORS preflight.

**UI hint**: no

---

### Phase 2: CRM Identity & Data Integrity

**Goal**: Operators see real phone numbers everywhere in the CRM, contact data persists correctly across sessions, and the schema migration system prevents tenant drift as new columns are added.

**Depends on**: Phase 1 (schema migrations introduced here add columns — safe only after security is confirmed)

**Requirements**: CRM-01, CRM-02, CRM-03, CRM-04, CRM-05, CRM-06, CRM-07

**Plans**:

#### Plan 2.1 — LID/JID Normalization at Ingestion
At the point where a contact record is created or updated from a Baileys inbound message, call `signalRepository.getPNForLID(lid)` before storing the JID as the contact's phone number. Store the resolved E.164 number in `phoneNumber`; store the raw JID in a separate `rawJid` field only. If LID resolution fails (mapping not yet populated), store the raw JID in `rawJid` and leave `phoneNumber` null — never write a `@lid` string into `phoneNumber`. Implement a background reconciliation job (BullMQ) that periodically retries resolution for contacts with null `phoneNumber` and non-null `rawJid`.

**Addresses:** CRM-01, PITFALL 2

#### Plan 2.2 — Display Normalization Across All Surfaces
Audit every UI surface in `apps/panel/` that renders a contact identifier (CRM list, chat history, message thread, search results, metrics reports). Ensure all pass through a single `formatPhone(jid: string): string` utility function that: strips `@s.whatsapp.net` and `@lid` suffixes, validates E.164 format, formats as `+55 11 99999-9999` for pt-BR, and falls back to "Contato desconhecido" — never a raw JID string. Update send-from-CRM to use `targetJid` (the sendable identifier), never the display phone string.

**Addresses:** CRM-02, CRM-07

#### Plan 2.3 — Custom Fields, Tags, and Conversation History
Fix the custom fields persistence bug in chatbot/CRM save path (`aiFallbackApiKey` always set to null suggests a similar pattern exists for custom fields — audit and correct). Verify tags create → assign → filter → display end-to-end. Ensure conversation history query preserves context across session boundaries (no `LIMIT` that truncates history within a contact view). Fix the N+1 `clientMemory.findFirst()` loop in CRM contacts list (batch to single `findMany`). Fix the in-process deduplication over-fetch bug in `crm/routes.ts`.

**Addresses:** CRM-03, CRM-04, CRM-05, CRM-06

#### Plan 2.4 — Tenant Schema Migration Tracking
Add a `schema_migrations` table to every tenant schema at provisioning time. Implement a `runMigrations(tenantId)` function that reads applied versions from this table and applies only unapplied migrations in order. Call `runMigrations()` on API startup for all registered tenants (or lazily on first tenant access). Convert the current `tenant-schema.ts` `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements into versioned migration records.

**Addresses:** Structural prerequisite for all subsequent phases that add tenant schema columns (SESS, MET, CMD, APR tables). PITFALL 11.

**Success Criteria** (what must be TRUE):
1. The CRM contacts list never shows a string containing `@lid`, `@s.whatsapp.net`, or a numeric sequence not matching E.164 format — verified across 10+ real contacts including LID-affected ones.
2. A custom field saved through the panel UI is present on reload with the exact value entered — no silent discard.
3. A contact's conversation history displays messages from multiple sessions in chronological order without gaps.
4. Tags created and assigned to a contact survive page reload and appear correctly in the filtered list view.
5. Sending a message from the CRM to a LID-affected contact delivers successfully (no "sent but not received" failure).

**UAT Scenarios**:
- Operator opens CRM contacts list: every row shows a formatted phone number (e.g., `+55 11 98765-4321`), no `@lid` or UUID visible anywhere.
- Operator fills in "Empresa" custom field and saves: field appears with the same value after page refresh.
- Operator views contact with 3 past sessions: all message history is visible in a single scrollable timeline.
- Operator applies "Lead Quente" tag and uses tag filter: only tagged contacts appear in the filtered view.

**UI hint**: yes

---

### Phase 3: Admin Identity Service

**Goal**: Admin identification is a single, reliable, module-independent service that is the first gate in every message processing path — the "admin treated as client" bug class is architecturally impossible.

**Depends on**: Phase 1 (security baseline); Phase 2 (LID normalization utility reused here)

**Requirements**: ADM-01, ADM-02, ADM-03, ADM-04

**Plans**:

#### Plan 3.1 — Extract AdminIdentityService
Extract lines 2049–2171 of `apps/api/src/modules/instances/service.ts` (the admin detection block) into a standalone `AdminIdentityService` class at `apps/api/src/modules/instances/admin-identity.service.ts`. The service accepts `IAprendizadoContinuoModule` (interface, not the concrete module) so it works whether the module is enabled or not. It returns a single `AdminIdentityContext` struct: `{ isAdmin, isVerifiedAdmin, isInstanceSelf, isAdminSelfChat, canReceiveLearningReply, matchedAdminPhone, escalationConversationId }`. Add unit tests for the four key scenarios before extraction.

**Addresses:** ADM-01, ADM-02, PITFALL 9

#### Plan 3.2 — Redis JID Cache at Connection Time
At Baileys `connection.update: open`, call `sock.onWhatsApp(adminPhone)` to resolve the admin's current JID. Store the result in Redis: `SET instance:{instanceId}:admin_jid {resolvedJid}` with no TTL (cleared on disconnect). When an inbound message arrives with `@lid` in `remoteJid`, attempt resolution via `sock.signalRepository.lidMapping?.getPNForLID?.(remoteJid)` before comparing to admin phone. Wire disconnect event to clear the Redis key.

**Addresses:** ADM-03

#### Plan 3.3 — Super Admin Platform Routes & ADM-01 Wiring
Audit all platform-admin routes in `apps/panel/app/(super-admin)/admin/` and corresponding API routes for correct `PLATFORM_OWNER` scope enforcement. Fix any routes that rely on the auth bypass (now restricted in Phase 1) by ensuring they correctly read `request.auth.platformRole`. Ensure `AdminIdentityService` is wired as the single call site in `InstanceOrchestrator.handleInboundMessage()` — no other location may compute `isAdmin` independently after this plan.

**Addresses:** ADM-04; eliminates duplicate admin detection (ARCHITECTURE anti-pattern 4)

#### Plan 3.4 — Quick Wins: Logger, Scheduler, Dead Code
Replace all `console.log/warn/error` in `service.ts` and `chatbot/service.ts` with the Pino structured logger. Move `startSchedulers()` to after `app.listen()` succeeds; add `stopSchedulers()` to the `onClose` hook. Delete the commented-out 80-line dead code block (lines 3304–3390). Fix the UTF-8 encoding corruption in line 4887. Fix worker crash exit handler to update `instance.status = 'DISCONNECTED'` in PostgreSQL. These are housekeeping fixes that reduce noise in all future extraction diffs.

**Addresses:** ADM-01 (log visibility for admin checks), PITFALL 8, CONCERNS.md quick wins

**Success Criteria** (what must be TRUE):
1. An admin message processed through `handleInboundMessage()` always routes to the admin handler — never to `ChatbotService.process()`. This is verified by log output showing `AdminIdentityService` resolving the admin context before any AI call.
2. When `aprendizadoContinuo` module is disabled, the admin is still correctly identified and routed — verified by disabling the module in tenant config and sending an admin message.
3. A LID-form admin message (where WhatsApp sends the admin's JID as `@lid`) is correctly resolved via the Redis-cached JID and treated as an admin message.
4. The platform super-admin can access tenant management routes without the development auth bypass — verified against a staging environment with `ENABLE_AUTH=true`.

**UAT Scenarios**:
- Admin sends "status" to the WhatsApp instance: receives an admin-appropriate response (not a chatbot FAQ reply).
- Tenant developer disables `aprendizadoContinuo` module in config, then admin sends a message: admin is still identified correctly, does not go through chatbot pipeline.
- Platform owner logs in to the super-admin panel: tenant list, instance counts, and usage stats all load correctly without auth bypass.

**UI hint**: yes

---

### Phase 4: Session Lifecycle Formalization

**Goal**: Every conversation has a formal lifecycle — from the first message to confirmed closure — with states persisted to Redis and PostgreSQL that survive restarts, timeouts implemented via BullMQ deduplication, and human takeover that never resets on server restart.

**Depends on**: Phase 3 (AdminIdentityService must be extracted before SessionLifecycleService can consume it; ConversationSessionManager extraction follows AdminIdentityService as the second strangler-fig seam)

**Requirements**: SESS-01, SESS-02, SESS-03, SESS-04, SESS-05, SESS-06, SESS-07, SESS-08, SESS-09

**Plans**:

#### Plan 4.1 — ConversationSessionManager Extraction
Extract the `conversationSessions` Map, `getConversationSession()`, `clearConversationSession()`, `buildConversationSessionKey()`, debounce timer management, and the GC interval from `InstanceOrchestrator` into a `ConversationSessionManager` class. The orchestrator holds the only instance. Add a bounded LRU cap (configurable, default 500 sessions per instance) to prevent unbounded heap growth. Wire `conversationSessions.forEach(s => clearTimeout(s.debounceTimer))` into the `close()` method. No behavioral change — pure reorganization.

**Addresses:** SESS-01 (creates the seam for lifecycle service), PITFALL 14, CONCERNS.md debounce timer gap

#### Plan 4.2 — Redis Session State + ConversationSession Table
Add the `ConversationSession` table to the tenant schema migration system (from Phase 2.4): `startedAt`, `endedAt`, `durationSeconds`, `firstResponseMs`, `handoffCount`, `closedReason`, `humanTakeover` (boolean, DB-persisted). Write session status to a Redis hash keyed `session:{tenantId}:{instanceId}:{remoteJid}` with 24h TTL on every state transition. Read status from Redis on every inbound message (fast path); PostgreSQL is the durable record. On session open (first message), insert `ConversationSession` row. On close/inactivity, update `endedAt` and `closedReason`.

**Addresses:** SESS-02, SESS-06, SESS-07, SESS-08

#### Plan 4.3 — SessionLifecycleService + BullMQ Timeout Queue
Implement `SessionLifecycleService` with the formal state machine: `ATIVA → CONFIRMACAO_ENVIADA → ENCERRADA | INATIVA`. Use a `session-timeout` BullMQ queue with `deduplication: { id: 'session-timeout:{sessionId}', ttl: 10*60*1000, extend: true, replace: true }` so every new message resets the clock in O(1). The timeout worker reads current Redis state before acting — if the status changed (client replied), it exits without sending. Use the deterministic `jobId` pattern for cancellation (not `changeDelay`). Deploy behind a `SESSION_LIFECYCLE_V2=true` feature flag for staging validation with a 2-minute timeout before switching to the 10-minute production value.

**Addresses:** SESS-03, SESS-04, SESS-05, SESS-09, PITFALL 7

#### Plan 4.4 — InstanceEventBus Wiring
Introduce `InstanceEventBus` (typed `EventEmitter` wrapper) in `apps/api/src/lib/instance-events.ts`. Wire `InstanceOrchestrator` to emit `session.activity`, `session.close_intent_detected`, and `admin.command` domain events instead of calling extracted services directly. `SessionLifecycleService` and (in Phase 6) `SessionMetricsCollector` subscribe to these events. This is the decoupling seam for all subsequent extractions.

**Addresses:** Architectural prerequisite for Phase 5, 6, 7 incremental extraction; eliminates direct coupling (ARCHITECTURE anti-pattern 1)

**Success Criteria** (what must be TRUE):
1. An API restart during an active conversation does not reset the session state — the next inbound message finds the correct `ATIVA` status in Redis and the `ConversationSession` row in PostgreSQL.
2. A client who stops responding receives exactly one "Ainda deseja continuar o atendimento?" message after 10 minutes — never two, never zero.
3. After the confirmation message, if the client does not reply within the configured window, the session transitions to `INATIVA` and `ConversationSession.endedAt` is written to the database.
4. A session with `humanTakeover: true` in the database does not receive any bot response — verified by restarting the API and sending a message to the contact: no AI reply is generated.
5. Worker thread crash results in `instance.status = 'DISCONNECTED'` in PostgreSQL within 5 seconds — UI shows the instance as disconnected.

**UAT Scenarios**:
- Client sends a message, then goes silent for 10 minutes: they receive one polite "still there?" message (not two, not zero), and if they don't reply, the session is marked inactive.
- Admin triggers human takeover for a contact, API is restarted, client sends another message: bot does not respond — human takeover persisted.
- Client sends a closing phrase ("era só isso, obrigado"): session transitions smoothly to confirmation state, then to closed after the grace period.

**UI hint**: no

---

### Phase 5: Intent Detection & Conversational AI

**Goal**: The chatbot reliably classifies Brazilian Portuguese conversation intent before routing — automatically triggering closure confirmations, urgency flags, and human handoffs without any regex or keyword list.

**Depends on**: Phase 4 (SessionLifecycleService must exist for intent results to trigger state transitions; `CONFIRMACAO_ENVIADA` transition requires the lifecycle service)

**Requirements**: IA-01, IA-02, IA-03, IA-04, IA-05, IA-06

**Plans**:

#### Plan 5.1 — Groq LLM Intent Classifier (Pre-pass)
Implement `IntentClassifierService` as a lightweight pre-pass before `OrchestratorAgent`. Uses Groq Llama 3.1 8B with the prompt pattern: "Classify the following Brazilian Portuguese message into exactly one of: ENCERRAMENTO, URGENCIA_ALTA, TRANSFERENCIA_HUMANO, PERGUNTA, CONTINUACAO, OUTRO. Reply with ONLY the label." Cache the classification result in the in-session context — do not re-classify the same message. Verify whether `IntentRouter` in `OrchestratorAgent` already returns a close signal before adding a new `ENCERRAMENTO` route; extend only what is missing.

**Addresses:** IA-01, IA-02

#### Plan 5.2 — Automatic State Transitions from Intent
Wire intent results to `SessionLifecycleService` via `InstanceEventBus`:
- `ENCERRAMENTO` → emit `session.close_intent_detected` → transition to `CONFIRMACAO_ENVIADA`, send polite closing message.
- `URGENCIA_ALTA` → set urgency score on `ConversationSession`, surface in dashboard (Phase 6).
- `TRANSFERENCIA_HUMANO` → immediately set `humanTakeover: true` in DB, notify admin via WhatsApp with conversation summary.
Validate with at least 50 real Brazilian closure expressions in staging before enabling in production.

**Addresses:** IA-02, IA-06, SESS-09

#### Plan 5.3 — Graceful "I Don't Know" Response
When `ChatbotService` cannot produce a confident answer (existing `GeneralAgent` fallback path), always return an honest, client-friendly message: "Essa é uma ótima pergunta! Não tenho essa informação no momento. Vou verificar com nossa equipe e retorno em breve." This response fires regardless of whether `aprendizadoContinuo` is enabled. If `aprendizadoContinuo` IS enabled, additionally notify the admin with structured context (client name/phone, exact question, session ID, `/aprender` instruction). Module disabled = Part A only, never Part B.

**Addresses:** IA-03, IA-04, APR-03 (admin notification side)

#### Plan 5.4 — Non-Linear Conversation Flow
Audit `OrchestratorAgent` and all sub-agents for rigid pipeline failures — paths where an unexpected input causes the agent to return empty or throw instead of gracefully continuing. Add fallback branches to every agent: if sub-agent fails, `GeneralAgent` catches and responds. Ensure the bot never leaves a client waiting with no response due to an internal exception. Replace fire-and-forget void calls in chatbot routes with BullMQ jobs for reliability.

**Addresses:** IA-03, IA-05; CONCERNS.md fire-and-forget void calls

**Success Criteria** (what must be TRUE):
1. A client who sends "era só isso, muito obrigado" receives a graceful closing response and the session enters `CONFIRMACAO_ENVIADA` — not a generic FAQ reply.
2. A client who says "quero falar com um humano" triggers an immediate human takeover: bot goes silent, admin receives a WhatsApp notification with the conversation summary.
3. When the bot cannot answer, the client receives a human, honest response — never silence, never "Erro interno", never a hallucinated answer.
4. When `aprendizadoContinuo` is disabled and the bot cannot answer, the admin receives NO notification — only the client-facing fallback message fires.
5. Sending any message (even an unusual or malformed one) never results in a conversation that stalls with no response.

**UAT Scenarios**:
- Client types "valeu, até mais": session correctly transitions to closing state with a polite confirmation message.
- Client types "isso é urgente, preciso resolver hoje": conversation is flagged with high urgency; admin sees it highlighted in the dashboard queue (Phase 6 surfaces it).
- Bot encounters a question outside its knowledge: client receives a warm "I'll check and get back to you" message; admin (if module active) receives structured escalation with the question text.
- Client sends a completely off-topic or garbled message: bot responds gracefully with a clarifying question, does not crash.

**UI hint**: no

---

### Phase 6: Metrics & Daily Summary

**Goal**: Every session generates accurate, durable metrics — admins can see today's service performance on the dashboard and receive a daily summary on WhatsApp, giving them the data to justify the platform subscription.

**Depends on**: Phase 4 (`ConversationSession` table must exist for metrics to attach to); Phase 5 (urgency scores and intent data feed into metrics)

**Requirements**: MET-01, MET-02, MET-03, MET-04, MET-05, MET-06, MET-07

**Plans**:

#### Plan 6.1 — ConversationMetric Table & SessionMetricsCollector
Add the `ConversationMetric` table to the tenant schema migration system: `instanceId`, `contactId`, `startedAt`, `endedAt`, `durationSeconds`, `firstResponseMs`, `handoffCount`, `documentCount`, `closedReason`. Implement `SessionMetricsCollector` that subscribes to `InstanceEventBus` session events (`session.opened`, `session.first_response`, `session.handoff`, `session.closed`, `document.sent`) and writes/updates `ConversationMetric` rows via `setImmediate()` — deferred, never blocking the message pipeline. Add index on `(instanceId, startedAt)`.

**Addresses:** MET-01, MET-02, MET-03, MET-04, MET-05

#### Plan 6.2 — Dashboard Metrics Panel & Urgency Queue
Add a metrics panel page to the tenant dashboard in `apps/panel/app/(tenant)/tenant/`. Display: sessions started/ended/inactive/handed-off today, average duration, average first response time, continuation rate after inactivity message. Add an "Atendimento Ativo" queue view that lists open sessions sorted by urgency score (from Phase 5) — high-urgency sessions appear first with a visual badge. Queries run against `ConversationMetric` and `ConversationSession` tables; no aggregation service needed.

**Addresses:** MET-07, URG-02 (urgency queue surface — score from Phase 5)

#### Plan 6.3 — Daily WhatsApp Summary Delivery
Implement the daily summary sender as a standalone function (extracted from the `aprendizadoContinuo` module interval, which currently owns it). Build summary data from `ConversationMetric` aggregation query (day boundary). Send via the tenant's WhatsApp instance to the admin JID (from Phase 3's Redis cache). Delivery is gated on the `resumoDiario` module being active — if disabled, the function is a no-op. This extraction is the first piece of the Phase 8 `ContinuousLearningService` extraction, done safely early.

**Addresses:** MET-06; partial decoupling prerequisite for Phase 8

**Success Criteria** (what must be TRUE):
1. After any session closes, a `ConversationMetric` row is present in the tenant database within 5 seconds — verified by querying the DB after a test session ends.
2. The dashboard metrics panel shows today's session counts, average duration, and first-response time with data that matches a manual count from the `ConversationSession` table.
3. High-urgency conversations (flagged in Phase 5) appear at the top of the active queue with a visual indicator — operators can immediately see which conversations need attention.
4. At the configured summary time, the admin receives a WhatsApp message with the day's metrics — and if the `resumoDiario` module is disabled, no message is sent.

**UAT Scenarios**:
- 5 test sessions are run (3 closed normally, 1 handed to human, 1 timed out): dashboard shows correct counts for each category.
- Admin views the active queue with one urgency-flagged conversation: that conversation appears first with a visible urgency badge.
- Admin enables `resumoDiario` module and waits for the configured time: receives a WhatsApp message summarizing the day's stats.
- Admin disables `resumoDiario` module: no summary message is sent the next day.

**UI hint**: yes

---

### Phase 7: Admin Commander & Document Dispatch

**Goal**: The tenant admin can manage the service entirely from WhatsApp — sending documents to clients with personalized messages, querying system status, and having every action logged for accountability.

**Depends on**: Phase 3 (AdminIdentityService is the security gate for all command execution); Phase 4 (formalized sessions needed for document dispatch context and action logging); Phase 6 (metrics available for `/resumo` command responses)

**Requirements**: CMD-01, CMD-02, CMD-03, CMD-04, CMD-05, CMD-06, DOC-01, DOC-02, DOC-03, DOC-04

**Plans**:

#### Plan 7.1 — AdminCommandHandler: Prefix Parser + LLM Fallback
Implement `AdminCommandHandler` at `apps/api/src/modules/instances/admin-command.handler.ts`. Tier 1: prefix matching for explicit commands — `/contrato [nome]`, `/proposta [nome]`, `/status`, `/resumo`, `/encerrar [nome]`. Tier 2: Groq LLM classification for free-text queries when no prefix matches — classifies into `SYSTEM_STATUS_QUERY`, `DOCUMENT_SEND`, `METRICS_QUERY`, or `UNRECOGNIZED`. Wire to `InstanceOrchestrator` via `InstanceEventBus` `admin.command` event. Admin messages never enter `ChatbotService.process()`.

**Addresses:** CMD-01, CMD-02, CMD-06

#### Plan 7.2 — Document Dispatch Pipeline
Implement the document send flow: admin command → look up contact by name in tenant DB → find document template in instance config → call `sock.sendMessage(contactJid, { document: { url: absolutePath }, mimetype: 'application/pdf', fileName: 'Contrato - {clientName}.pdf', caption: '{personalizedMessage}' })`. Use URL-based send (not Buffer) for disk files. Validate file size < 5 MB before sending; alert admin if exceeded. Add file size check; use `mime-types` package for `mimetype` (do not hardcode). Decide between `pdfkit` and `@react-pdf/renderer` at phase start based on whether personalized PDF generation is required.

**Addresses:** CMD-03, CMD-04, DOC-01, DOC-02, DOC-03, DOC-04

#### Plan 7.3 — AdminActionLog Table & Audit Trail
Add `AdminActionLog` table to tenant schema: `id`, `triggeredByJid`, `actionType` (document_send | session_close | status_query | metrics_query | human_takeover), `targetContactJid`, `documentName`, `messageText`, `deliveryStatus`, `createdAt`. Write a row for every admin command processed. Expose a read-only action history panel page in `apps/panel/app/(tenant)/tenant/` showing the log. This covers both command-triggered and bot-triggered document sends.

**Addresses:** CMD-05, DOC-01 (document history)

#### Plan 7.4 — System Status Query Responses
Implement the `/status` command response: aggregate instance health (connected/disconnected), active session count, today's message count, and last summary timestamp from available data. Implement `/resumo` command to return the same data as the daily summary on demand. Implement `CMD-06`: admin can ask "como o sistema está funcionando?" in free text and receive a clear status reply. These responses are generated from existing data sources — no new metrics needed beyond Phase 6.

**Addresses:** CMD-06, CMD-02 (metrics query intent)

**Success Criteria** (what must be TRUE):
1. Admin types `/contrato João Silva` in WhatsApp: the bot identifies João Silva in the CRM, sends the PDF with a personalized caption containing his name, and the delivery appears in João's conversation history.
2. Admin types "manda a proposta para o cliente Maria": the LLM classifier interprets this as `DOCUMENT_SEND`, the system sends the proposal to Maria, and the action is logged in `AdminActionLog`.
3. Admin types `/status`: receives a WhatsApp reply listing the current instance connection status, active session count, and today's message count — no more than 30 seconds stale.
4. Every document send appears in the admin panel's action history with requester identity, timestamp, client, document name, and delivery status.
5. A file larger than 5 MB triggers a warning to the admin before send — the document is not silently sent or silently rejected.

**UAT Scenarios**:
- Admin sends `/contrato Ana Lima` from WhatsApp: Ana Lima receives a PDF with a caption "Olá Ana, segue o contrato conforme combinado." The admin receives a confirmation. The admin panel shows the action in history.
- Admin sends a free-text command "qual o status do atendimento hoje?": receives a metrics summary with session counts for the day.
- Admin panel "Histórico de Ações" page lists all commands sent in the last 7 days with outcome (sent / failed / pending).
- Admin tries to send a 6 MB PDF: receives an alert "Arquivo excede 5 MB — verifique o documento antes de enviar" instead of a silent failure.

**UI hint**: yes

---

### Phase 8: Continuous Learning Polish & Advanced Features

**Goal**: The `aprendizadoContinuo` module is fully isolated via the Null Object pattern (no `isEnabled` checks in business logic), knowledge ingestion is gated behind admin confirmation, urgency scoring is surfaced, and follow-up automation is window-aware — the module degrades gracefully in all conditions and the knowledge base cannot be contaminated by unvalidated answers.

**Depends on**: Phase 3 (AdminIdentityService — learning replies must go through the same admin identity check); Phase 4 (session lifecycle — learning is triggered by session events); Phase 5 (intent detection — unknown-intent messages trigger the escalation path); all other phases stable (highest-risk extraction, last)

**Requirements**: APR-01, APR-02, APR-03, APR-04, APR-05, APR-06, URG-01, URG-02, FOL-01, FOL-02

**Plans**:

#### Plan 8.1 — Null Object Pattern for aprendizadoContinuo
Define `IAprendizadoContinuoModule` interface: `isEnabled()`, `isVerified()`, `getAdminPhones()`, `getAdminJids()`, `processLearningReply()`, `shouldSendDailySummary()`, `buildDailySummary()`. Implement `DisabledAprendizadoContinuoModule` as a no-op that returns `false`, `[]`, and no-ops for all methods. Implement `ActiveAprendizadoContinuoModule` with real behavior. Wire in `app.ts`: if `chatbotConfig.modules?.aprendizadoContinuo?.isEnabled`, instantiate `Active`; else `Disabled`. Remove all `if (module?.isEnabled)` guards from `InstanceOrchestrator` and all other services — they now call the interface and the disabled implementation does nothing.

**Addresses:** APR-01; eliminates 20+ `isEnabled` guards (ARCHITECTURE anti-pattern 5)

#### Plan 8.2 — Confirmation Gate Before Knowledge Ingestion
Add a confirmation step before ingesting any admin reply into the knowledge base. After receiving an admin reply to an escalation, echo back: "Entendido: [answer text]. Devo adicionar isso ao conhecimento do sistema? Responda SIM para confirmar." Only after `SIM` confirmation is the Q&A pair written to the knowledge base. Implement conflict detection: before adding new knowledge, run a similarity check against existing entries. If a conflict is detected, alert the admin instead of silently overriding. Limit escalation window: if admin does not respond within 4 hours, mark question as `unanswered` and stop re-escalating.

**Addresses:** APR-02, APR-04; PITFALL 10

#### Plan 8.3 — Audit Trail Panel & Knowledge Review UI
Implement the `LearningLog` table (or extend existing) to store every knowledge addition: original client question, admin answer, confirmation timestamp, admin JID, usage count. Add a panel page under tenant settings: "Conhecimento Adquirido" — lists all learned Q&A pairs with metadata (date, admin, question). Provide a "Remover" action to delete incorrect entries. This gives admins visibility into what the bot learned and the ability to correct mistakes.

**Addresses:** APR-05, APR-06

#### Plan 8.4 — Urgency Scoring & Follow-Up Automation
Compute `urgencyScore` (0–100) on `ConversationSession` from Phase 5 intent signals (`URGENCIA_ALTA` = 80+) plus secondary signals (session duration, unanswered message count, explicit urgency keywords). Surface score as a sortable column in the dashboard queue (Phase 6 built the queue; this plan adds the score). Implement follow-up automation: admin can schedule "send follow-up to [contact] in X hours." Before scheduling, check if the follow-up time falls within the 24-hour WhatsApp window from the client's last message. If outside the window, alert the admin and block the send — log the override if admin explicitly proceeds. Respect business hours (no sends between 21:00–08:00 local time by default).

**Addresses:** URG-01, URG-02, FOL-01, FOL-02

**Success Criteria** (what must be TRUE):
1. With `aprendizadoContinuo` disabled, zero `if (module?.isEnabled)` checks remain in any service — all module interactions go through the interface, and all tests pass.
2. An admin reply to an escalation triggers a confirmation request; only after the admin replies `SIM` does the new Q&A pair appear in the knowledge base and in the audit log.
3. The "Conhecimento Adquirido" panel page lists all learned pairs with date and admin identity; deleting a pair removes it from the knowledge base within one chatbot request cycle.
4. A conversation flagged `URGENCIA_ALTA` in Phase 5 shows a visible urgency score in the dashboard queue, sortable from highest to lowest.
5. A follow-up scheduled outside the 24-hour window is blocked with a clear admin notification — the message is not sent silently, and the override is logged if used.

**UAT Scenarios**:
- Admin disables `aprendizadoContinuo` module completely: system runs a full test conversation, chatbot responds normally, no error or broken behavior appears anywhere.
- Bot escalates a question to admin; admin replies casually "vou ver isso depois": system sends confirmation request, does NOT add the casual reply to the knowledge base.
- Admin opens "Conhecimento Adquirido" page: sees 3 learned Q&A pairs from this week; deletes one incorrect entry; bot no longer uses that entry in subsequent conversations.
- Admin attempts to schedule a follow-up for a client whose last message was 25 hours ago: receives alert "Fora da janela de 24h do WhatsApp — envio bloqueado" instead of a silent fail.

**UI hint**: yes

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Security Hardening | 0/4 | Not started | - |
| 2. CRM Identity & Data Integrity | 0/4 | Not started | - |
| 3. Admin Identity Service | 0/4 | Not started | - |
| 4. Session Lifecycle Formalization | 0/4 | Not started | - |
| 5. Intent Detection & Conversational AI | 0/4 | Not started | - |
| 6. Metrics & Daily Summary | 0/3 | Not started | - |
| 7. Admin Commander & Document Dispatch | 0/4 | Not started | - |
| 8. Continuous Learning Polish & Advanced Features | 0/4 | Not started | - |

---

## Dependency Graph

```
Phase 1 (Security)
  └─► Phase 2 (CRM Identity)
        └─► Phase 3 (Admin Identity)
              └─► Phase 4 (Session Lifecycle)
                    ├─► Phase 5 (Intent Detection)
                    │     └─► Phase 6 (Metrics)
                    │           └─► Phase 7 (Admin Commander)
                    └─► Phase 6 (Metrics)
                          └─► Phase 7 (Admin Commander)
                                └─► Phase 8 (Continuous Learning Polish)
```

**Critical path:** Phase 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

**Hard constraints:**
- Phase 1 must be complete before any real client is onboarded
- Phase 3 is a prerequisite for Phase 7 (admin command security gate)
- Phase 4 is a prerequisite for Phase 5 (lifecycle state drives intent transitions) and Phase 6 (session records are the metrics source)
- Phase 8 is always last — highest-risk extraction, most deeply entangled

**aprendizadoContinuo graceful degradation rule:**
The module must degrade gracefully through ALL phases. From Phase 3 onward, every service interacts with `IAprendizadoContinuoModule` (the interface). The Null Object pattern (Plan 8.1) formalizes this — but the principle applies from Phase 3 forward: no service may assume the module is enabled.

---

## Traceability

| Requirement | Phase | Plan | Status |
|-------------|-------|------|--------|
| SEC-01 | Phase 1 | Plan 1.1 | Pending |
| SEC-02 | Phase 1 | Plan 1.2 | Pending |
| SEC-03 | Phase 1 | Plan 1.3 | Pending |
| SEC-04 | Phase 1 | Plan 1.4 | Pending |
| CRM-01 | Phase 2 | Plan 2.1 | Pending |
| CRM-02 | Phase 2 | Plan 2.2 | Pending |
| CRM-03 | Phase 2 | Plan 2.3 | Pending |
| CRM-04 | Phase 2 | Plan 2.3 | Pending |
| CRM-05 | Phase 2 | Plan 2.3 | Pending |
| CRM-06 | Phase 2 | Plan 2.3 | Pending |
| CRM-07 | Phase 2 | Plan 2.2 | Pending |
| ADM-01 | Phase 3 | Plan 3.1 | Pending |
| ADM-02 | Phase 3 | Plan 3.1 | Pending |
| ADM-03 | Phase 3 | Plan 3.2 | Pending |
| ADM-04 | Phase 3 | Plan 3.3 | Pending |
| SESS-01 | Phase 4 | Plan 4.1 | Pending |
| SESS-02 | Phase 4 | Plan 4.2 | Pending |
| SESS-03 | Phase 4 | Plan 4.3 | Pending |
| SESS-04 | Phase 4 | Plan 4.3 | Pending |
| SESS-05 | Phase 4 | Plan 4.3 | Pending |
| SESS-06 | Phase 4 | Plan 4.2 | Pending |
| SESS-07 | Phase 4 | Plan 4.2 | Pending |
| SESS-08 | Phase 4 | Plan 4.2 | Pending |
| SESS-09 | Phase 4 | Plan 4.3 | Pending |
| IA-01 | Phase 5 | Plan 5.1 | Pending |
| IA-02 | Phase 5 | Plan 5.1 + 5.2 | Pending |
| IA-03 | Phase 5 | Plan 5.3 + 5.4 | Pending |
| IA-04 | Phase 5 | Plan 5.3 | Pending |
| IA-05 | Phase 5 | Plan 5.4 | Pending |
| IA-06 | Phase 5 | Plan 5.2 | Pending |
| MET-01 | Phase 6 | Plan 6.1 | Pending |
| MET-02 | Phase 6 | Plan 6.1 | Pending |
| MET-03 | Phase 6 | Plan 6.1 | Pending |
| MET-04 | Phase 6 | Plan 6.1 | Pending |
| MET-05 | Phase 6 | Plan 6.1 | Pending |
| MET-06 | Phase 6 | Plan 6.3 | Pending |
| MET-07 | Phase 6 | Plan 6.2 | Pending |
| CMD-01 | Phase 7 | Plan 7.1 | Pending |
| CMD-02 | Phase 7 | Plan 7.1 | Pending |
| CMD-03 | Phase 7 | Plan 7.2 | Pending |
| CMD-04 | Phase 7 | Plan 7.2 | Pending |
| CMD-05 | Phase 7 | Plan 7.3 | Pending |
| CMD-06 | Phase 7 | Plan 7.4 | Pending |
| DOC-01 | Phase 7 | Plan 7.2 | Pending |
| DOC-02 | Phase 7 | Plan 7.2 | Pending |
| DOC-03 | Phase 7 | Plan 7.2 | Pending |
| DOC-04 | Phase 7 | Plan 7.2 | Pending |
| APR-01 | Phase 8 | Plan 8.1 | Pending |
| APR-02 | Phase 8 | Plan 8.2 | Pending |
| APR-03 | Phase 5 | Plan 5.3 | Pending |
| APR-04 | Phase 8 | Plan 8.2 | Pending |
| APR-05 | Phase 8 | Plan 8.3 | Pending |
| APR-06 | Phase 8 | Plan 8.3 | Pending |
| URG-01 | Phase 8 | Plan 8.4 | Pending |
| URG-02 | Phase 6 + 8 | Plan 6.2 + 8.4 | Pending |
| FOL-01 | Phase 8 | Plan 8.4 | Pending |
| FOL-02 | Phase 8 | Plan 8.4 | Pending |

**Coverage:**
- v1 requirements: 47 total
- Mapped to phases: 47
- Unmapped: 0 ✓

---

## Research Flags (Staging Validation Required)

These items must be validated in staging before declaring the phase complete:

| Flag | Phase | What to validate |
|------|-------|-----------------|
| LID resolution timing window | Phase 2 | How long after `connection.update: open` until `signalRepository.lidMapping` is populated. Instrument and observe before declaring CRM-01 done. |
| BullMQ deduplication TTL/delay interaction | Phase 4 | Test with 2-minute timeout in staging before deploying 10-minute production values. Verify deduplication entry survives its TTL while job is in delayed state. |
| pt-BR ENCERRAMENTO accuracy | Phase 5 | Validate with 50+ real Brazilian closure expressions before enabling in production. Confirm whether existing `IntentRouter` already handles CLOSE_INTENT before adding a new route. |

---

*Roadmap created: 2026-04-10*
*Covers: v1 Production milestone*
*Next: `/gsd-plan-phase 1` to plan Phase 1: Security Hardening*
