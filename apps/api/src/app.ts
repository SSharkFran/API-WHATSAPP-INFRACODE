import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import type { Queue } from "bullmq";
import Fastify from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { loadConfig } from "./config.js";
import { createPlatformPrisma, TenantPrismaRegistry } from "./lib/database.js";
import { runMigrations } from "./lib/run-migrations.js";
import { createLogger } from "./lib/logger.js";
import { MetricsService } from "./lib/metrics.js";
import { EmailService } from "./lib/mail.js";
import { createRedis } from "./lib/redis.js";
import { normalizeError } from "./lib/errors.js";
import { createSendMessageQueue } from "./queues/message-queue.js";
import { createWebhookQueue } from "./queues/webhook-queue.js";
import { authPlugin } from "./plugins/auth.js";
import { swaggerPlugin } from "./plugins/swagger.js";
import { PlatformAdminService } from "./modules/admin/service.js";
import { AdminMemoryService } from "./modules/chatbot/admin-memory.service.js";
import { AdminCommandService } from "./modules/chatbot/admin-command.service.js";
import { AuthService } from "./modules/auth/service.js";
import { ClientMemoryService } from "./modules/chatbot/memory.service.js";
import { EscalationService } from "./modules/chatbot/escalation.service.js";
import { ChatbotService } from "./modules/chatbot/service.js";
import { FiadoService } from "./modules/chatbot/fiado.service.js";
import { KnowledgeService } from "./modules/chatbot/knowledge.service.js";
import { PersistentMemoryService } from "./modules/chatbot/persistent-memory.service.js";
import { InstanceOrchestrator } from "./modules/instances/service.js";
import { MessageService } from "./modules/messages/service.js";
import { PlanEnforcementService } from "./modules/platform/plan-enforcement.service.js";
import { PlatformAlertService } from "./modules/platform/alert.service.js";
import { PrivacyService } from "./modules/privacy/service.js";
import { TenantManagementService } from "./modules/tenant/service.js";
import { WebhookService } from "./modules/webhooks/service.js";
import { registerRoutes } from "./routes/index.js";

const createNoopQueue = (): Queue =>
  ({
    add: async () => ({}) as never,
    close: async () => undefined
  }) as unknown as Queue;

/**
 * Constrói a instância Fastify completa da plataforma.
 */
export const buildApp = async () => {
  const config = loadConfig();

  // DATA_DIR safety assertion — refuse to start if session files would land inside the repo
  const dataDir = resolve(config.DATA_DIR);
  const projectRoot = resolve(process.cwd());

  if (dataDir.startsWith(projectRoot + sep) || dataDir === projectRoot) {
    // Use console.error here — createLogger requires a full app context
    // which hasn't been constructed yet at this point in startup.
    console.error(
      JSON.stringify({
        level: 'fatal',
        dataDir,
        projectRoot,
        msg:
          'SECURITY: DATA_DIR resolves inside the project root. ' +
          'WhatsApp session files would be accessible via git. ' +
          `Set DATA_DIR to an absolute path outside the repository. ` +
          `Current: ${dataDir} | Project root: ${projectRoot}`
      })
    );
    process.exit(1);
  }

  const logger = createLogger(config);
  const app = Fastify({
    logger: false,
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    trustProxy: config.TRUST_PROXY
  }).withTypeProvider<ZodTypeProvider>();

  const redis = createRedis(config);
  const platformPrisma = createPlatformPrisma(config);
  const metricsService = new MetricsService();
  const tenantPrismaRegistry = new TenantPrismaRegistry(config, metricsService, logger);
  const emailService = new EmailService(config);
  const authService = new AuthService({
    config,
    platformPrisma,
    emailService
  });
  const knowledgeService = new KnowledgeService({
    tenantPrismaRegistry
  });
  const persistentMemoryService = new PersistentMemoryService({
    tenantPrismaRegistry
  });
  const chatbotService = new ChatbotService({
    config,
    platformPrisma,
    tenantPrismaRegistry,
    knowledgeService,
    persistentMemoryService
  });
  const clientMemoryService = new ClientMemoryService({
    tenantPrismaRegistry
  });
  const adminMemoryService = new AdminMemoryService(config.DATA_DIR);
  const adminCommandService = new AdminCommandService({
    tenantPrismaRegistry,
    platformPrisma,
    config
  });
  const fiadoService = new FiadoService({
    tenantPrismaRegistry
  });
  const planEnforcementService = new PlanEnforcementService({
    platformPrisma,
    tenantPrismaRegistry
  });
  const tenantManagementService = new TenantManagementService({
    config,
    platformPrisma,
    tenantPrismaRegistry,
    emailService
  });
  const sendMessageQueue = config.NODE_ENV === "test" ? createNoopQueue() : createSendMessageQueue(redis);
  const webhookDispatchQueue = config.NODE_ENV === "test" ? createNoopQueue() : createWebhookQueue(redis);
  const webhookService = new WebhookService({
    config,
    metricsService,
    platformPrisma,
    tenantPrismaRegistry,
    queue: webhookDispatchQueue
  });
  const privacyService = new PrivacyService({
    tenantPrismaRegistry
  });
  const escalationService = new EscalationService({
    tenantPrismaRegistry,
    knowledgeService,
    redis,
    webhookService
  });
  const instanceOrchestrator = new InstanceOrchestrator({
    config,
    metricsService,
    platformPrisma,
    tenantPrismaRegistry,
    planEnforcementService,
    redis,
    webhookService,
    chatbotService,
    clientMemoryService,
    adminMemoryService,
    adminCommandService,
    fiadoService,
    escalationService,
    sendMessageQueue
  });
  const platformAlertService = new PlatformAlertService(platformPrisma, instanceOrchestrator);
  chatbotService.setPlatformAlertService(platformAlertService);
  escalationService.setPlatformAlertService(platformAlertService);
  escalationService.setChatbotService(chatbotService);
  instanceOrchestrator.setPlatformAlertService(platformAlertService);
  instanceOrchestrator.startSchedulers();
  const platformAdminService = new PlatformAdminService({
    config,
    platformPrisma,
    tenantPrismaRegistry,
    emailService,
    authService,
    instanceOrchestrator
  });
  const messageService = new MessageService({
    config,
    instanceOrchestrator,
    metricsService,
    platformPrisma,
    tenantPrismaRegistry,
    planEnforcementService,
    queue: sendMessageQueue,
    redis,
    webhookService
  });

  app.decorate("config", config);
  app.decorate("platformPrisma", platformPrisma);
  app.decorate("tenantPrismaRegistry", tenantPrismaRegistry);
  app.decorate("redis", redis);
  app.decorate("emailService", emailService);
  app.decorate("metricsService", metricsService);
  app.decorate("authService", authService);
  app.decorate("platformAdminService", platformAdminService);
  app.decorate("chatbotService", chatbotService);
  app.decorate("knowledgeService", knowledgeService);
  app.decorate("clientMemoryService", clientMemoryService);
  app.decorate("fiadoService", fiadoService);
  app.decorate("tenantManagementService", tenantManagementService);
  app.decorate("planEnforcementService", planEnforcementService);
  app.decorate("instanceOrchestrator", instanceOrchestrator);
  app.decorate("platformAlertService", platformAlertService);
  app.decorate("escalationService", escalationService);
  app.decorate("messageService", messageService);
  app.decorate("privacyService", privacyService);
  app.decorate("webhookService", webhookService);
  app.decorate("queues", {
    sendMessage: sendMessageQueue,
    webhookDispatch: webhookDispatchQueue
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: app.config.ALLOWED_ORIGINS.split(',').map(s => s.trim()),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Api-Key"],
    exposedHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]
  });
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        imgSrc: ["'self'", "data:", "blob:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    addHeadersOnExceeding: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true
    }
  });
  await app.register(websocket);
  await app.register(swaggerPlugin);
  await app.register(authPlugin);
  await registerRoutes(app as unknown as import("fastify").FastifyInstance);

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    const logMethod = normalized.statusCode >= 500 ? request.log.error.bind(request.log) : request.log.warn.bind(request.log);

    logMethod(
      {
        err: error,
        code: normalized.publicCode,
        details: normalized.details
      },
      normalized.message
    );

    reply.status(normalized.statusCode).send({
      code: normalized.publicCode,
      details: normalized.details,
      message: normalized.message
    });
  });

  // Run versioned schema migrations for all registered tenants at startup.
  // Per D-MIGRATION-FAIL: failing tenants are logged and skipped — API startup continues.
  if (config.NODE_ENV !== "test") {
    try {
      const tenants = await platformPrisma.tenant.findMany({ select: { id: true } });
      const migrationResults: Array<{ tenantId: string; status: "success" | "skipped" | "failed" }> = [];

      for (const tenant of tenants) {
        const status = await runMigrations(platformPrisma, tenant.id, logger).catch((err) => {
          logger.error({ tenantId: tenant.id, err }, "runMigrations threw unexpectedly");
          return "failed" as const;
        });
        migrationResults.push({ tenantId: tenant.id, status });
      }

      // Log startup summary per D-MIGRATION-FAIL
      logger.info(
        { migrations: migrationResults },
        `Schema migrations complete: ${migrationResults.filter((r) => r.status === "success").length} applied, ` +
        `${migrationResults.filter((r) => r.status === "skipped").length} skipped, ` +
        `${migrationResults.filter((r) => r.status === "failed").length} failed`
      );

      const failedTenants = migrationResults.filter((r) => r.status === "failed");
      if (failedTenants.length > 0) {
        logger.warn(
          { failedTenants: failedTenants.map((r) => r.tenantId) },
          "Some tenants have pending schema migrations — they may lack new columns"
        );
        // Do NOT exit — per D-MIGRATION-FAIL: startup continues
      }
    } catch (err) {
      logger.error({ err }, "Failed to enumerate tenants for migration startup — continuing without migrations");
    }
  }

  app.addHook("onClose", async () => {
    await instanceOrchestrator.close();
    await messageService.close();
    await sendMessageQueue.close();
    await webhookDispatchQueue.close();
    await redis.quit();
    await tenantPrismaRegistry.close();
    await platformPrisma.$disconnect();
  });

  return app;
};
