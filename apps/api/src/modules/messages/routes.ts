import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordPlatformAuditLog, recordTenantAuditLog } from "../../lib/audit.js";
import { requireTenantId } from "../../lib/request-auth.js";
import { instanceParamsSchema } from "../instances/schemas.js";
import { bulkSendBodySchema, listMessagesQuerySchema, sendMessageBodySchema } from "./schemas.js";

/**
 * Registra rotas REST de mensageria.
 */
export const registerMessageRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post(
    "/instances/:id/messages/send",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Messages"],
        summary: "Envia uma mensagem para a instancia",
        params: instanceParamsSchema,
        body: sendMessageBodySchema,
        response: {
          200: z.object({
            id: z.string(),
            tenantId: z.string(),
            instanceId: z.string(),
            remoteJid: z.string(),
            direction: z.enum(["INBOUND", "OUTBOUND"]),
            type: z.string(),
            status: z.string(),
            payload: z.record(z.unknown()),
            traceId: z.string().nullable().optional(),
            createdAt: z.string(),
            updatedAt: z.string()
          })
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const body = sendMessageBodySchema.parse(request.body);
      const response = await app.messageService.enqueueMessage(tenantId, params.id, body);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "message.enqueue",
        "Instance",
        params.id,
        {
          messageId: response.id,
          type: body.type
        },
        app.config.JWT_SECRET
      );
      await recordTenantAuditLog(
        tenantPrisma,
        request,
        "message.enqueue",
        "Instance",
        params.id,
        {
          messageId: response.id,
          type: body.type
        },
        app.config.JWT_SECRET
      );

      return response;
    }
  );

  app.post(
    "/instances/:id/messages/bulk",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Messages"],
        summary: "Agenda um lote de mensagens com jitter aleatorio",
        params: instanceParamsSchema,
        body: bulkSendBodySchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const body = bulkSendBodySchema.parse(request.body);
      const response = await app.messageService.enqueueBulkMessages(
        tenantId,
        params.id,
        body.items,
        body.minDelayMs,
        body.maxDelayMs
      );
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "message.bulk.enqueue",
        "Instance",
        params.id,
        {
          count: response.length
        },
        app.config.JWT_SECRET
      );
      await recordTenantAuditLog(
        tenantPrisma,
        request,
        "message.bulk.enqueue",
        "Instance",
        params.id,
        {
          count: response.length
        },
        app.config.JWT_SECRET
      );

      return response;
    }
  );

  app.get(
    "/instances/:id/messages",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Messages"],
        summary: "Lista mensagens com paginacao e filtros",
        params: instanceParamsSchema,
        querystring: listMessagesQuerySchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const query = listMessagesQuerySchema.parse(request.query);
      return app.messageService.listMessages(
        tenantId,
        params.id,
        query.page,
        query.pageSize,
        query.status,
        query.type
      );
    }
  );
};
