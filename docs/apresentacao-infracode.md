# Apresentação do Projeto InfraCode

## 🚀 Visão Geral
InfraCode é uma plataforma integrada para automação e orquestração de atendimento por WhatsApp, com foco em multitenancy, segurança e rastreabilidade. O projeto reúne:
- API back-end (Node.js/TypeScript + Fastify)
- Painel administrativo (Next.js + React + Tailwind)
- Worker para processamento assíncrono
- Infraestrutura com Docker / Compose / Nginx / Postgres / Prometheus

## 🎯 Objetivos principais
1. Prover uma API unificada para envio/recebimento de mensagens via WhatsApp.
2. Oferecer painel de gestão de instâncias, usuários e permissões multi-tenant.
3. Garantir escalabilidade com filas e workers dedicados para processamento de eventos.
4. Centralizar métricas e monitoramento (Prometheus, Grafana).

## 🧩 Componentes do Projeto
- `apps/api`: serviços de API, configurações, plugins, rotas, scripts e testes.
- `apps/panel`: interface web de gestão para super admin, tenant e dashboard.
- `apps/worker`: processamento em background de filas e tarefas.
- `infra`: definições de Docker, compose e infraestrutura de deploy.
- `packages/sdk-js`: SDK para integração externa com o backend.
- `packages/ui`: componentes consumíveis de interface.

## 🛠️ Tecnologias utilizadas
- Node.js, TypeScript, Prisma
- Fastify, React, Next.js, Tailwind
- PostgreSQL, Redis (opcional), Docker
- Vitest para testes e integração contínua
- Prometheus / Grafana para observabilidade

## 📦 Como iniciar no ambiente de desenvolvimento
1. `pnpm install`
2. `pnpm --filter @infracode/api dev` (ou equivalente para cada app)
3. `docker-compose -f infra/compose/docker-compose.dev.yml up`
4. Configurar variáveis em arquivos `.env` conforme exemplos em `infra/compose`.

## 🔐 Segurança e multi-tenant
- Autenticação JWT + role-based access.
- Separação de dados por tenant (`tenantId`) no banco e queries.
- Fluxo de primeiro acesso, redefinição de senha e auditoria de ações.

## 📈 Casos de uso típicos
- Empresa contrata InfraCode para gestão de atendimento via WhatsApp.
- Super admin cria tenants e configura regras políticas.
- Tenant usa painel para cadastrar usuários, modelos de mensagens e integrações.
- Mensagens inbound/outbound são processadas por worker com retries e fila.
- Monitoramento avalia taxa de entrega, latência e erros.

## 🧾 Documentação adicional
- `README.md` (raiz) – visão geral do mono-repo.
- `docs/deployment/railway.md` – guia de deploy.
- `docs/openapi` – especificações de API.

---

## 📢 Contato
Para dúvidas de implementação ou customização, acesse `README.md` e a seção de `docs` do repositório ou procure o time de engenharia InfraCode.
