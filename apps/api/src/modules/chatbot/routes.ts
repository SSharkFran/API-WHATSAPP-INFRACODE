import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordPlatformAuditLog, recordTenantAuditLog } from "../../lib/audit.js";
import { requireTenantId } from "../../lib/request-auth.js";
import { instanceParamsSchema } from "../instances/schemas.js";
import {
  clientMemoryListQuerySchema,
  clientMemoryParamsSchema,
  clientMemorySchema,
  chatbotConfigSchema,
  chatbotSimulationBodySchema,
  chatbotSimulationResponseSchema,
  upsertClientMemoryBodySchema,
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
      const currentConfig = await app.chatbotService.getConfig(tenantId, params.id);
      const config = await app.chatbotService.upsertConfig(tenantId, params.id, {
        isEnabled: currentConfig.isEnabled,
        welcomeMessage: currentConfig.welcomeMessage ?? null,
        fallbackMessage: currentConfig.fallbackMessage ?? null,
        humanTakeoverStartMessage: currentConfig.humanTakeoverStartMessage ?? null,
        humanTakeoverEndMessage: currentConfig.humanTakeoverEndMessage ?? null,
        rules: currentConfig.rules,
        ai: {
          isEnabled: currentConfig.ai.isEnabled,
          mode: currentConfig.ai.mode,
          systemPrompt: currentConfig.ai.systemPrompt,
          temperature: currentConfig.ai.temperature,
          maxContextMessages: currentConfig.ai.maxContextMessages
        },
        leadsPhoneNumber: body.leadsPhoneNumber ?? null,
        leadsEnabled: body.leadsEnabled,
        fiadoEnabled: currentConfig.fiadoEnabled ?? false,
        audioEnabled: currentConfig.audioEnabled ?? false,
        visionEnabled: currentConfig.visionEnabled ?? false,
        visionPrompt: currentConfig.visionPrompt ?? null,
        responseDelayMs: currentConfig.responseDelayMs ?? 3_000,
        leadAutoExtract: currentConfig.leadAutoExtract ?? false,
        leadVehicleTable: currentConfig.leadVehicleTable ?? {},
        leadPriceTable: currentConfig.leadPriceTable ?? {},
        leadSurchargeTable: currentConfig.leadSurchargeTable ?? {},
        aiFallbackProvider: currentConfig.aiFallbackProvider ?? null,
        aiFallbackApiKey: currentConfig.aiFallbackApiKey ?? null,
        aiFallbackModel: currentConfig.aiFallbackModel ?? null,
        modules: currentConfig.modules ?? {}
      });

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

  app.get(
    "/instances/:id/chatbot/clients",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Chatbot"],
        summary: "Lista memorias de clientes do chatbot",
        params: instanceParamsSchema,
        querystring: clientMemoryListQuerySchema,
        response: {
          200: z.array(clientMemorySchema)
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const query = clientMemoryListQuerySchema.parse(request.query);

      await app.chatbotService.getConfig(tenantId, params.id);
      return app.clientMemoryService.list(tenantId, query);
    }
  );

  app.get(
    "/instances/:id/chatbot/clients/:phone",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Chatbot"],
        summary: "Consulta a memoria de um cliente especifico",
        params: clientMemoryParamsSchema,
        response: {
          200: clientMemorySchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = clientMemoryParamsSchema.parse(request.params);

      await app.chatbotService.getConfig(tenantId, params.id);
      return app.clientMemoryService.requireByPhone(tenantId, params.phone);
    }
  );

  app.patch(
    "/instances/:id/chatbot/clients/:phone",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Chatbot"],
        summary: "Atualiza manualmente a memoria de um cliente",
        params: clientMemoryParamsSchema,
        body: upsertClientMemoryBodySchema,
        response: {
          200: clientMemorySchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = clientMemoryParamsSchema.parse(request.params);
      const body = upsertClientMemoryBodySchema.parse(request.body);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      await app.chatbotService.getConfig(tenantId, params.id);
      const memory = await app.clientMemoryService.upsert(tenantId, params.phone, {
        status: body.status,
        tags: body.tags,
        notes: body.notes
      });

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "chatbot.client-memory.update",
        "Instance",
        params.id,
        body,
        app.config.JWT_SECRET
      );
      await recordTenantAuditLog(
        tenantPrisma,
        request,
        "chatbot.client-memory.update",
        "Instance",
        params.id,
        body,
        app.config.JWT_SECRET
      );

      return memory;
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
