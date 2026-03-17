import type { InstanceStatus } from "@infracode/types";
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type Redis from "ioredis";
import type { InstanceOrchestrator } from "../modules/instances/service.js";
import type { MessageService } from "../modules/messages/service.js";
import type { PrivacyService } from "../modules/privacy/service.js";
import type { WebhookService } from "../modules/webhooks/service.js";
import type { AppConfig } from "../config.js";
import type { MetricsService } from "../lib/metrics.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../lib/database.js";
import type { AuthContext, ApiScope, AuthMode, PlatformRole, TenantRole } from "../lib/authz.js";
import type { EmailService } from "../lib/mail.js";
import type { AuthService } from "../modules/auth/service.js";
import type { PlatformAdminService } from "../modules/admin/service.js";
import type { ChatbotService } from "../modules/chatbot/service.js";
import type { TenantManagementService } from "../modules/tenant/service.js";
import type { FiadoService } from "../modules/chatbot/fiado.service.js";
import type { PlanEnforcementService } from "../modules/platform/plan-enforcement.service.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }

  interface FastifyContextConfig {
    auth?: false | AuthMode;
    allowApiKey?: boolean;
    allowImpersonation?: boolean;
    requiredScopes?: ApiScope[];
    platformRoles?: PlatformRole[];
    tenantRoles?: TenantRole[];
  }

  interface FastifyInstance {
    config: AppConfig;
    platformPrisma: PlatformPrisma;
    tenantPrismaRegistry: TenantPrismaRegistry;
    redis: Redis;
    emailService: EmailService;
    metricsService: MetricsService;
    instanceOrchestrator: InstanceOrchestrator;
    messageService: MessageService;
    privacyService: PrivacyService;
    webhookService: WebhookService;
    authService: AuthService;
    platformAdminService: PlatformAdminService;
    chatbotService: ChatbotService;
    fiadoService: FiadoService;
    tenantManagementService: TenantManagementService;
    planEnforcementService: PlanEnforcementService;
    queues: {
      sendMessage: Queue;
      webhookDispatch: Queue;
    };
  }
}

declare global {
  interface Error {
    statusCode?: number;
    details?: Record<string, unknown>;
    publicCode?: string;
  }
}

export {};
