# Roadmap: Infracode WhatsApp Platform

**Last updated:** 2026-04-25 — v1.0 milestone complete

---

## Milestones

- ✅ **v1.0 Production** — Phases 1–8 (shipped 2026-04-25)
- 📋 **v1.1** — Phases 9+ (not yet defined — run `/gsd-new-milestone`)

---

## Phases

<details>
<summary>✅ v1.0 Production (Phases 1–8) — SHIPPED 2026-04-25</summary>

- [x] Phase 1: Security Hardening (4/4 plans) — 4 fixes críticos pré-produção
- [x] Phase 2: CRM Identity & Data Integrity (5/5 plans) — LID/JID, custom fields, tags, history
- [x] Phase 3: Admin Identity Service (4/4 plans) — AdminIdentityService extraído, Redis JID cache
- [x] Phase 4: Session Lifecycle Formalization (4/4 plans) — estados Redis+PG, BullMQ, InstanceEventBus
- [x] Phase 5: Intent Detection & Conversational AI (4/4 plans) — Groq LLM classifier, auto-transitions
- [x] Phase 6: Metrics & Daily Summary (3/3 plans) — ConversationMetric, dashboard, DailySummaryService
- [x] Phase 7: Admin Commander & Document Dispatch (5/5 plans) — AdminCommandHandler, DocumentDispatch, AdminActionLog
- [x] Phase 8: Continuous Learning Polish & Advanced Features (5/5 plans) — Null Object, confirmation gate, FollowUpService

Full archive: [.planning/milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

### 📋 v1.1 (Planned)

Nenhuma fase definida ainda. Candidatos do backlog:

- [ ] Phase 9.1: Feature Flag Panel (promote SESSION_LIFECYCLE_V2 and INTENT_CLASSIFIER_V2 to tenant config)
- [ ] Phase 9.2: Phase 8 Plan 04 Task 3 completion — urgency score dashboard wiring
- [ ] Phase 10: [TBD — define with `/gsd-new-milestone`]

---

## Backlog

### Phase 999.1: INTENT_CLASSIFIER_V2 ativável pelo painel como módulo (BACKLOG)

**Goal:** Tornar o classificador de intenção LLM ativável por instância via painel, igual aos outros módulos do chatbot. Atualmente controlado apenas por `process.env.INTENT_CLASSIFIER_V2=true`.
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (promote with /gsd-review-backlog when ready)

---

*Milestone v1.0 archived: 2026-04-25*
*Next: `/gsd-new-milestone` para definir v1.1*
