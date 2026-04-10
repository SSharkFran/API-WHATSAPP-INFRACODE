# Project Research Summary

**Project:** Infracode WhatsApp SaaS Platform — v1 Production
**Domain:** Multi-tenant WhatsApp automation SaaS (chatbot + CRM + admin tooling)
**Researched:** 2026-04-10
**Confidence:** MEDIUM-HIGH

---

## Executive Summary

This is a working prototype being hardened to production quality — not a greenfield build. The core stack (Fastify, Next.js, BullMQ, Redis, PostgreSQL, Baileys) is settled and sound. The primary work is: fixing four critical security issues before any real client onboards, formalizing the session lifecycle that currently exists only as implicit booleans inside a 5,150-line god-class, and resolving the LID/JID identity problem that makes the CRM display garbled identifiers to operators. Everything else — admin commands, metrics, document dispatch, continuous learning polish — builds on top of these foundations. Do not build differentiators on a foundation with known security holes and structural identity bugs.

The architectural direction is incremental extraction from InstanceOrchestrator using typed domain events (Node.js EventEmitter) and class extraction — not a big-bang rewrite and not a microservices split. Three patterns resolve the most significant structural problems: (1) BullMQ deduplication with extend:true for inactivity timeouts (O(1), survives restarts), (2) typed EventEmitter domain events for god-class extraction (no coupling, testable seams), (3) Null Object pattern for the aprendizadoContinuo module (eliminates 20+ isEnabled guards, makes the module truly optional). Session state must be persisted to Redis + PostgreSQL — never stored only in the in-process Map.

The two risks that can end the product if ignored: WhatsApp account bans (Baileys is unofficial; spam-like patterns cause permanent bans with no recovery) and the LID/JID structural problem (storing a @lid as a phone number corrupts contact data irreversibly and causes silent message delivery failures to wrong recipients). Both must be addressed before any client handles real conversations. The continuous learning module carries a secondary risk: unvalidated admin answers contaminate the knowledge base silently; a confirmation step before ingestion is mandatory.

---

## Key Findings

### Resolved Technical Decisions

The following were open questions in PROJECT.md. Research resolved all of them — these are not debatable during roadmap planning:

| Decision | Resolved Answer | Confidence |
|----------|----------------|------------|
| Session timeout mechanism | BullMQ deduplication extend:true — O(1), no changeDelay, no queue scanning | HIGH |
| Session state storage | Redis hash (live) + PostgreSQL ConversationSession row (durable) — never in-process Map | HIGH |
| State machine library | None. Plain TypeScript enum + transition table. XState is overkill for 5 states. | HIGH |
| God-class extraction strategy | Domain events via typed InstanceEventBus (EventEmitter wrapper) + class extraction per seam | HIGH |
| Extraction order | Admin identity first, then SessionManager, then SessionLifecycle+BullMQ, then Metrics, then Learning | HIGH |
| Admin identification | sock.onWhatsApp(adminPhone) at connect time stored in Redis, then LID fallback via getPNForLID | MEDIUM |
| Admin command parsing | Prefix commands (/contrato, /status) + Groq LLM for free-text queries | MEDIUM |
| Module optional pattern | Null Object pattern — DisabledAprendizadoContinuoModule implements same interface, returns empty/no-op | HIGH |
| Intent detection (pt-BR) | LLM prompt classification (Groq Llama 3.1 8B, ~$0.000004/call) — not regex/keyword list | MEDIUM |
| Document send API | sock.sendMessage with document url, mimetype, fileName, caption — URL-based for disk files | MEDIUM |

---

### Stack

The existing stack requires no changes. Four patterns were researched to fill implementation gaps:

- **BullMQ v5 deduplication** (extend:true, replace:true) — inactivity timer debounce pattern. Requires commandTimeout:30000. Known issues #2534 and #3295 are rare but real; mitigate by keeping the BullMQ worker always running.
- **Typed EventEmitter wrapper (InstanceEventBus)** — domain event bus for decoupling extracted services from InstanceOrchestrator. No new dependency; uses Node.js built-in.
- **Groq Llama 3.1 8B** — intent classification (pt-BR). Already wired. Cost is negligible at this scale. Use as a pre-pass before OrchestratorAgent.
- **Redis hybrid session store** — session:{tenantId}:{instanceId}:{remoteJid} hash with 24h TTL for live state. PostgreSQL ConversationSession table for durable records and metrics.

**Version constraint:** BullMQ deduplication API requires v5+. Verify before implementing.

---

### Features

**Must have (table stakes — missing = prototype-grade):**

- **Real contact identity everywhere** — phone numbers in E.164 format, never @lid or raw JID in any UI surface. Normalize at ingestion, not only at display. Currently broken in multiple CRM surfaces.
- **Session lifecycle with formal states** — ativa, aguardando_cliente, confirmacao_enviada, encerrada, inativa. Drives all timeout behavior, metrics, and routing decisions.
- **Intent detection (pt-BR)** — ENCERRAMENTO, URGENCIA_ALTA, TRANSFERENCIA_HUMANO, PERGUNTA, CONTINUACAO. Unlocks auto-close, urgency queue, human takeover auto-trigger.
- **Human takeover with DB-persisted flag** — humanTakeover:true must survive server restarts. Bot hard-mute checked as the absolute first step in message processing.
- **Reliable admin identity** — decoupled from aprendizadoContinuo module. Admin check is the first gate. Phone normalized to E.164 at storage and comparison.
- **Contact data integrity** — custom fields save, tags persist, notes append-only, history preserved across sessions.
- **Graceful I-dont-know response** — honest client-facing response always. Admin escalation only when module is active.
- **Metrics + daily summary** — session counts, duration, first response time, human takeover rate, document sends.

**Should have (differentiators for this milestone):**

- **Admin-as-commander via WhatsApp** — /contrato, /status, /resumo, free-text queries. High-value for Brazilian SMBs where WhatsApp is the primary work channel.
- **Urgency scoring + priority queue dashboard** — derived from intent classification; nearly free once classifier is running.
- **Document dispatch pipeline** — contracts/proposals via bot or admin command, logged with delivery status.
- **Continuous learning audit trail** — readable log of what the bot learned, from whom, when.

**Defer (out of scope for this milestone):**

- Follow-up automation with 24h window compliance
- Multi-language support
- External CRM integrations (HubSpot, Salesforce)
- WABA template messages (requires official API migration)
- Mobile app

**Anti-features (explicitly avoid):**

- Regex-based pt-BR intent detection — permanently incomplete
- In-memory-only humanTakeover flag — lost on restart, bot overlaps human
- Sending messages outside the 24h WhatsApp window — ban risk, no recovery
- Aggressive session closure without confirmation — Brazilian customer expectation failure

---

### Architecture

The orchestrator becomes a thin coordinator: receive inbound message, resolve admin identity once, hand session to ConversationSessionManager, delegate lifecycle decisions to SessionLifecycleService, emit domain events. No business logic in the orchestrator itself.

**Extraction sequence (follow this order — dependencies are real):**

1. AdminIdentityService — pure computation, zero state, zero risk. Extract first.
2. ConversationSessionManager — in-memory Map extraction. Creates seam for lifecycle service.
3. SessionLifecycleService + Redis state + BullMQ timeout queue — new behavior. Feature-flagged with SESSION_LIFECYCLE_V2.
4. SessionMetricsCollector — async DB writes via setImmediate(). Purely additive.
5. ContinuousLearningService — most entangled extraction. Null Object pattern for disabled state. Last.

**Schema additions required:**
- ConversationSession table (tenant schema): startedAt, endedAt, durationSeconds, firstResponseMs, handoffCount, closedReason
- ConversationMetric table (tenant schema): aggregation source for dashboard and daily summary
- Redis hash session:{tenantId}:{instanceId}:{remoteJid}: live state, 24h TTL
- schema_migrations table per tenant schema: tracks which migrations have been applied

---

### Critical Pitfalls

**Pre-launch blockers — fix before any real client onboards:**

1. **Auth bypass ships to staging** (PITFALL 6) — ENABLE_AUTH not tied to NODE_ENV. Fix: change bypass condition to require both ENABLE_AUTH !== true AND NODE_ENV === development. Add startup assertion.
2. **CORS origin:true enables CSRF** (PITFALL 4) — any link a logged-in admin clicks can trigger arbitrary API actions. Fix: ALLOWED_ORIGINS env var. One-line change in app.ts.
3. **Session credentials in the repository** (PITFALL 3) — apps/api/data/sessions/ not in .gitignore. Fix immediately. Long-term: DB-backed auth state.
4. **aiFallbackApiKey plaintext in DB and API responses** (PITFALL 5) — Fix: encrypt on write, decrypt on read, return masked value in API responses.

**Structural risks that degrade production correctness:**

5. **LID stored as phone number corrupts contact data permanently** (PITFALL 2) — resolve via getPNForLID() before storing; never store raw @lid as a phone number.
6. **Worker crash leaves instance as CONNECTED in DB** (PITFALL 8) — wire instance.status = DISCONNECTED to worker exit event handler.
7. **Admin identity coupled to optional module** (PITFALL 9) — store admin phones in dedicated tenant config; AdminIdentityService reads from there, not the learning module.
8. **BullMQ timeout race condition** (PITFALL 7) — always check lastMessageAt from Redis before taking timeout action; handle NotAllowed on job removal gracefully.
9. **Unvalidated admin answers contaminate knowledge base** (PITFALL 10) — confirmation step before ingestion; conflict detection; 4h escalation window limit.
10. **Tenant schema migration drift** (PITFALL 11) — schema_migrations table per tenant; run migrations on startup.

---

## Implications for Roadmap

### Suggested Phase Structure

**Phase 1: Security Hardening**

**Rationale:** Four CRITICAL security issues exist. All are 1-5 line fixes. No architectural changes. Catastrophic if shipped; cheap to fix.

**Delivers:** A deployable codebase that passes basic security review.

**Addresses:** CORS wildcard, auth bypass env var, session credentials in repo, plaintext API key, query string token leak.

**Avoids:** PITFALLS 3, 4, 5, 6, 15

**Research flag:** None needed. All fixes are identified and straightforward.

---

**Phase 2: CRM Identity and Data Integrity**

**Rationale:** First thing operators see. Corrupted contact data is irreversible. Unblocks metrics and admin commands (both require real contact identity).

**Delivers:** Real phone numbers everywhere, custom fields saving, tags end-to-end, history preserved, schema_migrations tracking added.

**Addresses:** LID ingestion fix, display normalization across all surfaces, custom fields bug, tags, conversation history.

**Avoids:** PITFALL 2 (contact corruption), PITFALL 11 (schema drift)

**Research flag:** LID resolution timing window needs staging validation — instrument before declaring done.

---

**Phase 3: Admin Identity Service**

**Rationale:** First extraction from InstanceOrchestrator. Pure computation, near-zero risk. Prerequisite for all admin command features. Decouples admin identity from optional learning module.

**Delivers:** AdminIdentityService — single source of truth, typed AdminIdentityContext, first gate in message processing.

**Implements:** Architecture extraction Phase 1

**Avoids:** PITFALL 9 (admin false positives)

**Research flag:** None. Interface fully specified in ARCHITECTURE.md.

---

**Phase 4: Session Lifecycle Formalization**

**Rationale:** Central architectural work. Metrics, intent detection, human takeover, and document dispatch all need a formalized session record. Medium risk — use SESSION_LIFECYCLE_V2 feature flag with shadow-run staging validation.

**Delivers:** ConversationSessionManager, SessionLifecycleService, Redis session hash, BullMQ timeout queue with deduplication, ConversationSession table, worker crash to DISCONNECTED fix, humanTakeover DB-persisted.

**Implements:** Architecture extraction Phases 2 and 3

**Avoids:** PITFALLS 7, 8 (race conditions, stale instance status)

**Research flag:** BullMQ deduplication TTL/delay interaction — test with 2-minute timeout in staging before deploying 10-minute values.

---

**Phase 5: Intent Detection and AI Conversational Improvements**

**Rationale:** Plugs into the formalized lifecycle (Phase 4). The LLM classifier is the trigger for automatic state transitions. Unlocks urgency scoring and human takeover auto-trigger.

**Delivers:** Groq LLM pre-pass classifier, automatic ENCERRAMENTO to confirmacao_enviada transition, URGENCIA_ALTA urgency score, TRANSFERENCIA_HUMANO immediate trigger, graceful fallback response with admin escalation.

**Avoids:** Anti-feature A1 (regex pt-BR detection)

**Research flag:** pt-BR ENCERRAMENTO accuracy — validate with 50+ real Brazilian closure expressions in staging before production.

---

**Phase 6: Metrics and Daily Summary**

**Rationale:** Requires formalized sessions (Phase 4) and intent data (Phase 5). Architecture extraction Phase 4 — purely additive, low risk.

**Delivers:** SessionMetricsCollector, ConversationMetric table, dashboard metrics panel, daily summary WhatsApp delivery, urgency priority queue surface.

**Implements:** Architecture extraction Phase 4

**Research flag:** None. Standard patterns.

---

**Phase 7: Admin Commander via WhatsApp**

**Rationale:** Differentiator feature. Built on AdminIdentityService (Phase 3) and formalized sessions (Phase 4). Comes after all foundations are stable.

**Delivers:** Prefix command parser, Groq AI fallback for free-text, document dispatch pipeline (Baileys URL-based send), AdminActionLog table, system status queries.

**Addresses:** Differentiator features D1 and D4 from FEATURES.md

**Research flag:** PDF generation library (pdfkit vs @react-pdf/renderer) — decide at phase start based on document complexity.

---

**Phase 8: Continuous Learning Polish**

**Rationale:** Highest-risk extraction. Most deeply entangled. Saved for last when all other foundations are stable.

**Delivers:** Confirmation step before knowledge ingestion, conflict detection, escalation window limit (4h), audit trail panel, Null Object pattern fully applied, ContinuousLearningService extracted from orchestrator.

**Implements:** Architecture extraction Phase 5

**Avoids:** PITFALL 10 (knowledge contamination)

**Research flag:** None. Patterns fully specified.

---

### Phase Ordering Rationale

- Security blockers come first: lowest implementation cost, highest severity if shipped
- CRM identity before everything else: corrupted contact data is irreversible; all downstream features need real identity
- Admin identity extraction before admin commands: cannot build reliable commands on fragile identity check
- Session lifecycle before metrics/intent/documents: all of those need a session record to attach to
- Intent detection before admin dashboard queue: urgency scoring requires the classifier
- Metrics before admin commander: commander needs to return metrics on demand
- Continuous learning last: most entangled extraction; requires all prior phases to be stable

### Research Flags

**Needs staging validation before declaring done:**
- Phase 2: LID resolution timing window after connection.update: open
- Phase 4: BullMQ deduplication TTL/delay interaction (test with 2-minute timeout first)
- Phase 5: pt-BR ENCERRAMENTO classifier accuracy (50+ real expressions before production)

**Standard patterns (skip research-phase):**
- Phase 1: All four security fixes are identified and trivial
- Phase 3: AdminIdentityService interface fully specified in ARCHITECTURE.md
- Phase 6: EventEmitter + setImmediate() metrics pattern is standard
- Phase 8: Null Object pattern and interface are fully designed

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Core stack is running production code. BullMQ deduplication verified against official docs. |
| Features | MEDIUM-HIGH | Table stakes verified against multiple WhatsApp CRM products. pt-BR LLM classification is MEDIUM — high-resource language but no specific benchmark found. |
| Architecture | HIGH | Based on direct codebase inspection (service.ts, module-runtime.ts, CONCERNS.md). Extraction sequence verified against real code dependencies. |
| Pitfalls | HIGH | Security pitfalls verified against OWASP and Fastify CORS docs. Baileys LID verified against GitHub issues #1718, #2142. BullMQ race conditions verified against issues #2876, #3427. |

**Overall confidence:** HIGH for security and architecture decisions. MEDIUM for Baileys-specific behaviors (unofficial API, no official documentation).

### Gaps to Address

- **LID resolution timing window** — how long after connection.update: open until signalRepository.lidMapping is populated. Instrument in staging; do not assume it is instant.
- **BullMQ deduplication TTL/delay interaction** — whether a deduplication entry survives its TTL while the job is still in delayed state. Test before production deployment.
- **CLOSE_INTENT in existing IntentRouter** — verify whether GeneralAgent already returns a close signal or whether a new explicit ENCERRAMENTO route is needed. Check before implementing Phase 5.
- **PDF generation library** — deferred to Phase 7. Decide between pdfkit (simpler, no native deps) and @react-pdf/renderer (React-based templates) based on document complexity.
- **Baileys official API migration path** — not in scope, but the god-class refactor is a prerequisite. Flag for post-milestone: the cleaned-up InstanceOrchestrator boundary is the right abstraction for swapping Baileys for Evolution API or WhatsApp Cloud API.

---

## Sources

### Primary (HIGH confidence)
- BullMQ Deduplication — https://docs.bullmq.io/guide/jobs/deduplication
- BullMQ Timeout Jobs — https://docs.bullmq.io/patterns/timeout-jobs
- OWASP CSRF Prevention — https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Codebase direct inspection: apps/api/src/modules/instances/service.ts (5,150 lines)
- .planning/codebase/CONCERNS.md — technical debt and risk audit

### Secondary (MEDIUM confidence)
- Baileys LID issues — https://github.com/WhiskeySockets/Baileys/issues/1718, #1554, #2142
- BullMQ race condition issues — https://github.com/taskforcesh/bullmq/issues/2534, #2876, #3427
- Baileys document sending guide — https://guide.whiskeysockets.io/docs/tutorial-basics/sending-messages/
- WhatsApp media size limits — https://help.quickreply.ai/portal/en/kb/articles/what-are-the-media-file-size-limits-and-aspect-ratio-in-whatsapp-business-api
- Domain Events (Khalil Stemmler) — https://khalilstemmler.com/articles/typescript-domain-driven-design/chain-business-logic-domain-events/
- Strangler Fig — https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-decomposing-monoliths/strangler-fig.html
- Redis session management — https://redis.io/solutions/session-management/

### Tertiary (MEDIUM-LOW confidence)
- WhatsApp 24-hour window and ban risk — community consensus across multiple vendor guides
- Baileys ban prevention thresholds (8/min, 200/hr, 1500/day) — community-established, not official WhatsApp documentation
- pt-BR intent classification accuracy — inferred from LLM capability on high-resource language; no specific benchmark

---

*Research completed: 2026-04-10*
*Ready for roadmap: yes*
