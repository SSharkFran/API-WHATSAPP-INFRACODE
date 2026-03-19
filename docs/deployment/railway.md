# Deploy no Railway

Este projeto pode rodar no Railway com cinco recursos:

- `api`
- `panel`
- `worker`
- PostgreSQL gerenciado
- Redis gerenciado

Se voce quiser usar exatamente os exemplos deste guia, nomeie os servicos assim no projeto Railway:

- `api`
- `panel`
- `worker`
- `Postgres`
- `Redis`

Se usar nomes diferentes, ajuste os namespaces das reference variables, por exemplo `\${{SEU_SERVICO.VARIAVEL}}`.

Para o Railway ler os manifests deste monorepo, configure o **Config File Path** de cada servico:

- `api`: `/apps/api/railway.json`
- `panel`: `/apps/panel/railway.json`
- `worker`: `/apps/worker/railway.json`

Importante:

- o **Root Directory** dos servicos `api`, `panel` e `worker` deve ficar em `/` ou em branco
- nao coloque `/apps/api/railway.json`, `/apps/panel/railway.json` ou `/apps/worker/railway.json` no **Root Directory**
- esses caminhos sao apenas para o campo **Config File Path**

Os manifests usam Dockerfiles do repositorio e watch patterns especificos para evitar rebuild desnecessario.

## Arquitetura recomendada

- `panel`: dominio publico para a UI
- `api`: dominio publico proprio para REST, WebSocket e Swagger
- `worker`: sem dominio publico
- volume persistente anexado ao `api` em `/data`

Motivo do volume:

- as sessoes Baileys e os arquivos SQLite por instancia ficam em `DATA_DIR`
- em Railway, o filesystem do container e efemero
- o `api` ja detecta `RAILWAY_VOLUME_MOUNT_PATH` automaticamente e usa esse caminho como base de dados locais

## Variaveis do servico `api`

Obrigatorias:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `ENABLE_AUTH=true`
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `PLATFORM_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `PLATFORM_DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `TENANT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `TENANT_DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `REDIS_URL=${{Redis.REDIS_URL}}`
- `API_ENCRYPTION_KEY=<32+ chars>`
- `WEBHOOK_HMAC_SECRET=<16+ chars>`
- `JWT_SECRET=<8+ chars>`
- `GEMINI_API_KEY=<api-key-do-google-ai-studio>`
- `OLLAMA_HOST=<opcional, ex: http://servidor-ollama:11434>`
- `ROOT_DOMAIN=<seu-dominio-raiz>`
- `ADMIN_SUBDOMAIN=admin`
- `PUBLIC_API_BASE_URL=https://api.<seu-dominio-raiz>`
- `SMTP_FROM=noreply@<seu-dominio-raiz>`
- `PLATFORM_OWNER_EMAIL=<seu-email-admin>`
- `PLATFORM_OWNER_PASSWORD=<senha-forte>`
- `PLATFORM_OWNER_NAME=InfraCode Owner`

O deploy do `api` roda automaticamente:

- `prisma db push` do schema `platform`
- seed idempotente do owner da plataforma

## Variaveis do servico `worker`

- `NODE_ENV=production`
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `PLATFORM_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `PLATFORM_DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `TENANT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `TENANT_DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `REDIS_URL=${{Redis.REDIS_URL}}`
- `API_ENCRYPTION_KEY=<mesmo valor do api>`
- `WORKER_CONCURRENCY=10`

## Variaveis do servico `panel`

- `NODE_ENV=production`
- `NEXT_PUBLIC_API_BASE_URL=https://api.<seu-dominio-raiz>`
- `API_INTERNAL_BASE_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`
- `NEXT_PUBLIC_DEFAULT_TENANT=demo`

Observacao:

- o `API_INTERNAL_BASE_URL` usa private networking do Railway para o SSR do Next.js
- o `NEXT_PUBLIC_API_BASE_URL` e o endpoint usado no browser

## Dominios

Para manter o modelo SaaS multi-tenant deste projeto:

- aponte `admin.<seu-dominio-raiz>` para o servico `panel`
- aponte `*.<seu-dominio-raiz>` para o servico `panel`
- aponte `api.<seu-dominio-raiz>` para o servico `api`
- configure `ROOT_DOMAIN=<seu-dominio-raiz>` e `ADMIN_SUBDOMAIN=admin`

Com isso:

- `admin.<dominio>` abre o painel InfraCode
- `<tenant>.<dominio>` abre o painel do cliente
- `api.<dominio>` recebe REST, WebSocket e docs

## Ordem sugerida de subida

1. Crie PostgreSQL e Redis no projeto Railway.
2. Crie o servico `api`, aponte o config file path para `/apps/api/railway.json` e anexe um volume em `/data`.
3. Defina as variaveis do `api` e publique.
4. Crie o servico `worker`, use `/apps/worker/railway.json`, herde as mesmas conexoes de banco e Redis.
5. Crie o servico `panel`, use `/apps/panel/railway.json`.
6. Configure os dominios publicos.

## Smoke test apos deploy

- `https://api.<dominio>/health`
- `https://api.<dominio>/docs`
- `https://admin.<dominio>/login`
- `https://admin.<dominio>/api/health`
- login com `PLATFORM_OWNER_EMAIL` e `PLATFORM_OWNER_PASSWORD`

## Notas operacionais

- o `api` agora sobe com `trustProxy` habilitado automaticamente quando existe `RAILWAY_PUBLIC_DOMAIN`
- o `panel` agora respeita `PORT` dinamico do Railway
- se quiser volume em outro mount path, ajuste `requiredMountPath` no manifest do `api` e a configuracao do servic
