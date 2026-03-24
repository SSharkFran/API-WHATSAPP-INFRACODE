import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordPlatformAuditLog, recordTenantAuditLog } from "../../lib/audit.js";
import { requireTenantId } from "../../lib/request-auth.js";
import {
  createInstanceBodySchema,
  instanceHealthSchema,
  instanceParamsSchema,
  instanceResetSessionParamsSchema,
  instanceSummarySchema
} from "./schemas.js";
import { raw2NextJobData } from "bullmq";

/**
 * Registra rotas REST e streams em tempo real para instancias.
 */
export const registerInstanceRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get(
    "/instances",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Lista as instancias do tenant",
        response: {
          200: z.array(instanceSummarySchema)
        }
      }
    },
    async (request) => app.instanceOrchestrator.listInstances(requireTenantId(request))
  );

  app.post(
    "/instances",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Cria uma nova instancia WhatsApp",
        body: createInstanceBodySchema,
        response: {
          200: instanceSummarySchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const body = createInstanceBodySchema.parse(request.body);
      const instance = await app.instanceOrchestrator.createInstance(tenantId, body);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "instance.create",
        "Instance",
        instance.id,
        {
          name: instance.name
        },
        app.config.JWT_SECRET
      );
      await recordTenantAuditLog(
        tenantPrisma,
        request,
        "instance.create",
        "Instance",
        instance.id,
        {
          name: instance.name
        },
        app.config.JWT_SECRET
      );

      return instance;
    }
  );

  app.post(
    "/instances/:id/start",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Inicia uma instancia",
        params: instanceParamsSchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const instance = await app.instanceOrchestrator.startInstance(tenantId, params.id);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);
      await recordPlatformAuditLog(app.platformPrisma, request, "instance.start", "Instance", params.id, {}, app.config.JWT_SECRET);
      await recordTenantAuditLog(tenantPrisma, request, "instance.start", "Instance", params.id, {}, app.config.JWT_SECRET);
      return instance;
    }
  );

  app.post(
    "/instances/:id/pause",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Pausa uma instancia",
        params: instanceParamsSchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const instance = await app.instanceOrchestrator.pauseInstance(tenantId, params.id);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);
      await recordPlatformAuditLog(app.platformPrisma, request, "instance.pause", "Instance", params.id, {}, app.config.JWT_SECRET);
      await recordTenantAuditLog(tenantPrisma, request, "instance.pause", "Instance", params.id, {}, app.config.JWT_SECRET);
      return instance;
    }
  );

  app.post(
    "/instances/:id/restart",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Reinicia uma instancia",
        params: instanceParamsSchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const instance = await app.instanceOrchestrator.restartInstance(tenantId, params.id);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);
      await recordPlatformAuditLog(app.platformPrisma, request, "instance.restart", "Instance", params.id, {}, app.config.JWT_SECRET);
      await recordTenantAuditLog(tenantPrisma, request, "instance.restart", "Instance", params.id, {}, app.config.JWT_SECRET);
      return instance;
    }
  );

  app.post(
    "/instances/:instanceId/reset-session",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["write"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Limpa a sessao da instancia e gera um novo QR code",
        params: instanceResetSessionParamsSchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceResetSessionParamsSchema.parse(request.params);
      const instance = await app.instanceOrchestrator.resetSession(tenantId, params.instanceId);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);
      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "instance.reset_session",
        "Instance",
        params.instanceId,
        {},
        app.config.JWT_SECRET
      );
      await recordTenantAuditLog(
        tenantPrisma,
        request,
        "instance.reset_session",
        "Instance",
        params.instanceId,
        {},
        app.config.JWT_SECRET
      );
      return instance;
    }
  );

  app.delete(
    "/instances/:id",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["admin"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Remove a instancia e seus dados",
        params: instanceParamsSchema
      }
    },
    async (request, reply) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      await app.instanceOrchestrator.deleteInstance(tenantId, params.id);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);
      await recordPlatformAuditLog(app.platformPrisma, request, "instance.delete", "Instance", params.id, {}, app.config.JWT_SECRET);
      await recordTenantAuditLog(tenantPrisma, request, "instance.delete", "Instance", params.id, {}, app.config.JWT_SECRET);
      reply.code(204);
      return null;
    }
  );

  app.get(
    "/instances/:id/health",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Retorna o health check detalhado da instancia",
        params: instanceParamsSchema,
        response: {
          200: instanceHealthSchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const queueDepth = await app.messageService.getQueueDepth(tenantId, params.id);
      return app.instanceOrchestrator.getHealthReport(tenantId, params.id, queueDepth);
    }
  );

  app.get(
    "/instances/:id/logs/stream",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Abre stream SSE de logs ao vivo da instancia",
        params: instanceParamsSchema
      }
    },
    async (request, reply) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);

      reply.raw.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream"
      });

      reply.raw.write(": connected\n\n");
      const unsubscribe = app.instanceOrchestrator.subscribeLogs(tenantId, params.id, (event) => {
        reply.raw.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
      });

      request.raw.on("close", () => {
        unsubscribe();
        reply.raw.end();
      });

      return reply.hijack();
    }
  );

  app.get(
    "/instances/:id/qr/ws",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["read"]
      },
      schema: {
        tags: ["Instances"],
        summary: "Abre socket para receber QR Codes em tempo real",
        params: instanceParamsSchema
      },
      websocket: true
    },
    (socket, request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      const latestQr = app.instanceOrchestrator.getLatestQr(tenantId, params.id);

      if (latestQr) {
        socket.send(JSON.stringify(latestQr));
      }

      const unsubscribe = app.instanceOrchestrator.subscribeQr(tenantId, params.id, (event) => {
        socket.send(JSON.stringify(event));
      });

      socket.on("close", () => {
        unsubscribe();
      });
    }
  );
};
