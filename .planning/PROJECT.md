# Infracode WhatsApp Platform — v1.0 Production

## What This Is

Plataforma SaaS multi-tenant para automação de atendimento via WhatsApp. Cada tenant gerencia suas próprias instâncias WhatsApp com chatbot com IA (classificador de intenção Groq LLM), CRM de contatos com LID/JID normalizado, ciclo de vida de sessão formalizado, módulos configuráveis (aprendizado contínuo, resumo diário, escalação, follow-up), admin management via WhatsApp, e painel de administração Next.js. Versão 1.0 entregou a plataforma em estado de produção — segura, com dados reais, e com módulos que degradam graciosamente.

## Core Value

O atendimento via WhatsApp deve funcionar de ponta a ponta de forma confiável — do contato inicial à sessão encerrada — com dados reais, métricas precisas e módulos que degradam graciosamente quando desativados.

## Requirements

### Validated (v1.0)

- ✓ Multi-tenant com isolamento via schemas PostgreSQL — existente — v1.0
- ✓ Instâncias WhatsApp via Baileys em Worker Threads — existente — v1.0
- ✓ Chatbot com IA + pipeline de processamento de mensagens — existente — v1.0
- ✓ BullMQ para envio assíncrono e dispatch de webhooks — existente — v1.0
- ✓ Painel Next.js com rotas para super-admin, tenant e instâncias — existente — v1.0
- ✓ CORS com allowlist explícita, auth bypass restrito a development, aiFallbackApiKey criptografado, session files fora do repo — v1.0 Phase 1
- ✓ CRM com LID/JID normalizado, formatPhone() centralizado, custom fields, tags, histórico cross-session — v1.0 Phase 2
- ✓ AdminIdentityService como único gate de identificação de admin — v1.0 Phase 3
- ✓ Ciclo de vida de sessão: estados Redis+PostgreSQL, BullMQ deduplication, humanTakeover persistido — v1.0 Phase 4
- ✓ Classificador de intenção Groq LLM (ENCERRAMENTO, URGENCIA_ALTA, TRANSFERENCIA_HUMANO, PERGUNTA, CONTINUACAO, OUTRO) — v1.0 Phase 5
- ✓ Resposta honesta "não sei" + escalação estruturada ao admin — v1.0 Phase 5
- ✓ ConversationMetric table, SessionMetricsCollector, dashboard metrics, DailySummaryService — v1.0 Phase 6
- ✓ AdminCommandHandler (Tier 1 prefix + Tier 2 LLM), DocumentDispatchService, AdminActionLog — v1.0 Phase 7
- ✓ IAprendizadoContinuoModule Null Object, confirmation gate, FollowUpService com 24h window — v1.0 Phase 8

### Active (v1.1 candidates)

**Feature Flags → Panel**
- [ ] `SESSION_LIFECYCLE_V2` promovido para config por instância no painel (atualmente env var)
- [ ] `INTENT_CLASSIFIER_V2` promovido para módulo no painel (atualmente env var)

**Pendências v1.0**
- [ ] Phase 8 Plan 04 Task 3: urgency score wiring no dashboard (URG-02 — partially shipped)
- [ ] VERIFICATION.md retroativos para fases 2, 3, 4, 6, 8 (evidência existe em SUMMARY.md)

**Próximo milestone (a definir)**
- [ ] Horizontal scaling: autenticação Baileys migrada para banco de dados (ESC-01)
- [ ] WhatsApp Business API oficial como alternativa ao Baileys (INT-01)
- [ ] Templates de mensagem certificados para fora da janela 24h (INT-02)
- [ ] Tags automáticas por tipo de conversa (PAN-01)

### Out of Scope

- Múltiplos idiomas além do português — sem demanda atual
- SDK público / API pública para terceiros — foco é o painel próprio
- Integração com CRMs externos (HubSpot, Salesforce) — fora do escopo agora
- App mobile — painel web é suficiente
- XState ou biblioteca de state machine — BullMQ + enum PG resolve
- Time-series database para métricas — PostgreSQL com índice em `(instanceId, startedAt)` é suficiente

## Context

**Codebase atual (v1.0):**
- Monorepo pnpm com `apps/api` (Fastify), `apps/panel` (Next.js 14), `apps/worker` (BullMQ)
- `InstanceOrchestrator` em `apps/api/src/modules/instances/service.ts` (~5.200 linhas) — extração incremental via InstanceEventBus em andamento
- `AdminIdentityService` extraído como serviço único; `ConversationSessionManager`, `SessionLifecycleService`, `DailySummaryService`, `AdminCommandHandler`, `DocumentDispatchService`, `StatusQueryService`, `FollowUpService` todos extraídos
- `IAprendizadoContinuoModule` interface com Null Object pattern — 0 guards `isEnabled` no código
- Feature flags: `SESSION_LIFECYCLE_V2=false`, `INTENT_CLASSIFIER_V2=false` (padrão) — funcionalidade implementada, ativação manual para produção
- Redis para sessões, rate limit, heartbeats, e JID cache de admin
- BullMQ queues: session-timeout, follow-up, knowledge-synthesis, chatbot processing
- PostgreSQL: platform schema (Prisma) + tenant schemas (buildTenantSchemaSql + runMigrations)
- Prisma com dois schemas (platform + tenant), criptografia de API keys, env validação com Zod

**Estado pós-v1.0:**
- 8 fases, 34 planos completos
- 487 commits, 41 dias de desenvolvimento
- Plataforma pronta para receber clientes reais (com ativação de feature flags em staging primeiro)

**Débito técnico registrado:**
- `SESSION_LIFECYCLE_V2` e `INTENT_CLASSIFIER_V2` como env vars — ativar em staging, depois produção
- 5 fases sem VERIFICATION.md retroativo
- Phase 8 Plan 04 Task 3 (URG-02 dashboard wiring) pendente

## Constraints

- **Compatibilidade**: Módulo de aprendizado contínuo deve ser 100% opcional — ✓ garantido via Null Object
- **Estabilidade**: Refatorações no `InstanceOrchestrator` devem ser graduais — continua no v1.1
- **Segurança**: CORS, criptografia e auth bypass — ✓ corrigidos em Phase 1
- **Dados**: LID/JID resolvido em todos os pontos de exibição — ✓ fase 2

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Null Object pattern para `aprendizadoContinuo` | Sistema deve funcionar sem ele; elimina 14+ guards isEnabled | ✓ Good — v1.0 Phase 8 |
| InstanceEventBus (typed EventEmitter) como seam de desacoplamento | Extração incremental do InstanceOrchestrator sem big-bang rewrite | ✓ Good — v1.0 Phase 4 |
| BullMQ deduplication `extend:true` para session timeouts | O(1) reset em atividade, survives restarts | ✓ Good — v1.0 Phase 4 |
| Redis (live) + PostgreSQL (durable) para estado de sessão | Nunca apenas Map in-process; sobrevive a restarts | ✓ Good — v1.0 Phase 4 |
| Base64 com gate 5 MB para document dispatch | Baileys não suporta file:// URLs locais; gate mitiga risco de memória | ✓ Good — v1.0 Phase 7 |
| AdminCommandHandler Tier 1 + Tier 2 (prefix + LLM) | Comandos explícitos + linguagem natural sem regex por extensão | ✓ Good — v1.0 Phase 7 |
| Feature flags SESSION_LIFECYCLE_V2 e INTENT_CLASSIFIER_V2 | Staging validation antes de produção para features de alto risco | ⚠️ Revisit — flags ainda em env var, não no painel |
| Refatoração gradual do InstanceOrchestrator (não big-bang) | Evitar quebrar funcionalidades existentes durante a finalização | ✓ Good — continua v1.1 |

## Evolution

**Após cada transição de fase** (via `/gsd-transition`):
1. Requirements invalidados? → Mover para Out of Scope com motivo
2. Requirements validados? → Mover para Validated com referência da fase
3. Novos requirements emergiram? → Adicionar em Active
4. Decisões a registrar? → Adicionar em Key Decisions
5. "What This Is" ainda preciso? → Atualizar se divergiu

**Após cada milestone** (via `/gsd-complete-milestone`):
1. Revisão completa de todas as seções
2. Core Value ainda é a prioridade certa?
3. Auditar Out of Scope — motivos ainda válidos?
4. Atualizar Context com estado atual

---
*Last updated: 2026-04-25 after v1.0 milestone*
