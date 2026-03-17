import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { registerAdminRoutes } from "../modules/admin/routes.js";
import { registerAuthRoutes } from "../modules/auth/routes.js";
import { registerChatbotRoutes } from "../modules/chatbot/routes.js";
import { registerFiadoRoutes } from "../modules/chatbot/fiado.routes.js";
import { registerInstanceRoutes } from "../modules/instances/routes.js";
import { registerMessageRoutes } from "../modules/messages/routes.js";
import { registerPrivacyRoutes } from "../modules/privacy/routes.js";
import { registerTenantRoutes } from "../modules/tenant/routes.js";
import { registerWebhookRoutes } from "../modules/webhooks/routes.js";

/**
 * Registra o conjunto principal de rotas da API.
 */
export const registerRoutes = async (app: FastifyInstance): Promise<void> => {
  const debugGroupJidsQuerySchema = z.object({
    tenantId: z.string().min(1)
  });

  app.get(
    "/health",
    {
      config: {
        auth: false
      },
      schema: {
        hide: true,
        response: {
          200: z.object({
            status: z.literal("ok"),
            uptimeSeconds: z.number(),
            redis: z.string()
          })
        }
      }
    },
    async () => ({
      status: "ok" as const,
      uptimeSeconds: process.uptime(),
      redis: app.redis.status
    })
  );

  app.get(
    "/metrics",
    {
      config: {
        auth: false
      },
      schema: {
        hide: true
      }
    },
    async (_request, reply) => {
      reply.type(app.metricsService.registry.contentType);
      return app.metricsService.registry.metrics();
    }
  );

  app.get(
    "/debug/group-jids",
    {
      config: {
        auth: false
      },
      schema: {
        querystring: debugGroupJidsQuerySchema,
        response: {
          200: z.array(z.string())
        }
      }
    },
    async (request) => {
      const { tenantId } = debugGroupJidsQuerySchema.parse(request.query);
      await app.tenantPrismaRegistry.ensureSchema(app.platformPrisma, tenantId);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);
      const messages = await tenantPrisma.message.findMany({
        where: {
          direction: "INBOUND",
          remoteJid: {
            endsWith: "@g.us"
          }
        },
        select: {
          remoteJid: true
        },
        orderBy: {
          createdAt: "desc"
        },
        take: 200
      });

      return [...new Set(messages.map((message) => message.remoteJid))];
    }
  );

  await registerAuthRoutes(app);
  await registerAdminRoutes(app);
  await registerChatbotRoutes(app);
  await registerFiadoRoutes(app);
  await registerTenantRoutes(app);
  await registerInstanceRoutes(app);
  await registerMessageRoutes(app);
  await registerPrivacyRoutes(app);
  await registerWebhookRoutes(app);
};
