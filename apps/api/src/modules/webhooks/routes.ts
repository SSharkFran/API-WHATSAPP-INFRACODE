import type { FastifyInstance } from "fastify";
import { recordPlatformAuditLog, recordTenantAuditLog } from "../../lib/audit.js";
import { requireTenantId } from "../../lib/request-auth.js";
import { instanceParamsSchema } from "../instances/schemas.js";
import { listWebhookDeliveriesQuerySchema, upsertWebhookBodySchema, webhookConfigResponseSchema } from "./schemas.js";

/**
 * Registra rotas REST de configuracao e historico de webhooks.
 */
export const registerWebhookRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get(
    "/instances/:id/webhooks",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Webhooks"],
        summary: "Retorna a configuracao atual do webhook da instancia",
        params: instanceParamsSchema,
        response: {
          200: webhookConfigResponseSchema.nullable()
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      return app.webhookService.getConfig(tenantId, params.id);
    }
  );

  app.post(
    "/instances/:id/webhooks",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["admin"]
      },
      schema: {
        tags: ["Webhooks"],
        summary: "Cria ou atualiza o webhook da instancia",
        params: instanceParamsSchema,
        body: upsertWebhookBodySchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const body = upsertWebhookBodySchema.parse(request.body);
      const response = await app.webhookService.upsertConfig(tenantId, params.id, body);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "webhook.upsert",
        "Instance",
        params.id,
        {
          webhookId: response.id,
          url: response.url
        },
        app.config.JWT_SECRET
      );
      await recordTenantAuditLog(
        tenantPrisma,
        request,
        "webhook.upsert",
        "Instance",
        params.id,
        {
          webhookId: response.id,
          url: response.url
        },
        app.config.JWT_SECRET
      );

      return response;
    }
  );

  app.get(
    "/instances/:id/webhooks/deliveries",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Webhooks"],
        summary: "Lista o historico de entregas do webhook",
        params: instanceParamsSchema,
        querystring: listWebhookDeliveriesQuerySchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const query = listWebhookDeliveriesQuerySchema.parse(request.query);
      return app.webhookService.listDeliveries(tenantId, params.id, query.page, query.pageSize);
    }
  );
};
