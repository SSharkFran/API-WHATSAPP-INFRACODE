# Infracode WhatsApp Platform — v1 Production

## What This Is

Plataforma SaaS multi-tenant para automação de atendimento via WhatsApp. Cada tenant gerencia suas próprias instâncias WhatsApp com chatbot com IA, CRM de contatos, módulos configuráveis (aprendizado contínuo, resumo diário, escalação) e um painel de administração. O projeto existe e funciona como protótipo — este milestone é sobre finalizá-lo com qualidade de produção: sem bugs visuais, dados corretos, módulos confiáveis, e pronto para receber clientes reais.

## Core Value

O atendimento via WhatsApp deve funcionar de ponta a ponta de forma confiável — do contato inicial à sessão encerrada — com dados reais, métricas precisas e módulos que degradam graciosamente quando desativados.

## Requirements

### Validated

- ✓ Multi-tenant com isolamento via schemas PostgreSQL — existente
- ✓ Instâncias WhatsApp via Baileys em Worker Threads — existente
- ✓ Chatbot com IA + pipeline de processamento de mensagens — existente
- ✓ CRM básico: lista de contatos, mensagens, tags, notas — existente (parcial)
- ✓ Módulo de aprendizado contínuo (aprendizadoContinuo) com verificação de admin — existente (parcial)
- ✓ BullMQ para envio assíncrono e dispatch de webhooks — existente
- ✓ Painel Next.js com rotas para super-admin, tenant e instâncias — existente
- ✓ Ciclo de vida formal da sessão (ATIVA → CONFIRMACAO_ENVIADA → ENCERRADA/INATIVA) com Redis + PostgreSQL — Validated in Phase 4: session-lifecycle-formalization
- ✓ BullMQ session-timeout queue com deduplication.extend para reset de timer em O(1) — Validated in Phase 4
- ✓ ConversationSessionManager, SessionStateService, SessionLifecycleService, InstanceEventBus extraídos do InstanceOrchestrator — Validated in Phase 4
- ✓ humanTakeover persiste em PostgreSQL e sobrevive a restart do servidor — Validated in Phase 4
- ✓ Feature flag SESSION_LIFECYCLE_V2 guarda toda atividade de BullMQ — Validated in Phase 4

### Active

**CRM — Correções e Polimento**
- [ ] Resolver bug LID/JID: exibir sempre número real formatado, nunca o código interno `@lid`
- [ ] Captura de dados personalizados: módulo de campos customizados funcional e salvando corretamente
- [ ] Histórico completo de conversas: contexto preservado entre sessões, não perde dados
- [ ] Interface visual polida: sem estados quebrados, sem dados faltando, sem textos brutos
- [ ] Tags e categorização de contatos funcionando de ponta a ponta

**Super Admin (Plataforma)**
- [ ] Reconhecimento correto do super admin da plataforma (platform owner) em todas as rotas e contextos
- [ ] Painel super-admin com visibilidade real dos tenants, instâncias e uso

**Admin do Tenant via WhatsApp**
- [ ] Identificação confiável do admin do tenant na conversa WhatsApp (nunca tratado como cliente)
- [ ] Conversa do admin como interface de comando: perguntar sobre funcionamento, status do sistema, métricas
- [ ] Comandos administrativos via WhatsApp: "envie o contrato para o cliente X", "mande a proposta para fulano"
- [ ] Geração automática de mensagem personalizada ao enviar documento (com nome do cliente)
- [ ] Sistema responde a perguntas sobre seu próprio funcionamento quando admin pergunta

**Ciclo de Vida da Sessão**
- [ ] Detecção automática de encerramento: cliente disse "obrigado", "era só isso", "pode encerrar", etc.
- [ ] Estados de sessão: `ativa`, `aguardando_cliente`, `confirmacao_enviada`, `encerrada`, `inativa`
- [ ] Timeout de 10 minutos: enviar mensagem de continuidade "Ainda deseja continuar o atendimento?"
- [ ] Se cliente não responder após mensagem de confirmação: marcar sessão como `inativa` ou `encerrada`
- [ ] Registro de horário de início, fim e duração de cada sessão
- [ ] Encerramento nunca agressivo: sempre confirmar antes de fechar por inatividade

**Métricas e Resumo Diário**
- [ ] Atendimentos iniciados / encerrados / inativos por dia
- [ ] Tempo médio de atendimento
- [ ] Tempo médio até primeira resposta
- [ ] Atendimentos transferidos para humano
- [ ] Taxa de continuação após mensagem de inatividade
- [ ] Documentos enviados
- [ ] Resumo diário enviado ao admin via WhatsApp (quando módulo ativo)

**Envio de Documentos**
- [ ] Chatbot pode enviar documentos (PDF, contrato, proposta) durante fluxo
- [ ] Admin pode solicitar envio via comando no WhatsApp
- [ ] Registro no histórico: quem solicitou, quando, cliente, documento, status

**Aprendizado Contínuo — Polimento**
- [ ] Módulo desativado não quebra nenhuma outra funcionalidade (degradação graciosa garantida)
- [ ] Quando ativo: pergunta ao admin sobre respostas que o sistema não soube dar
- [ ] Sistema aprende com a resposta do admin e incorpora ao conhecimento
- [ ] Interface de configuração do módulo clara e funcional no painel
- [ ] Logs de aprendizado auditáveis

**IA Conversacional — Menos Linear**
- [ ] Chatbot entende intenção do cliente (não apenas segue fluxo fixo)
- [ ] Quando não sabe a resposta: informa claramente ao cliente E (se módulo ativo) escala ao admin
- [ ] Conversa não linear: contorna situações inesperadas em vez de travar
- [ ] Transferência para humano: marcar conversa como `humanTakeover`, notificar admin

**Funcionalidades Avançadas (v1 completo)**
- [ ] Score de urgência por conversa (classifica prioridade)
- [ ] Dashboard de fila de atendimento
- [ ] Follow-up automático: lembrete de retorno para cliente
- [ ] Histórico de ações administrativas (tudo que admin dispara fica registrado)

### Out of Scope

- Múltiplos idiomas além do português — sem demanda atual
- SDK público / API pública para terceiros — foco é o painel próprio
- Integração com CRMs externos (HubSpot, Salesforce) — fora do escopo agora
- App mobile — painel web é suficiente

## Context

**Codebase atual:**
- Monorepo pnpm com `apps/api` (Fastify), `apps/panel` (Next.js 14), `apps/worker` (BullMQ)
- `InstanceOrchestrator` em `apps/api/src/modules/instances/service.ts` (5.150 linhas) — deus-objeto que precisa de extração gradual
- Módulo `aprendizadoContinuo` já existe com verificação por código, múltiplos phones de admin, e envio de resumo diário
- CRM screen existe em `apps/panel/components/tenant/crm-screen.tsx` com normalização de LID/JID já parcialmente implementada
- Estados de sessão e ciclo de vida ainda não existem como entidade formal — lógica está espalhada no orchestrator
- Admin do tenant é identificado via `aprendizadoContinuo.verifiedPhone` — mas o reconhecimento é frágil e às vezes falha

**Bugs críticos conhecidos:**
- LID/JID sendo exibido no lugar do número real em várias partes do CRM
- Admin do tenant sendo tratado como cliente em alguns fluxos
- Campos de captura de dados personalizados não salvando corretamente
- `aiFallbackApiKey` armazenado sem criptografia (segurança)
- CORS configurado com `origin: true` (segurança)

**Decisões de arquitetura já tomadas:**
- TypeScript strict em todo o projeto
- Fastify com injeção de dependência via decorators
- Prisma com dois schemas (platform + tenant)
- Redis para filas, rate limit e heartbeats de instâncias
- BullMQ para operações assíncronas

## Constraints

- **Compatibilidade**: Módulo de aprendizado contínuo deve ser 100% opcional — sistema funciona sem ele
- **Estabilidade**: Refatorações no `InstanceOrchestrator` devem ser graduais — não quebrar o que funciona
- **Segurança**: Corrigir CORS e criptografia do fallback API key antes de ir para produção
- **Dados**: Resolver LID/JID em todos os pontos de exibição, não apenas no CRM

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Aprendizado contínuo como módulo opcional | Sistema deve funcionar sem ele; não criar dependências rígidas | — Pending |
| Extrair ciclo de vida da sessão do InstanceOrchestrator | God-class com 5k linhas; sessão merece domínio próprio | ✓ Completo — Phase 4 entregou ConversationSessionManager, SessionStateService, SessionLifecycleService, InstanceEventBus |
| Admin identificado pelo número verificado no módulo aprendizadoContinuo | Já existe infraestrutura de verificação | — Pending |
| Refatoração gradual (não big-bang) | Evitar quebrar funcionalidades existentes durante a finalização | — Pending |

## Evolution

**Current State:** Phase 4 complete (2026-04-16) — session lifecycle formalized. Phase 5 (intent-detection-&-conversational-ai) is next.

Este documento evolui a cada transição de fase e milestone.

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
*Last updated: 2026-04-10 after initialization*
