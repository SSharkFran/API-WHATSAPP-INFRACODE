# Guia de Deploy

## Variáveis de ambiente obrigatórias

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `NODE_ENV` | Não | `development` | Ambiente de execução: `development`, `test` ou `production` |
| `PORT` | Não | `3333` | Porta HTTP da API |
| `HOST` | Não | `0.0.0.0` | Endereço de bind do servidor |
| `TRUST_PROXY` | Não | auto | Define `true` se estiver atrás de proxy reverso (ex: Railway, Nginx) |
| `APP_NAME` | Não | `InfraCode WhatsApp API` | Nome da aplicação |
| `DATABASE_URL` | **Sim** | — | URL PostgreSQL principal (formato: `postgresql://user:pass@host:5432/db`) |
| `DIRECT_DATABASE_URL` | Não | igual a `DATABASE_URL` | URL de conexão direta (sem pooler) — necessário para migrations em ambientes com PgBouncer |
| `PLATFORM_DATABASE_URL` | Não | igual a `DATABASE_URL` | URL do banco do schema `platform` |
| `PLATFORM_DIRECT_DATABASE_URL` | Não | igual a `DIRECT_DATABASE_URL` | URL direta do schema `platform` |
| `TENANT_DATABASE_URL` | Não | igual a `DATABASE_URL` | URL do banco do schema de tenant |
| `TENANT_DIRECT_DATABASE_URL` | Não | igual a `DIRECT_DATABASE_URL` | URL direta do schema de tenant |
| `REDIS_URL` | **Sim** | — | URL do Redis (ex: `redis://localhost:6379`) — usado por BullMQ, echo map, anti-spam, dedup |
| `API_ENCRYPTION_KEY` | **Sim** | — | Chave de criptografia para dados sensíveis no banco (mínimo 32 caracteres) |
| `WEBHOOK_HMAC_SECRET` | **Sim** | — | Segredo HMAC para assinatura de webhooks (mínimo 16 caracteres) |
| `JWT_SECRET` | **Sim** | — | Segredo para assinatura de tokens JWT (mínimo 8 caracteres) |
| `ROOT_DOMAIN` | Não | `infracode.local` | Domínio raiz da plataforma |
| `ADMIN_SUBDOMAIN` | Não | `admin` | Subdomínio do painel administrativo |
| `ACCESS_TOKEN_TTL_MINUTES` | Não | `15` | Tempo de vida do access token JWT em minutos |
| `REFRESH_TOKEN_TTL_DAYS` | Não | `14` | Tempo de vida do refresh token em dias |
| `INVITATION_TTL_HOURS` | Não | `72` | Validade de convites de usuário em horas |
| `PASSWORD_RESET_TTL_HOURS` | Não | `2` | Validade do link de reset de senha em horas |
| `TENANT_PRISMA_CACHE_MAX` | Não | `64` | Número máximo de clientes Prisma por tenant em cache |
| `TENANT_PRISMA_IDLE_TTL_MS` | Não | `600000` | Tempo em ms para expirar um cliente Prisma ocioso (padrão: 10 min) |
| `TENANT_PRISMA_CONNECTION_LIMIT` | Não | `2` | Limite de conexões por cliente Prisma de tenant |
| `ENABLE_AUTH` | **Sim em produção** | `false` | Deve ser `true` em produção — a API recusa inicializar se não estiver ativo |
| `DATA_DIR` | Não | `./apps/api/data` | Diretório local para arquivos de sessão WhatsApp e dados persistentes |
| `PUBLIC_API_BASE_URL` | Não | `http://localhost:3333` | URL pública da API (usada em links de webhook e e-mail) |
| `SMTP_FROM` | Não | `noreply@infracode.local` | Endereço remetente dos e-mails enviados pela plataforma |
| `GROQ_API_KEY` | **Sim** | — | Chave da API Groq para o LLM principal do chatbot |
| `GROQ_EXTRA_API_KEYS` | Não | — | Chaves Groq adicionais separadas por vírgula (rotação automática) |
| `GEMINI_API_KEY` | Não | — | Chave da API Google Gemini (gratuita em aistudio.google.com) |
| `OLLAMA_HOST` | Não | — | Host do servidor Ollama local (ex: `http://meu-servidor:11434`) |

### Variáveis exclusivas do painel (Next.js)

| Variável | Descrição |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | URL pública da API acessível pelo browser |
| `API_INTERNAL_BASE_URL` | URL interna da API (server-side do Next.js, ex: `http://api:3333`) |
| `NEXT_PUBLIC_TENANT_API_KEY` | API key do tenant para desenvolvimento local |
| `NEXT_PUBLIC_TENANT_ACCESS_TOKEN` | Access token de tenant para desenvolvimento local |
| `NEXT_PUBLIC_ADMIN_ACCESS_TOKEN` | Access token de admin para desenvolvimento local |
| `NEXT_PUBLIC_TENANT_SLUG` | Slug do tenant padrão em desenvolvimento |

### Variáveis de seed/inicialização

| Variável | Descrição |
|---|---|
| `PLATFORM_OWNER_EMAIL` | E-mail do usuário owner criado no seed inicial |
| `PLATFORM_OWNER_PASSWORD` | Senha do owner — **alterar imediatamente após o primeiro deploy** |
| `PLATFORM_OWNER_NAME` | Nome do owner da plataforma |
| `LETSENCRYPT_EMAIL` | E-mail para certificados Let's Encrypt (se usando Nginx + Certbot) |

---

## Filas BullMQ (Redis)

Ambas as filas são criadas em `apps/api/src/queues/` e conectam ao Redis configurado em `REDIS_URL`.

| Fila | Nome interno | Finalidade |
|---|---|---|
| `send-message` | `send-message` | Envio persistente de mensagens automáticas do chatbot. Garante que mensagens não se percam em caso de falha — o worker processa e envia via instância WhatsApp ativa. |
| `webhook-dispatch` | `webhook-dispatch` | Despacho de eventos de webhook para os endpoints cadastrados pelos tenants. Processa retentativas com backoff em caso de falha HTTP. |

> Ambas as filas são desativadas automaticamente em ambiente `test` (substituídas por noop).

---

## Novas funcionalidades desta versão (changelog)

- **Fila persistente BullMQ para mensagens automatizadas**: mensagens geradas pelo chatbot são enfileiradas no Redis via `send-message` queue, garantindo entrega mesmo após reinicializações.
- **Persistência Redis para echos e roteamento de alertas admin**: o mapa de echo e o roteamento de alertas administrativos agora sobrevivem a reinicializações da API.
- **Módulos de filtragem ativos**: suporte a blacklist de contatos, lista branca, filtro de horário comercial, anti-spam (com contagem Redis) e palavra-pausa configuráveis por instância via campo `modules` em `ChatbotConfig`.
- **Retry de escalação (lembrete 10 min)**: quando uma conversa aguarda resposta do admin, um lembrete é disparado automaticamente após 10 minutos se não houver resposta.
- **PENDING_REVIEW — janela de correção de 5 min**: ao receber uma mensagem de aprendizado, o sistema aguarda 5 minutos antes de confirmar o conhecimento, permitindo correção pelo admin.
- **Webhook `knowledge.learned`**: disparo de webhook ao confirmar novo conhecimento aprendido pelo chatbot.
- **Modo dry run com trace completo**: o endpoint de simulação do chatbot aceita flag `dryRun` e retorna trace detalhado de todas as decisões tomadas, sem efeitos colaterais.
- **Base de conhecimento CRUD no painel**: interface completa para listar, criar, editar e excluir entradas de conhecimento (`TenantKnowledge`) diretamente pelo painel.
- **Síntese IA visível e regenerável no painel**: a síntese gerada por IA da base de conhecimento (`knowledgeSynthesis`) é exibida no painel com botão de regeneração manual.

---

## Checklist pré-deploy

- [ ] Variáveis de ambiente configuradas no servidor (ver tabela acima)
- [ ] `ENABLE_AUTH=true` definido — a API **não inicializa** em produção sem isso
- [ ] `API_ENCRYPTION_KEY` com pelo menos 32 caracteres aleatórios
- [ ] `WEBHOOK_HMAC_SECRET` com pelo menos 16 caracteres aleatórios
- [ ] `JWT_SECRET` definido com valor seguro
- [ ] `GROQ_API_KEY` válida e com créditos disponíveis
- [ ] Redis acessível via `REDIS_URL` (necessário para: echo map, roteamento de alertas, anti-spam, dedup de daily summary, fila de mensagens, fila de webhooks, pending corrections)
- [ ] BullMQ worker rodando para a fila `send-message`
- [ ] BullMQ worker rodando para a fila `webhook-dispatch`
- [ ] `pnpm install` executado na raiz do monorepo
- [ ] `pnpm --filter api build` executado
- [ ] `pnpm --filter panel build` executado
- [ ] Prisma migrations aplicadas no schema principal: `npx prisma migrate deploy`
- [ ] Prisma migrations aplicadas no schema platform: `npx prisma migrate deploy --schema prisma/platform.prisma`
- [ ] Prisma migrations aplicadas no schema tenant: `npx prisma migrate deploy --schema prisma/tenant.prisma`
- [ ] `DATA_DIR` aponta para volume persistente (sessões WhatsApp serão perdidas se o diretório for efêmero)
- [ ] Senha do owner alterada após primeiro deploy (`PLATFORM_OWNER_PASSWORD`)
- [ ] Reiniciar processo da API

---

## Migrations existentes

As seguintes migrations foram aplicadas e devem estar presentes no banco de produção:

| Arquivo | Conteúdo |
|---|---|
| `20250319_add_ai_fallback.sql` | Campos de fallback de IA no `ChatbotConfig` |
| `20250319_add_platform_config_alerts.sql` | Configurações de alerta na `PlatformConfig` |
| `20260329000000_add_admin_learning` | Suporte a aprendizado admin e fluxo de pending review |
| `20260329001000_add_chatbot_response_delay` | Campo `responseDelayMs` no `ChatbotConfig` |
| `20260330100000_add_contact_persistent_memory` | Modelo `ContactPersistentMemory` para memória persistente por contato |

---

## Verificação pós-deploy

```bash
curl https://seu-dominio/health
```

Deve retornar `{ "status": "ok" }`.

### Verificações adicionais recomendadas

```bash
# Verificar filas BullMQ ativas
curl https://seu-dominio/admin/queues

# Confirmar que Redis está conectado (via logs da API na inicialização)
# Esperado: "Redis connected" nos logs de startup

# Testar autenticação
curl -X POST https://seu-dominio/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@infracode.local","password":"SuaSenha"}'
```
