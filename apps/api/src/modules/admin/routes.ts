import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordPlatformAuditLog } from "../../lib/audit.js";
import {
  billingSubscriptionSchema,
  healthResponseSchema,
  impersonationBodySchema,
  impersonationResponseSchema,
  planBodySchema,
  planParamsSchema,
  platformSettingSchema,
  tenantAiConfigBodySchema,
  tenantAiConfigResponseSchema,
  tenantCreateBodySchema,
  tenantParamsSchema,
  tenantSummarySchema,
  tenantUpdateBodySchema
} from "./schemas.js";

/**
 * Registra rotas exclusivas do painel super admin da InfraCode.
 */
export const registerAdminRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get(
    "/admin/tenants",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT", "PLATFORM_FINANCE", "PLATFORM_VIEWER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Lista todos os tenants hospedados na InfraCode",
        response: {
          200: z.array(tenantSummarySchema)
        }
      }
    },
    async () => app.platformAdminService.listTenants()
  );

  app.post(
    "/admin/tenants",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Provisiona um novo tenant com convite inicial",
        body: tenantCreateBodySchema
      }
    },
    async (request) => {
      const body = tenantCreateBodySchema.parse(request.body);
      const created = await app.platformAdminService.createTenant(body);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "tenant.create",
        "Tenant",
        created.tenant.id,
        {
          billingEmail: body.billingEmail ?? null,
          firstAdminEmail: body.firstAdminEmail,
          planId: body.planId,
          slug: body.slug
        },
        app.config.JWT_SECRET
      );

      return created;
    }
  );

  app.patch(
    "/admin/tenants/:id",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT", "PLATFORM_FINANCE"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Atualiza tenant, plano, status ou limites",
        params: tenantParamsSchema,
        body: tenantUpdateBodySchema,
        response: {
          200: tenantSummarySchema
        }
      }
    },
    async (request) => {
      const params = tenantParamsSchema.parse(request.params);
      const body = tenantUpdateBodySchema.parse(request.body);
      const updated = await app.platformAdminService.updateTenant(params.id, body);

      await recordPlatformAuditLog(app.platformPrisma, request, "tenant.update", "Tenant", params.id, body, app.config.JWT_SECRET);

      return updated;
    }
  );

  app.delete(
    "/admin/tenants/:id",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Exclui definitivamente um tenant e seu schema dedicado",
        params: tenantParamsSchema
      }
    },
    async (request, reply) => {
      const params = tenantParamsSchema.parse(request.params);
      await app.platformAdminService.deleteTenant(params.id);
      await recordPlatformAuditLog(app.platformPrisma, request, "tenant.delete", "Tenant", params.id, {}, app.config.JWT_SECRET);
      reply.code(204);
      return null;
    }
  );

  app.get(
    "/admin/tenants/:id/ai",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Consulta o provedor de IA gerenciado pela InfraCode para o tenant",
        params: tenantParamsSchema,
        response: {
          200: tenantAiConfigResponseSchema
        }
      }
    },
    async (request) => {
      const params = tenantParamsSchema.parse(request.params);
      return app.platformAdminService.getTenantAiConfig(params.id);
    }
  );

  app.put(
    "/admin/tenants/:id/ai",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Define provedor, modelo e chave de IA para um tenant",
        params: tenantParamsSchema,
        body: tenantAiConfigBodySchema,
        response: {
          200: tenantAiConfigResponseSchema
        }
      }
    },
    async (request) => {
      const params = tenantParamsSchema.parse(request.params);
      const body = tenantAiConfigBodySchema.parse(request.body);
      const updated = await app.platformAdminService.upsertTenantAiConfig(params.id, body);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "tenant.ai.upsert",
        "Tenant",
        params.id,
        {
          ...body,
          apiKey: body.apiKey ? "[REDACTED]" : undefined
        },
        app.config.JWT_SECRET
      );

      return updated;
    }
  );

  app.get(
    "/admin/plans",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT", "PLATFORM_FINANCE", "PLATFORM_VIEWER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Lista planos comerciais disponiveis"
      }
    },
    async () => app.platformAdminService.listPlans()
  );

  app.post(
    "/admin/plans",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_FINANCE"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Cria um novo plano comercial",
        body: planBodySchema
      }
    },
    async (request) => {
      const body = planBodySchema.parse(request.body);
      const created = await app.platformAdminService.createPlan(body);
      await recordPlatformAuditLog(app.platformPrisma, request, "plan.create", "BillingPlan", created.id, body, app.config.JWT_SECRET);
      return created;
    }
  );

  app.patch(
    "/admin/plans/:id",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_FINANCE"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Atualiza um plano comercial",
        params: planParamsSchema,
        body: planBodySchema.partial()
      }
    },
    async (request) => {
      const params = planParamsSchema.parse(request.params);
      const body = planBodySchema.partial().parse(request.body);
      const updated = await app.platformAdminService.updatePlan(params.id, body);
      await recordPlatformAuditLog(app.platformPrisma, request, "plan.update", "BillingPlan", params.id, body, app.config.JWT_SECRET);
      return updated;
    }
  );

  app.get(
    "/admin/billing",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_FINANCE", "PLATFORM_VIEWER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Lista assinaturas e vencimentos dos tenants",
        response: {
          200: z.array(billingSubscriptionSchema)
        }
      }
    },
    async () => app.platformAdminService.listBilling()
  );

  app.get(
    "/admin/settings",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT", "PLATFORM_FINANCE", "PLATFORM_VIEWER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Lista configuracoes globais da plataforma"
      }
    },
    async () => app.platformAdminService.listSettings()
  );

  app.put(
    "/admin/settings",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Atualiza configuracoes globais persistidas em banco",
        body: z.array(platformSettingSchema)
      }
    },
    async (request) => {
      const body = z.array(platformSettingSchema).parse(request.body);
      const response = await app.platformAdminService.updateSettings(body.map((setting) => ({ key: setting.key, value: setting.value })));
      await recordPlatformAuditLog(app.platformPrisma, request, "settings.update", "PlatformSetting", "global", { count: body.length }, app.config.JWT_SECRET);
      return response;
    }
  );

  app.get(
    "/admin/health",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT", "PLATFORM_FINANCE", "PLATFORM_VIEWER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Retorna saude agregada da plataforma hospedada",
        response: {
          200: healthResponseSchema
        }
      }
    },
    async () => app.platformAdminService.getHealth(app.redis.status)
  );

  app.post(
    "/admin/impersonation/:id",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Emite sessao temporaria de impersonacao de um tenant",
        params: tenantParamsSchema,
        body: impersonationBodySchema,
        response: {
          200: impersonationResponseSchema
        }
      }
    },
    async (request) => {
      const params = tenantParamsSchema.parse(request.params);
      const body = impersonationBodySchema.parse(request.body);
      const response = await app.platformAdminService.impersonateTenant(request.auth.actorId ?? "", params.id, body.reason, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"]?.toString()
      });

      await recordPlatformAuditLog(app.platformPrisma, request, "tenant.impersonate", "Tenant", params.id, { reason: body.reason }, app.config.JWT_SECRET);

      return response;
    }
  );

  app.get(
    "/admin/alerts-config",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT", "PLATFORM_FINANCE", "PLATFORM_VIEWER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Retorna configuracao de alertas globais da plataforma",
        response: {
          200: z.object({
            adminAlertPhone: z.string().nullable(),
            groqUsageLimit: z.number(),
            alertInstanceDown: z.boolean(),
            alertNewLead: z.boolean(),
            alertHighTokens: z.boolean()
          })
        }
      }
    },
    async () => app.platformAdminService.getAlertConfig()
  );

  app.get(
    "/admin/chatbot-global-prompt",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER", "PLATFORM_SUPPORT", "PLATFORM_VIEWER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Retorna o prompt global que influencia todos os chatbots",
        response: {
          200: z.object({
            systemPrompt: z.string().nullable()
          })
        }
      }
    },
    async () => app.platformAdminService.getChatbotGlobalPrompt()
  );

  app.patch(
    "/admin/chatbot-global-prompt",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Atualiza o prompt global que influencia todos os chatbots",
        body: z.object({
          systemPrompt: z.string().max(16_000).nullable().optional()
        }),
        response: {
          200: z.object({
            systemPrompt: z.string().nullable()
          })
        }
      }
    },
    async (request) => {
      const body = z.object({
        systemPrompt: z.string().max(16_000).nullable().optional()
      }).parse(request.body);

      const updated = await app.platformAdminService.updateChatbotGlobalPrompt(body);
      app.chatbotService.invalidateGlobalSystemPromptCache();

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "chatbot.global-prompt.update",
        "PlatformSetting",
        "chatbot.globalSystemPrompt",
        {
          hasPrompt: Boolean(body.systemPrompt?.trim()),
          promptLength: body.systemPrompt?.trim().length ?? 0
        },
        app.config.JWT_SECRET
      );

      return updated;
    }
  );

  app.patch(
    "/admin/alerts-config",
    {
      config: {
        auth: "platform",
        platformRoles: ["PLATFORM_OWNER"]
      },
      schema: {
        tags: ["Admin"],
        summary: "Atualiza configuracao de alertas globais da plataforma",
        body: z.object({
          adminAlertPhone: z.string().nullable().optional(),
          groqUsageLimit: z.number().min(1).max(100).optional(),
          alertInstanceDown: z.boolean().optional(),
          alertNewLead: z.boolean().optional(),
          alertHighTokens: z.boolean().optional()
        }),
        response: {
          200: z.object({
            adminAlertPhone: z.string().nullable(),
            groqUsageLimit: z.number(),
            alertInstanceDown: z.boolean(),
            alertNewLead: z.boolean(),
            alertHighTokens: z.boolean()
          })
        }
      }
    },
    async (request) => {
      const body = z.object({
        adminAlertPhone: z.string().nullable().optional(),
        groqUsageLimit: z.number().min(1).max(100).optional(),
        alertInstanceDown: z.boolean().optional(),
        alertNewLead: z.boolean().optional(),
        alertHighTokens: z.boolean().optional()
      }).parse(request.body);

      const updated = await app.platformAdminService.updateAlertConfig(body);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "alerts_config.update",
        "PlatformConfig",
        "singleton",
        { adminAlertPhone: body.adminAlertPhone ? "[REDACTED]" : undefined },
        app.config.JWT_SECRET
      );

      return updated;
    }
  );
};
