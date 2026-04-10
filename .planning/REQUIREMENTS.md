# Requirements: Infracode WhatsApp Platform — v1 Production

**Defined:** 2026-04-10
**Core Value:** O atendimento via WhatsApp deve funcionar de ponta a ponta de forma confiável — do contato inicial à sessão encerrada — com dados reais, métricas precisas e módulos que degradam graciosamente quando desativados.

## v1 Requirements

### Segurança (Pré-Launch)

- [ ] **SEC-01**: CORS configurado com allowlist explícita — sem `origin: true`
- [ ] **SEC-02**: Auth bypass restrito exclusivamente a `NODE_ENV=development` — staging e preview exigem auth real
- [ ] **SEC-03**: `aiFallbackApiKey` criptografado com o mesmo padrão de `aiApiKeyEncrypted`
- [ ] **SEC-04**: Arquivos de sessão WhatsApp (SQLite/auth state) fora do repositório git e no `.gitignore`

### CRM — Identidade e Dados

- [ ] **CRM-01**: LID/JID normalizado na ingestão — número real armazenado no banco desde o início, nunca código interno
- [ ] **CRM-02**: Exibição de número formatado em todos os pontos do CRM — sem `@lid` ou JID cru visível ao usuário
- [ ] **CRM-03**: Campos de captura de dados personalizados salvando e carregando corretamente
- [ ] **CRM-04**: Histórico completo de conversas exibido por contato, sem perda entre sessões
- [ ] **CRM-05**: Tags de contato funcionando de ponta a ponta: criar, atribuir, filtrar
- [ ] **CRM-06**: Interface visual sem estados quebrados: dados faltando, textos brutos, erros silenciosos
- [ ] **CRM-07**: Envio de mensagem a partir do CRM usando identificador correto (nunca LID)

### Admin Identity

- [ ] **ADM-01**: Admin do tenant identificado de forma confiável em todo fluxo de mensagens — nunca tratado como cliente
- [ ] **ADM-02**: Identificação de admin desacoplada do módulo `aprendizadoContinuo` — funciona mesmo com módulo desativado
- [ ] **ADM-03**: JID do admin resolvido via `sock.onWhatsApp()` na abertura de conexão e cacheado no Redis
- [ ] **ADM-04**: Super admin da plataforma (platform owner) reconhecido corretamente em todas as rotas do painel

### Ciclo de Vida da Sessão

- [ ] **SESS-01**: Estados formais de sessão: `ATIVA`, `AGUARDANDO_CLIENTE`, `CONFIRMACAO_ENVIADA`, `INATIVA`, `ENCERRADA`
- [ ] **SESS-02**: Estado de sessão persistido em Redis (com TTL 24h) e PostgreSQL — não apenas em memória
- [ ] **SESS-03**: Timeout de 10 minutos sem resposta dispara mensagem "Ainda deseja continuar o atendimento?"
- [ ] **SESS-04**: Timeout implementado com BullMQ deduplication (`extend: true`) — timer resetado a cada mensagem do cliente
- [ ] **SESS-05**: Sessão não encerrada abruptamente — sempre tenta confirmação antes de marcar como inativa
- [ ] **SESS-06**: `humanTakeover` persistido no banco de dados — não se perde em restart do worker
- [ ] **SESS-07**: Quando `humanTakeover` ativo, bot para de responder completamente naquela conversa
- [ ] **SESS-08**: Horário de início, fim e duração de cada sessão registrados
- [ ] **SESS-09**: Encerramento automático detectado por intenção do cliente: "obrigado", "era só isso", "pode encerrar", etc.

### Detecção de Intenção e IA Conversacional

- [ ] **IA-01**: Classificador de intenção via LLM (pré-processamento antes do chatbot principal) para pt-BR
- [ ] **IA-02**: Intenções reconhecidas: `ENCERRAMENTO`, `TRANSFERENCIA_HUMANO`, `URGENCIA_ALTA`, `DUVIDA_GENERICA`
- [ ] **IA-03**: Chatbot não trava em situações inesperadas — contorna e informa quando não sabe responder
- [ ] **IA-04**: Quando não sabe a resposta: informa o cliente claramente e (se módulo ativo) escala ao admin
- [ ] **IA-05**: Conversa não linear: fluxo adapta-se ao contexto, não segue script fixo rígido
- [ ] **IA-06**: Transferência para humano via intenção detectada ou comando admin — notifica admin via WhatsApp

### Métricas e Resumo Diário

- [ ] **MET-01**: Tabela `ConversationMetric` no schema tenant: atendimentos iniciados, encerrados, inativos, transferidos
- [ ] **MET-02**: Tempo médio de atendimento calculado por dia
- [ ] **MET-03**: Tempo médio até primeira resposta do bot calculado por sessão
- [ ] **MET-04**: Taxa de continuação após mensagem de inatividade
- [ ] **MET-05**: Contagem de documentos enviados por sessão
- [ ] **MET-06**: Resumo diário enviado ao admin via WhatsApp com métricas reais (quando módulo ativo)
- [ ] **MET-07**: Dashboard no painel com fila de atendimento e status das sessões ativas

### Admin Commander via WhatsApp

- [ ] **CMD-01**: Admin pode enviar comandos prefixados (`/contrato`, `/proposta`, `/status`) via WhatsApp
- [ ] **CMD-02**: Admin pode enviar comandos em linguagem natural — classificados por LLM
- [ ] **CMD-03**: Comando de envio de documento: sistema identifica cliente, monta mensagem personalizada, envia PDF
- [ ] **CMD-04**: Mensagem gerada automaticamente com nome do cliente e contexto do documento
- [ ] **CMD-05**: Registro de todas as ações admin: quem, quando, cliente, documento, mensagem, status de envio
- [ ] **CMD-06**: Admin pode perguntar sobre o funcionamento do sistema e receber resposta clara via WhatsApp

### Envio de Documentos

- [ ] **DOC-01**: Chatbot pode enviar documentos (PDF, contrato, proposta) durante fluxo automatizado
- [ ] **DOC-02**: Envio via Baileys com `mimetype: 'application/pdf'` explícito e `fileName` definido
- [ ] **DOC-03**: Arquivo referenciado por URL — não buffer em memória para arquivos grandes
- [ ] **DOC-04**: Tamanho máximo respeitado: alerta se arquivo > 5 MB antes de enviar

### Aprendizado Contínuo — Polimento

- [ ] **APR-01**: Módulo desativado não impacta nenhuma funcionalidade de outro módulo
- [ ] **APR-02**: Gate de confirmação antes de ingerir resposta do admin no knowledge base
- [ ] **APR-03**: Admin recebe pergunta estruturada quando bot não sabe responder (com contexto da dúvida)
- [ ] **APR-04**: Resposta do admin passa por validação antes de virar "fato" no sistema
- [ ] **APR-05**: Log auditável de todo conhecimento adicionado: origem, data, admin responsável
- [ ] **APR-06**: Interface no painel para revisar e remover conhecimento adquirido

### Score de Urgência e Follow-up

- [ ] **URG-01**: Score de urgência por conversa baseado em intenção detectada e palavras-chave
- [ ] **URG-02**: Conversas de alta urgência destacadas no painel/fila
- [ ] **FOL-01**: Follow-up automático agendado com verificação da janela de 24h do WhatsApp
- [ ] **FOL-02**: Follow-up bloqueado automaticamente fora da janela — admin notificado

## v2 Requirements

### Escala e Performance

- **ESC-01**: Autenticação Baileys migrada para banco de dados (atualmente arquivo SQLite) para permitir horizontal scaling
- **ESC-02**: Writes de `ConversationMetric` em batch (a cada N segundos) para volume alto de mensagens
- **ESC-03**: Cache de configuração do admin por `(tenantId, instanceId)` com TTL curto

### Integrações Externas

- **INT-01**: Suporte a WhatsApp Business API oficial (WABA) como alternativa ao Baileys
- **INT-02**: Templates de mensagem certificados para envio fora da janela de 24h
- **INT-03**: Integração com CRMs externos (HubSpot, Salesforce) — webhook de saída

### Painel Avançado

- **PAN-01**: Tags automáticas por tipo de conversa
- **PAN-02**: Templates de mensagem por etapa de atendimento
- **PAN-03**: Alertas para platform owner quando instância de tenant é banida

## Out of Scope

| Feature | Reason |
|---------|--------|
| App mobile | Painel web é suficiente para o escopo atual |
| Múltiplos idiomas | Foco exclusivo em pt-BR |
| API pública para terceiros | Foco no painel próprio; SDK JS já existe separado |
| XState ou biblioteca de state machine | Overkill para 5 estados — BullMQ + enum PG resolve |
| Time-series database para métricas | PostgreSQL com índice em `(instanceId, startedAt)` é suficiente |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 a SEC-04 | Phase 1 | Pending |
| CRM-01 a CRM-07 | Phase 2 | Pending |
| ADM-01 a ADM-04 | Phase 3 | Pending |
| SESS-01 a SESS-09 | Phase 4 | Pending |
| IA-01 a IA-06 | Phase 5 | Pending |
| MET-01 a MET-07 | Phase 6 | Pending |
| CMD-01 a CMD-06 | Phase 7 | Pending |
| DOC-01 a DOC-04 | Phase 7 | Pending |
| APR-01 a APR-06 | Phase 8 | Pending |
| URG-01, URG-02, FOL-01, FOL-02 | Phase 8 | Pending |

**Coverage:**
- v1 requirements: 47 total
- Mapeados para fases: 47
- Sem fase: 0 ✓

---
*Requirements defined: 2026-04-10*
*Last updated: 2026-04-10 after initial definition*
