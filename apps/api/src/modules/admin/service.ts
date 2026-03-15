import { randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import type { EmailService } from "../../lib/mail.js";
import { sha256 } from "../../lib/crypto.js";
import { resolveTenantSchemaName } from "../../lib/tenant-schema.js";
import type { AuthService } from "../auth/service.js";

interface PlatformAdminServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
  emailService: EmailService;
  authService: AuthService;
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

  public constructor(deps: PlatformAdminServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.emailService = deps.emailService;
    this.authService = deps.authService;
  }

  /**
   * Lista tenants com agregacao operacional minima para o painel super admin.
   */
  public async listTenants() {
    const tenants = await this.platformPrisma.tenant.findMany({
      include: {
        plan: true
      },
      orderBy: {
        createdAt: "desc"
      }
    });

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

        return {
          activeInstances,
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

    const tenant = await this.platformPrisma.tenant.create({
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
        plan: true
      }
    });

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
      tenant: {
        activeInstances: 0,
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
      }
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
    const tenant = await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      }
    });

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

    const updated = await this.platformPrisma.tenant.update({
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
        plan: true
      }
    });

    return {
      activeInstances: 0,
      billingEmail: updated.billingEmail,
      createdAt: updated.createdAt.toISOString(),
      id: updated.id,
      instanceLimit: updated.instanceLimit,
      messagesPerMonth: updated.messagesPerMonth,
      messagesThisMonth: updated.messagesThisMonth,
      name: updated.name,
      onboardingCompletedAt: updated.onboardingCompletedAt?.toISOString() ?? null,
      onboardingStep: updated.onboardingStep,
      plan: updated.plan
        ? {
            id: updated.plan.id,
            code: updated.plan.code,
            name: updated.plan.name
          }
        : null,
      rateLimitPerMinute: updated.rateLimitPerMinute,
      schemaName: updated.schemaName,
      slug: updated.slug,
      status: updated.status,
      storageBytes: Number(updated.storageBytes),
      updatedAt: updated.updatedAt.toISOString(),
      usersLimit: updated.usersLimit
    };
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

    await this.tenantPrismaRegistry.disposeClient(tenantId);
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
}
