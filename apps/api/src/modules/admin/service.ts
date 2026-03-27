import { randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import type { EmailService } from "../../lib/mail.js";
import { encrypt, sha256 } from "../../lib/crypto.js";
import { resolveTenantSchemaName } from "../../lib/tenant-schema.js";
import type { AuthService } from "../auth/service.js";
import type { InstanceOrchestrator } from "../instances/service.js";
import type { PlatformAlertService } from "../platform/alert.service.js";

interface PlatformAdminServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
  emailService: EmailService;
  authService: AuthService;
  instanceOrchestrator: InstanceOrchestrator;
}

const defaultTenantAiProvider = {
  provider: "GROQ",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.1-8b-instant",
  isActive: false
} as const;
const chatbotGlobalSystemPromptSettingKey = "chatbot.globalSystemPrompt";

const normalizeManagedProvider = (provider?: string | null): "GROQ" | "OPENAI_COMPATIBLE" | null => {
  if (provider === "GROQ" || provider === "OPENAI_COMPATIBLE") {
    return provider;
  }

  return null;
};

interface PlatformTenantAiProviderRecord {
  provider: string;
  baseUrl: string;
  model: string;
  isActive: boolean;
  apiKeyEncrypted: string;
  createdAt: Date;
  updatedAt: Date;
}

interface PlatformTenantRecord {
  id: string;
  name: string;
  slug: string;
  schemaName: string;
  status: string;
  billingEmail: string | null;
  onboardingStep: string;
  onboardingCompletedAt: Date | null;
  storageBytes: bigint;
  messagesThisMonth: number;
  instanceLimit: number;
  messagesPerMonth: number;
  usersLimit: number;
  rateLimitPerMinute: number;
  createdAt: Date;
  updatedAt: Date;
  plan:
    | {
        id: string;
        code: string;
        name: string;
      }
    | null;
  aiProvider?: PlatformTenantAiProviderRecord | null;
}

/**
 * Centraliza operacoes globais exclusivas do super admin da InfraCode.
 */
export class PlatformAdminService {
  private readonly config: AppConfig;
  private readonly platformPrisma: PlatformPrisma;
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;
  private readonly emailService: EmailService;
  private readonly authService: AuthService;
  private readonly instanceOrchestrator: InstanceOrchestrator;

  public constructor(deps: PlatformAdminServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.emailService = deps.emailService;
    this.authService = deps.authService;
    this.instanceOrchestrator = deps.instanceOrchestrator;
  }

  private mapTenantSummary(
    tenant: PlatformTenantRecord,
    activeInstances: number
  ) {
    const aiProvider = normalizeManagedProvider(tenant.aiProvider?.provider);

    return {
      activeInstances,
      aiConfigured: Boolean(aiProvider && tenant.aiProvider?.apiKeyEncrypted && tenant.aiProvider?.model),
      aiModel: tenant.aiProvider?.model ?? null,
      aiProvider,
      billingEmail: tenant.billingEmail,
      createdAt: tenant.createdAt.toISOString(),
      id: tenant.id,
      instanceLimit: tenant.instanceLimit,
      messagesPerMonth: tenant.messagesPerMonth,
      messagesThisMonth: tenant.messagesThisMonth,
      name: tenant.name,
      onboardingCompletedAt: tenant.onboardingCompletedAt?.toISOString() ?? null,
      onboardingStep: tenant.onboardingStep,
      plan: tenant.plan
        ? {
            id: tenant.plan.id,
            code: tenant.plan.code,
            name: tenant.plan.name
          }
        : null,
      rateLimitPerMinute: tenant.rateLimitPerMinute,
      schemaName: tenant.schemaName,
      slug: tenant.slug,
      status: tenant.status,
      storageBytes: Number(tenant.storageBytes),
      updatedAt: tenant.updatedAt.toISOString(),
      usersLimit: tenant.usersLimit
    };
  }

  private mapTenantAiProvider(
    tenantId: string,
    aiProvider?: PlatformTenantAiProviderRecord | null
  ) {
    const provider = normalizeManagedProvider(aiProvider?.provider) ?? defaultTenantAiProvider.provider;

    return {
      tenantId,
      provider,
      baseUrl: aiProvider?.baseUrl ?? defaultTenantAiProvider.baseUrl,
      model: aiProvider?.model ?? defaultTenantAiProvider.model,
      isActive: aiProvider?.isActive ?? defaultTenantAiProvider.isActive,
      isConfigured: Boolean(aiProvider?.apiKeyEncrypted && aiProvider?.model),
      hasApiKey: Boolean(aiProvider?.apiKeyEncrypted),
      createdAt: aiProvider?.createdAt.toISOString() ?? null,
      updatedAt: aiProvider?.updatedAt.toISOString() ?? null
    };
  }

  /**
   * Lista tenants com agregacao operacional minima para o painel super admin.
   */
  public async listTenants() {
    const tenants = (await this.platformPrisma.tenant.findMany({
      include: {
        aiProvider: true,
        plan: true
      },
      orderBy: {
        createdAt: "desc"
      }
    } as never)) as unknown as PlatformTenantRecord[];

    return Promise.all(
      tenants.map(async (tenant) => {
        const prisma = await this.tenantPrismaRegistry.getClient(tenant.id);
        const activeInstances = await prisma.instance.count({
          where: {
            status: {
              in: ["CONNECTED", "INITIALIZING", "QR_PENDING"]
            }
          }
        });

        return this.mapTenantSummary(tenant, activeInstances);
      })
    );
  }

  /**
   * Cria um novo plano comercial editavel pela InfraCode.
   */
  public async createPlan(input: {
    code: string;
    currency: string;
    description?: string;
    instanceLimit: number;
    messagesPerMonth: number;
    name: string;
    priceCents: number;
    rateLimitPerMinute: number;
    usersLimit: number;
  }) {
    return this.platformPrisma.billingPlan.create({
      data: input
    });
  }

  /**
   * Lista os planos disponiveis para comercializacao.
   */
  public async listPlans() {
    const plans = await this.platformPrisma.billingPlan.findMany({
      orderBy: {
        priceCents: "asc"
      }
    });

    return plans.map((plan) => ({
      ...plan,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString()
    }));
  }

  /**
   * Atualiza um plano existente sem quebrar tenants ja provisionados.
   */
  public async updatePlan(
    planId: string,
    input: Partial<{
      code: string;
      currency: string;
      description?: string;
      instanceLimit: number;
      isActive: boolean;
      messagesPerMonth: number;
      name: string;
      priceCents: number;
      rateLimitPerMinute: number;
      usersLimit: number;
    }>
  ) {
    const updated = await this.platformPrisma.billingPlan.update({
      where: {
        id: planId
      },
      data: input
    });

    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    };
  }

  /**
   * Provisiona schema, limites, billing inicial e convite do admin do tenant.
   */
  public async createTenant(input: {
    billingEmail?: string;
    firstAdminEmail: string;
    firstAdminRole: string;
    name: string;
    nextDueAt?: string;
    planId: string;
    slug: string;
  }) {
    const plan = await this.platformPrisma.billingPlan.findUnique({
      where: {
        id: input.planId
      }
    });

    if (!plan || !plan.isActive) {
      throw new ApiError(404, "PLAN_NOT_FOUND", "Plano nao encontrado ou inativo");
    }

    const tenantId = randomUUID();
    const schemaName = resolveTenantSchemaName(tenantId);
    const invitationToken = randomBytes(32).toString("base64url");
    const invitationExpiresAt = new Date(Date.now() + this.config.INVITATION_TTL_HOURS * 60 * 60 * 1000);

    const tenant = (await this.platformPrisma.tenant.create({
      data: {
        billingEmail: input.billingEmail,
        instanceLimit: plan.instanceLimit,
        messagesPerMonth: plan.messagesPerMonth,
        name: input.name,
        planId: plan.id,
        rateLimitPerMinute: plan.rateLimitPerMinute,
        schemaName,
        slug: input.slug,
        usersLimit: plan.usersLimit,
        id: tenantId,
        subscriptions: {
          create: {
            nextDueAt: input.nextDueAt ? new Date(input.nextDueAt) : null,
            planId: plan.id,
            status: "ACTIVE"
          }
        },
        invitations: {
          create: {
            email: input.firstAdminEmail.toLowerCase(),
            expiresAt: invitationExpiresAt,
            role: input.firstAdminRole,
            tokenHash: sha256(invitationToken)
          }
        }
      },
      include: {
        aiProvider: true,
        plan: true
      }
    } as never)) as unknown as PlatformTenantRecord;

    await this.tenantPrismaRegistry.ensureSchema(this.platformPrisma, tenant.id);
    await this.emailService.sendTemplate({
      subject: `InfraCode | Primeiro acesso do tenant ${tenant.name}`,
      template: "tenant-first-access",
      to: input.firstAdminEmail.toLowerCase(),
      variables: {
        acceptUrl: `https://${tenant.slug}.${this.config.ROOT_DOMAIN}/primeiro-acesso?token=${invitationToken}`,
        tenantName: tenant.name
      }
    });

    return {
      firstAccessToken: invitationToken,
      firstAccessUrl: `https://${tenant.slug}.${this.config.ROOT_DOMAIN}/primeiro-acesso?token=${invitationToken}`,
      tenant: this.mapTenantSummary(tenant, 0)
    };
  }

  /**
   * Atualiza tenant, com opcional sincronizacao de limites a partir de plano.
   */
  public async updateTenant(
    tenantId: string,
    input: Partial<{
      billingEmail: string | null;
      instanceLimit: number;
      messagesPerMonth: number;
      name: string;
      planId: string;
      rateLimitPerMinute: number;
      status: "ACTIVE" | "SUSPENDED" | "CANCELED";
      usersLimit: number;
    }>
  ) {
    const tenant = (await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      },
      include: {
        aiProvider: true,
        plan: true
      }
    } as never)) as unknown as PlatformTenantRecord | null;

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    let limitPatch = {};

    if (input.planId) {
      const plan = await this.platformPrisma.billingPlan.findUnique({
        where: {
          id: input.planId
        }
      });

      if (!plan) {
        throw new ApiError(404, "PLAN_NOT_FOUND", "Plano nao encontrado");
      }

      limitPatch = {
        instanceLimit: plan.instanceLimit,
        messagesPerMonth: plan.messagesPerMonth,
        planId: plan.id,
        rateLimitPerMinute: plan.rateLimitPerMinute,
        usersLimit: plan.usersLimit
      };

      await this.platformPrisma.billingSubscription.updateMany({
        where: {
          tenantId
        },
        data: {
          planId: plan.id
        }
      });
    }

    const statusPatch =
      input.status === "SUSPENDED"
        ? {
            status: "SUSPENDED",
            suspendedAt: new Date()
          }
        : input.status === "ACTIVE"
          ? {
              status: "ACTIVE",
              suspendedAt: null
            }
          : input.status === "CANCELED"
            ? {
                status: "CANCELED",
                suspendedAt: new Date()
              }
            : {};

    const updated = (await this.platformPrisma.tenant.update({
      where: {
        id: tenantId
      },
      data: {
        billingEmail: input.billingEmail,
        instanceLimit: input.instanceLimit,
        messagesPerMonth: input.messagesPerMonth,
        name: input.name,
        rateLimitPerMinute: input.rateLimitPerMinute,
        usersLimit: input.usersLimit,
        ...statusPatch,
        ...limitPatch
      },
      include: {
        aiProvider: true,
        plan: true
      }
    } as never)) as unknown as PlatformTenantRecord;

    const prisma = await this.tenantPrismaRegistry.getClient(updated.id);
    const activeInstances = await prisma.instance.count({
      where: {
        status: {
          in: ["CONNECTED", "INITIALIZING", "QR_PENDING"]
        }
      }
    });

    return this.mapTenantSummary(updated, activeInstances);
  }

  /**
   * Retorna a configuracao gerenciada pela InfraCode para IA do tenant.
   */
  public async getTenantAiConfig(tenantId: string) {
    const tenant = (await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      },
      include: {
        aiProvider: true
      }
    } as never)) as unknown as (PlatformTenantRecord & { aiProvider?: PlatformTenantAiProviderRecord | null }) | null;

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    return this.mapTenantAiProvider(tenant.id, tenant.aiProvider);
  }

  /**
   * Persiste o provedor e a chave de IA usados pelo chatbot do tenant.
   */
  public async upsertTenantAiConfig(
    tenantId: string,
    input: {
      provider: "GROQ" | "OPENAI_COMPATIBLE";
      baseUrl: string;
      model: string;
      apiKey?: string;
      isActive: boolean;
    }
  ) {
    const tenant = (await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      },
      include: {
        aiProvider: true
      }
    } as never)) as unknown as (PlatformTenantRecord & { aiProvider?: PlatformTenantAiProviderRecord | null }) | null;

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    const currentApiKeyEncrypted = tenant.aiProvider?.apiKeyEncrypted ?? null;
    const nextApiKeyEncrypted =
      input.apiKey && input.apiKey.trim()
        ? encrypt(input.apiKey.trim(), this.config.API_ENCRYPTION_KEY)
        : currentApiKeyEncrypted;

    if (!nextApiKeyEncrypted) {
      throw new ApiError(400, "AI_API_KEY_REQUIRED", "Informe a API key da IA para o tenant");
    }

    const aiProvider = await this.platformPrisma.tenantAiProvider.upsert({
      where: {
        tenantId
      },
      create: {
        tenantId,
        provider: input.provider,
        baseUrl: input.baseUrl.trim(),
        model: input.model.trim(),
        apiKeyEncrypted: nextApiKeyEncrypted,
        isActive: input.isActive
      },
      update: {
        provider: input.provider,
        baseUrl: input.baseUrl.trim(),
        model: input.model.trim(),
        apiKeyEncrypted: nextApiKeyEncrypted,
        isActive: input.isActive
      }
    });

    return this.mapTenantAiProvider(tenantId, aiProvider);
  }

  /**
   * Remove tenant da plataforma e derruba o schema dedicado.
   */
  public async deleteTenant(tenantId: string): Promise<void> {
    const tenant = await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      }
    });

    if (!tenant) {
      return;
    }

    const instances = await this.instanceOrchestrator.listInstances(tenantId);

    for (const instance of instances) {
      await this.instanceOrchestrator.deleteInstance(tenantId, instance.id);
    }

    await this.tenantPrismaRegistry.disposeClient(tenantId);
    this.tenantPrismaRegistry.invalidateSchemaCache(tenantId);
    await this.platformPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${tenant.schemaName.replaceAll("\"", "\"\"")}" CASCADE;`);
    await this.platformPrisma.tenant.delete({
      where: {
        id: tenantId
      }
    });
  }

  /**
   * Lista assinaturas e vencimentos para o modulo financeiro.
   */
  public async listBilling() {
    const subscriptions = await this.platformPrisma.billingSubscription.findMany({
      include: {
        plan: true,
        tenant: true
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    return subscriptions.map((subscription) => ({
      canceledAt: subscription.canceledAt?.toISOString() ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      currentPeriodStart: subscription.currentPeriodStart.toISOString(),
      id: subscription.id,
      nextDueAt: subscription.nextDueAt?.toISOString() ?? null,
      planName: subscription.plan.name,
      status: subscription.status,
      suspendedAt: subscription.suspendedAt?.toISOString() ?? null,
      tenantId: subscription.tenantId,
      tenantName: subscription.tenant.name
    }));
  }

  /**
   * Retorna visao sintetica de saude da plataforma hospedada.
   */
  public async getHealth(redisStatus: string) {
    const tenants = await this.platformPrisma.tenant.findMany({
      select: {
        id: true,
        status: true
      }
    });

    let databaseStatus: "ready" | "degraded" = "ready";
    let instancesActive = 0;

    try {
      await this.platformPrisma.$queryRawUnsafe("SELECT 1");
    } catch {
      databaseStatus = "degraded";
    }

    for (const tenant of tenants) {
      const prisma = await this.tenantPrismaRegistry.getClient(tenant.id);
      instancesActive += await prisma.instance.count({
        where: {
          status: {
            in: ["CONNECTED", "INITIALIZING", "QR_PENDING"]
          }
        }
      });
    }

    return {
      databaseStatus,
      instancesActive,
      redisStatus,
      tenantsActive: tenants.filter((tenant) => tenant.status === "ACTIVE").length,
      tenantsSuspended: tenants.filter((tenant) => tenant.status === "SUSPENDED").length,
      tenantsTotal: tenants.length
    };
  }

  /**
   * Lista settings globais persistidos no schema platform.
   */
  public async listSettings() {
    const settings = await this.platformPrisma.platformSetting.findMany({
      orderBy: {
        key: "asc"
      }
    });

    return settings.map((setting) => ({
      key: setting.key,
      value: setting.value
    }));
  }

  /**
   * Atualiza settings globais sem depender de arquivo local.
   */
  public async updateSettings(input: Array<{ key: string; value: unknown }>) {
    await this.platformPrisma.$transaction(
      input.map((setting) =>
        this.platformPrisma.platformSetting.upsert({
          where: {
            key: setting.key
          },
          update: {
            value: setting.value as never
          },
          create: {
            key: setting.key,
            value: setting.value as never
          }
        })
      )
    );

    return this.listSettings();
  }

  public async getChatbotGlobalPrompt(): Promise<{
    systemPrompt: string | null;
  }> {
    const setting = await this.platformPrisma.platformSetting.findUnique({
      where: {
        key: chatbotGlobalSystemPromptSettingKey
      }
    });

    return {
      systemPrompt: typeof setting?.value === "string" ? setting.value : null
    };
  }

  public async updateChatbotGlobalPrompt(input: {
    systemPrompt?: string | null;
  }): Promise<{
    systemPrompt: string | null;
  }> {
    const normalizedPrompt = input.systemPrompt?.trim() || null;
    const storedPrompt = normalizedPrompt ?? "";

    await this.platformPrisma.platformSetting.upsert({
      where: {
        key: chatbotGlobalSystemPromptSettingKey
      },
      update: {
        value: storedPrompt as never
      },
      create: {
        key: chatbotGlobalSystemPromptSettingKey,
        value: storedPrompt as never
      }
    });

    return {
      systemPrompt: normalizedPrompt
    };
  }

  /**
   * Emite uma sessao temporaria de impersonacao para suporte da InfraCode.
   */
  public async impersonateTenant(
    platformUserId: string,
    tenantId: string,
    reason: string,
    requestMeta: {
      ipAddress?: string;
      userAgent?: string;
    }
  ) {
    return this.authService.createImpersonationSession(platformUserId, tenantId, reason, requestMeta);
  }

  public async getAlertConfig(): Promise<{
    adminAlertPhone: string | null;
    groqUsageLimit: number;
    alertInstanceDown: boolean;
    alertNewLead: boolean;
    alertHighTokens: boolean;
  }> {
    const config = await this.platformPrisma.platformConfig.findUnique({
      where: { id: "singleton" }
    });

    if (!config) {
      return {
        adminAlertPhone: null,
        groqUsageLimit: 80,
        alertInstanceDown: true,
        alertNewLead: true,
        alertHighTokens: true
      };
    }

    return {
      adminAlertPhone: config.adminAlertPhone,
      groqUsageLimit: config.groqUsageLimit,
      alertInstanceDown: config.alertInstanceDown,
      alertNewLead: config.alertNewLead,
      alertHighTokens: config.alertHighTokens
    };
  }

  public async updateAlertConfig(input: {
    adminAlertPhone?: string | null;
    groqUsageLimit?: number;
    alertInstanceDown?: boolean;
    alertNewLead?: boolean;
    alertHighTokens?: boolean;
  }): Promise<{
    adminAlertPhone: string | null;
    groqUsageLimit: number;
    alertInstanceDown: boolean;
    alertNewLead: boolean;
    alertHighTokens: boolean;
  }> {
    const updated = await this.platformPrisma.platformConfig.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        adminAlertPhone: input.adminAlertPhone ?? null,
        groqUsageLimit: input.groqUsageLimit ?? 80,
        alertInstanceDown: input.alertInstanceDown ?? true,
        alertNewLead: input.alertNewLead ?? true,
        alertHighTokens: input.alertHighTokens ?? true
      },
      update: {
        ...(input.adminAlertPhone !== undefined && { adminAlertPhone: input.adminAlertPhone }),
        ...(input.groqUsageLimit !== undefined && { groqUsageLimit: input.groqUsageLimit }),
        ...(input.alertInstanceDown !== undefined && { alertInstanceDown: input.alertInstanceDown }),
        ...(input.alertNewLead !== undefined && { alertNewLead: input.alertNewLead }),
        ...(input.alertHighTokens !== undefined && { alertHighTokens: input.alertHighTokens })
      }
    });

    return {
      adminAlertPhone: updated.adminAlertPhone,
      groqUsageLimit: updated.groqUsageLimit,
      alertInstanceDown: updated.alertInstanceDown,
      alertNewLead: updated.alertNewLead,
      alertHighTokens: updated.alertHighTokens
    };
  }
}
