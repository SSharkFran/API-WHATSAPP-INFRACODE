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

      if (body.trace) {
        const config = await app.chatbotService.getConfig(tenantId, params.id);
        const modulesTrace = app.chatbotService.simulateModules(
          config.modules ?? {},
          { phone: body.phoneNumber, text: body.text }
        );

        if (modulesTrace.blocked) {
          return {
            action: "NO_MATCH" as const,
            trace: modulesTrace.steps
          };
        }

        const result = await app.chatbotService.simulate(tenantId, params.id, body);
        return {
          ...result,
          trace: [...modulesTrace.steps, ...(result.trace ?? [])]
        };
      }

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
        servicesAndPrices: currentConfig.servicesAndPrices ?? null,
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

  // ── KNOWLEDGE CRUD ────────────────────────────────────────────────────────

  const knowledgeItemSchema = z.object({
    id: z.string(),
    instanceId: z.string(),
    question: z.string(),
    answer: z.string(),
    rawAnswer: z.string().nullable(),
    taughtBy: z.string().nullable(),
    createdAt: z.string()
  });

  const knowledgeParamsSchema = instanceParamsSchema.extend({
    knowledgeId: z.string().min(1)
  });

  app.get(
    "/instances/:id/knowledge",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["read"] },
      schema: {
        tags: ["Chatbot"],
        summary: "Lista todo o conhecimento aprendido pela instancia",
        params: instanceParamsSchema,
        response: { 200: z.array(knowledgeItemSchema) }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      return app.knowledgeService.list(tenantId, params.id);
    }
  );

  app.patch(
    "/instances/:id/knowledge/:knowledgeId",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["write"] },
      schema: {
        tags: ["Chatbot"],
        summary: "Atualiza a resposta de um conhecimento aprendido",
        params: knowledgeParamsSchema,
        body: z.object({ answer: z.string().min(1).max(4000) }),
        response: { 200: knowledgeItemSchema }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = knowledgeParamsSchema.parse(request.params);
      const body = z.object({ answer: z.string().min(1).max(4000) }).parse(request.body);
      const result = await app.knowledgeService.update(tenantId, params.id, params.knowledgeId, body.answer);
      if (!result) {
        throw new Error("Conhecimento nao encontrado nesta instancia");
      }
      void app.chatbotService.triggerKnowledgeSynthesis(tenantId, params.id).catch(() => null);
      return result;
    }
  );

  app.delete(
    "/instances/:id/knowledge/:knowledgeId",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["write"] },
      schema: {
        tags: ["Chatbot"],
        summary: "Remove um conhecimento aprendido",
        params: knowledgeParamsSchema,
        response: { 204: z.null() }
      }
    },
    async (request, reply) => {
      const tenantId = requireTenantId(request);
      const params = knowledgeParamsSchema.parse(request.params);
      const deleted = await app.knowledgeService.delete(tenantId, params.id, params.knowledgeId);
      if (!deleted) {
        throw new Error("Conhecimento nao encontrado nesta instancia");
      }
      void app.chatbotService.triggerKnowledgeSynthesis(tenantId, params.id).catch(() => null);
      return reply.status(204).send();
    }
  );

  // ── ESCALATIONS ──────────────────────────────────────────────────────────

  app.get(
    "/instances/:id/chatbot/escalations/pending",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["read"] },
      schema: {
        tags: ["Chatbot"],
        summary: "Lista escalacoes pendentes aguardando resposta do admin",
        params: instanceParamsSchema,
        response: {
          200: z.array(z.object({
            conversationId: z.string(),
            clientJid: z.string(),
            clientQuestion: z.string(),
            waitingSince: z.string()
          }))
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      return app.escalationService.listPendingEscalations(tenantId, params.id);
    }
  );

  app.post(
    "/instances/:id/chatbot/escalations/:conversationId/reply",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["write"] },
      schema: {
        tags: ["Chatbot"],
        summary: "Responde uma escalacao pendente diretamente pelo painel",
        params: instanceParamsSchema.extend({ conversationId: z.string().min(1) }),
        body: z.object({ answer: z.string().min(1).max(4000) }),
        response: { 200: z.object({ ok: z.boolean(), clientJid: z.string() }) }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.extend({ conversationId: z.string().min(1) }).parse(request.params);
      const body = z.object({ answer: z.string().min(1).max(4000) }).parse(request.body);

      const result = await app.escalationService.processAdminReply(
        tenantId,
        params.id,
        body.answer,
        params.conversationId
      );

      if (!result) {
        throw new Error("Escalacao nao encontrada ou ja respondida");
      }

      const clientResponse = await app.chatbotService.formulateAdminAnswerForClient(
        tenantId,
        params.id,
        result.clientQuestion,
        result.formulatedAnswer
      );

      const { normalizeWhatsAppPhoneNumber, normalizePhoneNumber } = await import("../../lib/phone.js");
      const clientRemoteNumber =
        normalizeWhatsAppPhoneNumber(result.clientJid) ??
        normalizePhoneNumber(String(result.clientJid).split("@")[0] ?? "");

      if (clientRemoteNumber) {
        await app.instanceOrchestrator.sendAutomatedTextMessagePublic(
          tenantId,
          params.id,
          clientRemoteNumber,
          result.clientJid,
          clientResponse
        );
      }

      // Abre janela de 5 min para correcao pos-aprendizado (mesmo comportamento do reply via WhatsApp)
      const chatbotConfig = await app.chatbotService.getConfig(tenantId, params.id).catch(() => null);
      const aprendizadoContinuoModule = chatbotConfig?.modules?.aprendizadoContinuo;
      const adminPhoneForCorrection = (aprendizadoContinuoModule as { verifiedPhone?: string | null } | undefined)?.verifiedPhone?.replace(/\D/g, "");
      if (adminPhoneForCorrection) {
        app.escalationService.trackPendingKnowledgeCorrection(
          params.id,
          adminPhoneForCorrection,
          result.savedKnowledgeId,
          tenantId,
          result.clientQuestion,
          clientResponse
        );
      }

      // Fire-and-forget: regenera sintese de conhecimento
      void app.chatbotService.triggerKnowledgeSynthesis(tenantId, params.id).catch(() => null);

      return { ok: true, clientJid: result.clientJid };
    }
  );

  app.post(
    "/instances/:id/knowledge/synthesize",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["write"] },
      schema: {
        tags: ["Chatbot"],
        summary: "Dispara (re)geracao da sintese de conhecimento via IA",
        params: instanceParamsSchema,
        response: { 200: z.object({ ok: z.boolean() }) }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      await app.chatbotService.triggerKnowledgeSynthesis(tenantId, params.id);
      return { ok: true };
    }
  );

  app.post(
    "/instances/:id/knowledge/:knowledgeId/synthesize",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["write"] },
      schema: {
        tags: ["Chatbot"],
        summary: "Re-sintetiza uma entrada de conhecimento via IA (reformula pergunta e resposta)",
        params: knowledgeParamsSchema,
        response: { 200: knowledgeItemSchema }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = knowledgeParamsSchema.parse(request.params);

      // Busca a entrada atual para ter question e answer originais
      const list = await app.knowledgeService.list(tenantId, params.id);
      const entry = list.find((k) => k.id === params.knowledgeId);
      if (!entry) {
        throw new Error("Conhecimento nao encontrado nesta instancia");
      }

      // Sintetiza via IA — usa rawAnswer (texto bruto original) para preservar fidelidade
      const synthesized = await app.chatbotService.synthesizeKnowledgeEntry(
        tenantId,
        params.id,
        entry.question,
        entry.rawAnswer ?? entry.answer
      );

      const result = await app.knowledgeService.update(
        tenantId,
        params.id,
        params.knowledgeId,
        synthesized.answer,
        synthesized.question
      );

      if (!result) {
        throw new Error("Conhecimento nao encontrado nesta instancia");
      }

      void app.chatbotService.triggerKnowledgeSynthesis(tenantId, params.id).catch(() => null);
      return result;
    }
  );
};
