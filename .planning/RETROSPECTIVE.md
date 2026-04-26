# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

---

## Milestone: v1.0 — Production

**Shipped:** 2026-04-25
**Phases:** 8 | **Plans:** 34 | **Timeline:** 41 dias (2026-03-15 → 2026-04-25)

### What Was Built

- Plataforma SaaS multi-tenant WhatsApp: chatbot IA, CRM, admin por WhatsApp, módulos configuráveis
- `AdminIdentityService`, `ConversationSessionManager`, `SessionLifecycleService`, `DailySummaryService`, `AdminCommandHandler`, `DocumentDispatchService`, `StatusQueryService`, `FollowUpService` — 8 serviços extraídos do `InstanceOrchestrator`
- `InstanceEventBus` typed EventEmitter como seam de desacoplamento entre todos os serviços
- `IAprendizadoContinuoModule` Null Object pattern — 0 guards `isEnabled` no codebase
- Classificador de intenção Groq LLM (ENCERRAMENTO/URGENCIA_ALTA/TRANSFERENCIA_HUMANO/PERGUNTA/CONTINUACAO/OUTRO)
- Confirmation gate para ingestão de conhecimento + log de auditoria no painel
- `FollowUpService` com verificação de janela 24h WhatsApp + business hours check

### What Worked

- **GSD TDD workflow (Wave 0 → Wave N)**: Scaffolds de teste RED antes da implementação mantiveram o escopo claro e reduziram bugs de regressão.
- **InstanceEventBus como seam incremental**: Extrações de serviço sem quebrar o InstanceOrchestrator — cada serviço subscribes a eventos, orchestrator apenas emite.
- **Null Object pattern para módulos opcionais**: Eliminar guards `isEnabled` de 14+ locais foi possível porque o pattern foi estabelecido cedo (Phase 3) e formalizado em Phase 8.
- **3-source audit methodology** (VERIFICATION.md + SUMMARY.md frontmatter + REQUIREMENTS.md): Permitiu auditoria de milestone mesmo com REQUIREMENTS.md nunca atualizado durante execução.
- **BullMQ deduplication `extend:true`** para session timeouts: Elegante, O(1), sem race conditions.
- **Sessões pausadas com `.continue-here.md` + `HANDOFF.json`**: Contexto preservado perfeitamente entre sessões longas.

### What Was Inefficient

- **REQUIREMENTS.md traceability nunca atualizado**: Durante 8 fases e 34 planos, nenhuma fase atualizou os checkboxes de requisitos. Tornou necessário o 3-source audit manual no final. Fix para v1.1: adicionar update de REQUIREMENTS.md como step obrigatório no `gsd-transition`.
- **VERIFICATION.md para 5 fases não criado**: Fases 2, 3, 4, 6, 8 executaram sem criar VERIFICATION.md. Evidência existe em SUMMARY.md, mas gera dívida técnica e dificulta auditorias futuras.
- **Feature flags SESSION_LIFECYCLE_V2 e INTENT_CLASSIFIER_V2 como env vars**: Duas das features mais críticas do milestone precisam de ativação manual em staging antes de ir para produção. Deveria ter sido planejado como uma fase de "feature activation" no final do milestone.
- **Phase 8 Plan 04 parou no Task 3**: Milestone encerrou com uma tarefa pendente de verificação humana (urgency score dashboard wiring). A checkpoint:human-verify deveria ter sido agendada explicitamente.
- **Double-execution do adminCommandService (legacy block)**: O bloco legado em `service.ts:3479` não foi removido no Phase 7 como planejado — só foi descoberto no audit de milestone. Custou uma sessão adicional de bugfix.

### Patterns Established

- **Wave 0 test scaffolds antes de qualquer implementação**: Garante que o escopo está claro e que há pelo menos um teste RED por requisito.
- **Typed EventEmitter (InstanceEventBus) como seam primário de extração**: Adicionar um serviço = subscribe to event; sem acoplamento direto ao orchestrator.
- **Null Object para módulos opcionais**: Módulo disabled = no-op em todos os métodos; nenhum guard no business logic.
- **`.continue-here.md` + `HANDOFF.json` para sessões longas**: Contexto completo preservado para retomada; constraints críticos documentados explicitamente.
- **3-source requirements cross-reference**: VERIFICATION.md (verificação formal) + SUMMARY.md frontmatter (evidência de implementação) + REQUIREMENTS.md (declaração de intent).

### Key Lessons

1. **Atualizar REQUIREMENTS.md na transição de fase, não no milestone**: Deixar para o final resulta em 47 checkboxes todos `[ ]` e necessidade de 3-source audit manual.
2. **Feature flags críticas precisam de plano de ativação explícito**: `SESSION_LIFECYCLE_V2` e `INTENT_CLASSIFIER_V2` precisam de staging validation antes de ir para produção — isso deveria ser uma fase ou tarefa explícita no roadmap.
3. **Remover legacy code no mesmo milestone que introduz o substituto**: O bloco legado em `service.ts:3479` deveria ter sido deletado em Phase 7 quando `AdminCommandHandler` foi criado — não dois milestones depois.
4. **Checkpoint:human-verify deve ter scheduling explícito**: Tasks que param em checkpoint precisam de data/prazo ou serão indefinidamente adiadas.
5. **Audit de milestone antes de completar**: `v1.0-MILESTONE-AUDIT.md` identificou 2 bugs reais (legacy block + humanTakeover bypass) que não teriam sido detectados sem o audit.

### Cost Observations

- Sessions: ~15-20 sessões estimadas ao longo de 41 dias
- Notable: Sessões longas (Phase 7, Phase 8) precisaram de handoff explícito; o `.continue-here.md` eliminou a perda de contexto. Audit de milestone foi eficiente mas revelou dívida técnica acumulada.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 8 | 34 | Processo GSD estabelecido; TDD Wave 0; InstanceEventBus como seam |

### Cumulative Quality

| Milestone | Tests (aprox) | Nyquist Compliant | Feature Flags |
|-----------|---------------|-------------------|---------------|
| v1.0 | ~200 | Phase 7 only | 2 (SESSION_LIFECYCLE_V2, INTENT_CLASSIFIER_V2) |

### Top Lessons (Verified Across Milestones)

1. **Traceability precisa ser mantida durante a execução**, não reconstruída no final — custo é 10x menor.
2. **Legacy code deve ser removido no mesmo milestone que introduz o substituto** — dívida técnica de código morto cresce exponencialmente com o tempo.
