# InfraCode WhatsApp API Platform

Plataforma enterprise self-hosted para automação e gestão avançada do WhatsApp usando Baileys, Fastify, Prisma, Redis/BullMQ, Next.js 14 e observabilidade com Prometheus/Grafana.

## Estrutura

- `apps/api`: backend Fastify, sessões Baileys, OpenAPI, filas e webhooks
- `apps/panel`: painel administrativo em Next.js 14 + Tailwind + componentes estilo shadcn/ui
- `apps/worker`: processador BullMQ
- `packages/types`: contratos compartilhados
- `packages/sdk-js`: SDK oficial JavaScript/TypeScript
- `packages/ui`: componentes reutilizáveis do painel
- `infra`: Docker, Compose, Nginx e Grafana
- `prisma`: schema do banco

## Fluxo recomendado

1. Configure `.env` a partir de `.env.example`.
2. Suba a infraestrutura com `docker compose -f infra/compose/docker-compose.dev.yml up -d`.
3. Gere o Prisma Client com `pnpm prisma:generate`.
4. Rode a migração inicial com `pnpm prisma:migrate`.
5. Inicie API, painel e worker com `pnpm dev`.

## Bootstrap inicial

Quando `ENABLE_AUTH=true`, use `POST /bootstrap` apenas na primeira inicializacao para criar:

- o primeiro tenant
- a primeira API key admin

Exemplo:

```bash
curl -X POST http://localhost:3333/bootstrap ^
  -H "Content-Type: application/json" ^
  -d "{\"tenantName\":\"InfraCode Demo\",\"tenantSlug\":\"infracode-demo\",\"apiKeyName\":\"Bootstrap Admin\"}"
```

Depois disso, use `x-tenant-id` e `x-api-key` em todas as rotas protegidas.

## Endpoints novos de operacao

- `GET /api-keys`
- `POST /api-keys`
- `DELETE /api-keys/:id`
- `GET /privacy/contacts/:phoneNumber/export`
- `DELETE /privacy/contacts/:phoneNumber`

## Testes

- Smoke test rapido: `pnpm --filter @infracode/api test`
- Teste com PostgreSQL real: suba `postgres` e `redis`, exporte `RUN_DB_TESTS=true` e rode `pnpm --filter @infracode/api test`

## Observações arquiteturais

- Cada instância WhatsApp é isolada em `worker_threads`.
- A autenticação Baileys é persistida por instância em SQLite criptografado em repouso.
- Mensageria, envio em lote e webhooks usam BullMQ para desacoplamento e retentativas.
- A implementação atual usa `tenantId` em todas as entidades de runtime; a separação física por schema pode ser ativada por um provisionador dedicado sem alterar os contratos externos.
