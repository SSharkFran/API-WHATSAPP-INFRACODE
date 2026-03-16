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

Os manifests usam Dockerfiles do repositorio e watch patterns especificos para evitar rebuild desnecessario.

## Importacao em lote das variaveis

Para evitar erro de digitacao, use o **RAW Editor** da aba **Variables** no Railway e cole blocos inteiros em formato `.env`.

Arquivos prontos no repositorio:

- [railway.shared.env.example](/C:/Projetos/API%20WHATSAPP%20INFRACODE/docs/deployment/railway.shared.env.example)
- [railway.api.env.example](/C:/Projetos/API%20WHATSAPP%20INFRACODE/docs/deployment/railway.api.env.example)
- [railway.worker.env.example](/C:/Projetos/API%20WHATSAPP%20INFRACODE/docs/deployment/railway.worker.env.example)
- [railway.panel.env.example](/C:/Projetos/API%20WHATSAPP%20INFRACODE/docs/deployment/railway.panel.env.example)

Fluxo recomendado:

1. Em **Project Settings > Shared Variables**, abra o **RAW Editor** e cole o conteudo de `railway.shared.env.example` ja com seus valores reais.
2. No servico `api`, abra **Variables > RAW Editor** e cole `railway.api.env.example`.
3. No servico `worker`, abra **Variables > RAW Editor** e cole `railway.worker.env.example`.
4. No servico `panel`, abra **Variables > RAW Editor** e cole `railway.panel.env.example`.

Com isso, os segredos compartilhados ficam definidos uma vez so no projeto e os servicos reutilizam esse contexto.

## Arquitetura recomendada

- `panel`: dominio publico para a UI
- `api`: dominio publico proprio para REST, WebSocket e Swagger
- `worker`: sem dominio publico
- volume persistente anexado ao `api` em `/data`

Motivo do volume:

- as sessoes Baileys e os arquivos SQLite por instancia ficam em `DATA_DIR`
- em Railway, o filesystem do container e efemero
- o `api` ja detecta `RAILWAY_VOLUME_MOUNT_PATH` automaticamente e usa esse caminho como base de dados locais

## Variaveis compartilhadas do projeto

Defina em **Project Settings > Shared Variables**:

- `ROOT_DOMAIN=wa.seudominio.com`
- `ADMIN_SUBDOMAIN=admin`
- `API_ENCRYPTION_KEY=<32+ chars>`
- `WEBHOOK_HMAC_SECRET=<16+ chars>`
- `JWT_SECRET=<8+ chars>`
- `PLATFORM_OWNER_EMAIL=<seu-email-admin>`
- `PLATFORM_OWNER_PASSWORD=<senha-forte>`
- `PLATFORM_OWNER_NAME=InfraCode Owner`
- `SMTP_FROM=noreply@wa.seudominio.com`
- `TENANT_PRISMA_CACHE_MAX=64`
- `TENANT_PRISMA_IDLE_TTL_MS=600000`
- `TENANT_PRISMA_CONNECTION_LIMIT=2`
- `ACCESS_TOKEN_TTL_MINUTES=15`
- `REFRESH_TOKEN_TTL_DAYS=14`
- `INVITATION_TTL_HOURS=72`
- `PASSWORD_RESET_TTL_HOURS=2`

## Variaveis do servico `api`

Obrigatorias:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `ENABLE_AUTH=true`
- `PUBLIC_API_BASE_URL=https://api.${{ROOT_DOMAIN}}`
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `PLATFORM_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `PLATFORM_DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `TENANT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `TENANT_DIRECT_DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `REDIS_URL=${{Redis.REDIS_URL}}`

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
- `API_ENCRYPTION_KEY=${{API_ENCRYPTION_KEY}}`
- `WORKER_CONCURRENCY=10`

## Variaveis do servico `panel`

- `NODE_ENV=production`
- `NEXT_PUBLIC_API_BASE_URL=https://api.${{ROOT_DOMAIN}}`
- `API_INTERNAL_BASE_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`
- `NEXT_PUBLIC_DEFAULT_TENANT=demo`

Observacao:

- o `API_INTERNAL_BASE_URL` usa private networking do Railway para o SSR do Next.js
- o `NEXT_PUBLIC_API_BASE_URL` e o endpoint usado no browser

## Dominios

Para manter o modelo SaaS multi-tenant deste projeto:

- aponte `*.<seu-dominio-raiz>` para o servico `panel`
- aponte `api.<seu-dominio-raiz>` para o servico `api`
- configure `ROOT_DOMAIN=<seu-dominio-raiz>` e `ADMIN_SUBDOMAIN=admin`

Com isso:

- `admin.<dominio>` abre o painel InfraCode
- `<tenant>.<dominio>` abre o painel do cliente
- `api.<dominio>` recebe REST, WebSocket e docs

Observacao:

- o wildcard `*.<seu-dominio-raiz>` ja cobre `admin.<seu-dominio-raiz>`
- por isso, no plano do Railway com apenas 1 custom domain no `panel`, use somente o wildcard
- adicionar `admin.<dominio>` separadamente e opcional

## DNS na Hostinger

Se o seu site principal ja usa o dominio raiz, prefira um subdominio dedicado para a plataforma, por exemplo:

- `ROOT_DOMAIN=wa.seudominio.com.br`

Com isso, a plataforma usa:

- `admin.wa.seudominio.com.br`
- `api.wa.seudominio.com.br`
- `*.wa.seudominio.com.br`

Passo a passo no hPanel da Hostinger:

1. Acesse **Domains** e abra o dominio principal.
2. Entre em **DNS / Nameservers** ou **DNS Zone Editor**.
3. Adicione os registros que o Railway mostrar quando voce cadastrar os custom domains.

Registros esperados para esse modelo:

- `api.wa` -> `CNAME` para o target informado pelo Railway no dominio `api.wa...`
- `*.wa` -> `CNAME` para o target informado pelo Railway no dominio wildcard `*.wa...`
- `_acme-challenge.wa` -> `CNAME` para o target informado pelo Railway para validacao SSL do wildcard

Observacoes:

- o valor exato de cada `CNAME` vem do Railway; nao invente esse target manualmente
- se o seu dominio nao estiver usando nameservers da Hostinger, faca esses registros no provedor DNS real
- nao altere o `A` ou `CNAME` do dominio raiz do site se ele ja estiver em producao

## Ordem sugerida de subida

1. Crie PostgreSQL e Redis no projeto Railway.
2. Crie o servico `api`, aponte o config file path para `/apps/api/railway.json` e anexe um volume em `/data`.
3. Defina as variaveis do `api` e publique.
4. Crie o servico `worker`, use `/apps/worker/railway.json`, herde as mesmas conexoes de banco e Redis.
5. Crie o servico `panel`, use `/apps/panel/railway.json`.
6. Configure os dominios publicos.

Configuracao minima de dominios:

- `panel`: `*.wa.seudominio.com.br`
- `api`: `api.wa.seudominio.com.br`

## Smoke test apos deploy

- `https://api.<dominio>/health`
- `https://api.<dominio>/docs`
- `https://admin.<dominio>/login`
- `https://admin.<dominio>/api/health`
- login com `PLATFORM_OWNER_EMAIL` e `PLATFORM_OWNER_PASSWORD`

## Notas operacionais

- o `api` agora sobe com `trustProxy` habilitado automaticamente quando existe `RAILWAY_PUBLIC_DOMAIN`
- o `panel` agora respeita `PORT` dinamico do Railway
- se quiser volume em outro mount path, ajuste `requiredMountPath` no manifest do `api` e a configuracao do servico
- o envio de email ainda esta em modo preview/log; convite e reset de senha nao saem por SMTP real nesta versao
- o `worker` nao precisa de dominio publico nem de JWT/TOTP/SMTP; ele precisa apenas de Postgres, Redis, `API_ENCRYPTION_KEY` e `WORKER_CONCURRENCY`
