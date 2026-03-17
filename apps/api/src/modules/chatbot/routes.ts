import type { FastifyInstance } from "fastify";
import { recordPlatformAuditLog, recordTenantAuditLog } from "../../lib/audit.js";
import { requireTenantId } from "../../lib/request-auth.js";
import { instanceParamsSchema } from "../instances/schemas.js";
import {
  chatbotConfigSchema,
  chatbotSimulationBodySchema,
  chatbotSimulationResponseSchema,
  upsertChatbotBodySchema,
  upsertLeadsPhoneBodySchema
} from "./schemas.js";

/**
 * Registra as rotas do chatbot nativo por instancia.
 */
export const registerChatbotRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get(
    "/instances/:id/chatbot",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Chatbot"],
        summary: "Retorna a configuracao do chatbot da instancia",
        params: instanceParamsSchema,
        response: {
          200: chatbotConfigSchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      return app.chatbotService.getConfig(tenantId, params.id);
    }
  );

  app.put(
    "/instances/:id/chatbot",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Chatbot"],
        summary: "Cria ou atualiza a configuracao do chatbot da instancia",
        params: instanceParamsSchema,
        body: upsertChatbotBodySchema,
        response: {
          200: chatbotConfigSchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const body = upsertChatbotBodySchema.parse(request.body);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);
      const config = await app.chatbotService.upsertConfig(tenantId, params.id, body);

      await recordPlatformAuditLog(app.platformPrisma, request, "chatbot.upsert", "Instance", params.id, body, app.config.JWT_SECRET);
      await recordTenantAuditLog(tenantPrisma, request, "chatbot.upsert", "Instance", params.id, body, app.config.JWT_SECRET);

      return config;
    }
  );

  app.post(
    "/instances/:id/chatbot/simulate",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Chatbot"],
        summary: "Simula a resposta do chatbot para um input textual",
        params: instanceParamsSchema,
        body: chatbotSimulationBodySchema,
        response: {
          200: chatbotSimulationResponseSchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const body = chatbotSimulationBodySchema.parse(request.body);
      return app.chatbotService.simulate(tenantId, params.id, body);
    }
  );

  app.patch(
    "/instances/:id/chatbot/leads-phone",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Chatbot"],
        summary: "Configura o numero que recebe resumos de leads",
        params: instanceParamsSchema,
        body: upsertLeadsPhoneBodySchema,
        response: {
          200: chatbotConfigSchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const body = upsertLeadsPhoneBodySchema.parse(request.body);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      await tenantPrisma.chatbotConfig.updateMany({
        where: { instanceId: params.id },
        data: {
          leadsPhoneNumber: body.leadsPhoneNumber ?? null,
          leadsEnabled: body.leadsEnabled
        }
      });

      const config = await app.chatbotService.getConfig(tenantId, params.id);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "chatbot.leads-phone.update",
        "Instance",
        params.id,
        body,
        app.config.JWT_SECRET
      );
      await recordTenantAuditLog(
        tenantPrisma,
        request,
        "chatbot.leads-phone.update",
        "Instance",
        params.id,
        body,
        app.config.JWT_SECRET
      );

      return config;
    }
  );

  app.delete(
    "/instances/:id/chatbot/leads-group",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Chatbot"],
        summary: "Desconecta o grupo configurado para resumos de leads",
        params: instanceParamsSchema,
        response: {
          200: chatbotConfigSchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      await tenantPrisma.chatbotConfig.updateMany({
        where: {
          instanceId: params.id
        },
        data: {
          leadsGroupJid: null,
          leadsGroupName: null
        }
      });

      const payload = {
        leadsGroupJid: null,
        leadsGroupName: null
      };
      const config = await app.chatbotService.getConfig(tenantId, params.id);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "chatbot.leads-group.disconnect",
        "Instance",
        params.id,
        payload,
        app.config.JWT_SECRET
      );
      await recordTenantAuditLog(tenantPrisma, request, "chatbot.leads-group.disconnect", "Instance", params.id, payload, app.config.JWT_SECRET);

      return config;
    }
  );
};
