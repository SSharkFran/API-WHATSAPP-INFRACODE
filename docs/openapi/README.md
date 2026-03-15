# OpenAPI

A especificacao OpenAPI 3.1 e gerada automaticamente pela API Fastify via `@fastify/swagger`.

## Endpoints de documentacao

- `GET /docs` abre a UI Swagger
- `GET /docs/json` retorna o JSON OpenAPI gerado em runtime

## Recomendacao

Use a API em execucao para exportar a especificacao mais recente:

```bash
curl http://localhost:3333/docs/json -o docs/openapi/infracode-openapi.json
```
