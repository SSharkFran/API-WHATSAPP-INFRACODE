import { randomBytes } from "node:crypto";
import type { AppConfig } from "../../config.js";
import { dedupeScopes } from "../../lib/authz.js";
import { sha256 } from "../../lib/crypto.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import type { EmailService } from "../../lib/mail.js";

interface TenantManagementServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
  emailService: EmailService;
}

/**
 * Reune operacoes administrativas do painel do cliente.
 */
export class TenantManagementService {
  private readonly config: AppConfig;
  private readonly platformPrisma: PlatformPrisma;
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;
  private readonly emailService: EmailService;

  public constructor(deps: TenantManagementServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.emailService = deps.emailService;
  }

  /**
   * Lista usuarios internos com seus papeis no tenant atual.
   */
  public async listUsers(tenantId: string) {
    const memberships = await this.platformPrisma.tenantMembership.findMany({
      where: {
        tenantId
      },
      include: {
        user: true
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    return memberships.map((membership) => ({
      email: membership.user.email,
      id: membership.user.id,
      isActive: membership.user.isActive,
      lastLoginAt: membership.user.lastLoginAt?.toISOString() ?? null,
      name: membership.user.name,
      role: membership.role as "ADMIN" | "OPERATOR" | "VIEWER",
      twoFactorEnabled: membership.user.twoFactorEnabled
    }));
  }

  /**
   * Envia convite para um novo usuario interno do tenant, respeitando o limite do plano.
   */
  public async inviteUser(tenantId: string, invitedByUserId: string, input: { email: string; role: string }) {
    const tenant = await this.requireTenant(tenantId);
    const currentUsers = await this.platformPrisma.tenantMembership.count({
      where: {
        tenantId
      }
    });

    if (currentUsers >= tenant.usersLimit) {
      throw new ApiError(409, "USERS_LIMIT_REACHED", "Limite de usuarios do plano atingido", {
        limit: tenant.usersLimit
      });
    }

    const token = randomBytes(32).toString("base64url");
    const invitation = await this.platformPrisma.invitation.create({
      data: {
        email: input.email.toLowerCase(),
        expiresAt: new Date(Date.now() + this.config.INVITATION_TTL_HOURS * 60 * 60 * 1000),
        invitedByUserId,
        role: input.role,
        tenantId,
        tokenHash: sha256(token)
      }
    });

    await this.emailService.sendTemplate({
      subject: `InfraCode | Convite para ${tenant.name}`,
      template: "tenant-user-invitation",
      to: input.email.toLowerCase(),
      variables: {
        acceptUrl: `https://${tenant.slug}.${this.config.ROOT_DOMAIN}/primeiro-acesso?token=${token}`,
        tenantName: tenant.name
      }
    });

    return {
      acceptUrl: `https://${tenant.slug}.${this.config.ROOT_DOMAIN}/primeiro-acesso?token=${token}`,
      email: invitation.email,
      expiresAt: invitation.expiresAt.toISOString(),
      id: invitation.id,
      role: invitation.role
    };
  }

  /**
   * Lista API keys emitidas para integracoes do tenant.
   */
  public async listApiKeys(tenantId: string) {
    const keys = await this.platformPrisma.apiKey.findMany({
      where: {
        tenantId
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    return keys.map((key) => ({
      createdAt: key.createdAt.toISOString(),
      expiresAt: key.expiresAt?.toISOString() ?? null,
      id: key.id,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      name: key.name,
      revokedAt: key.revokedAt?.toISOString() ?? null,
      scopes: key.scopes as Array<"read" | "write" | "admin">
    }));
  }

  /**
   * Cria uma API key com escopos tenant-scoped.
   */
  public async createApiKey(
    tenantId: string,
    input: {
      expiresAt?: string;
      name: string;
      scopes: Array<"read" | "write" | "admin">;
    }
  ) {
    await this.requireTenant(tenantId);
    const apiKey = `ik_live_${randomBytes(24).toString("base64url")}`;
    const created = await this.platformPrisma.apiKey.create({
      data: {
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        keyHash: sha256(apiKey),
        name: input.name,
        scopes: dedupeScopes(input.scopes),
        tenantId
      }
    });

    return {
      apiKey,
      createdAt: created.createdAt.toISOString(),
      expiresAt: created.expiresAt?.toISOString() ?? null,
      id: created.id,
      lastUsedAt: created.lastUsedAt?.toISOString() ?? null,
      name: created.name,
      revokedAt: created.revokedAt?.toISOString() ?? null,
      scopes: created.scopes as Array<"read" | "write" | "admin">
    };
  }

  /**
   * Revoga uma API key do tenant atual.
   */
  public async revokeApiKey(tenantId: string, apiKeyId: string): Promise<void> {
    const key = await this.platformPrisma.apiKey.findFirst({
      where: {
        id: apiKeyId,
        tenantId
      }
    });

    if (!key) {
      throw new ApiError(404, "API_KEY_NOT_FOUND", "API key nao encontrada");
    }

    await this.platformPrisma.apiKey.update({
      where: {
        id: key.id
      },
      data: {
        revokedAt: new Date()
      }
    });
  }

  /**
   * Retorna o estado do onboarding com base nos recursos reais do tenant.
   */
  public async getOnboarding(tenantId: string) {
    const tenant = await this.requireTenant(tenantId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const [instancesTotal, connectedInstances, webhookCount, memberships] = await Promise.all([
      prisma.instance.count(),
      prisma.instance.count({
        where: {
          status: "CONNECTED"
        }
      }),
      prisma.webhookEndpoint.count({
        where: {
          isActive: true
        }
      }),
      this.platformPrisma.tenantMembership.count({
        where: {
          tenantId
        }
      })
    ]);

    const steps = [
      {
        code: "PASSWORD_DEFINED",
        label: "Definir senha",
        completed: memberships > 0
      },
      {
        code: "INSTANCE_CREATED",
        label: "Criar primeira instancia",
        completed: instancesTotal > 0
      },
      {
        code: "INSTANCE_CONNECTED",
        label: "Conectar QR Code",
        completed: connectedInstances > 0
      },
      {
        code: "WEBHOOK_CONFIGURED",
        label: "Configurar webhook",
        completed: webhookCount > 0
      }
    ];

    const currentStep = steps.find((step) => !step.completed)?.code ?? "COMPLETED";
    const completedAt = steps.every((step) => step.completed) ? tenant.onboardingCompletedAt ?? new Date() : null;

    await this.platformPrisma.tenant.update({
      where: {
        id: tenantId
      },
      data: {
        onboardingCompletedAt: completedAt,
        onboardingStep: currentStep
      }
    });

    return {
      completedAt: completedAt?.toISOString() ?? null,
      currentStep,
      steps,
      tenantId: tenant.id,
      tenantSlug: tenant.slug
    };
  }

  /**
   * Retorna configuracoes basicas do tenant.
   */
  public async getSettings(tenantId: string) {
    const tenant = await this.requireTenant(tenantId);

    return {
      billingEmail: tenant.billingEmail,
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status
    };
  }

  /**
   * Atualiza configuracoes basicas controladas pelo cliente.
   */
  public async updateSettings(
    tenantId: string,
    input: {
      billingEmail?: string | null;
      name?: string;
    }
  ) {
    const tenant = await this.platformPrisma.tenant.update({
      where: {
        id: tenantId
      },
      data: {
        billingEmail: input.billingEmail,
        name: input.name
      }
    });

    return {
      billingEmail: tenant.billingEmail,
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status
    };
  }

  /**
   * Consolida metricas do dashboard do cliente.
   */
  public async getDashboard(tenantId: string) {
    const tenant = await this.requireTenant(tenantId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const [instances, connectedInstances, queuedMessages, usersUsed] = await Promise.all([
      prisma.instance.count(),
      prisma.instance.count({
        where: {
          status: "CONNECTED"
        }
      }),
      prisma.message.count({
        where: {
          status: {
            in: ["QUEUED", "SCHEDULED"]
          }
        }
      }),
      this.platformPrisma.tenantMembership.count({
        where: {
          tenantId
        }
      })
    ]);

    return {
      activeInstances: connectedInstances,
      connectedInstances,
      messagesPerMonth: tenant.messagesPerMonth,
      messagesThisMonth: tenant.messagesThisMonth,
      queuedMessages,
      tenantId: tenant.id,
      tenantName: tenant.name,
      totalInstances: instances,
      usersLimit: tenant.usersLimit,
      usersUsed
    };
  }

  private async requireTenant(tenantId: string) {
    const tenant = await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      }
    });

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    if (tenant.status !== "ACTIVE" && tenant.status !== "SUSPENDED") {
      throw new ApiError(403, "TENANT_UNAVAILABLE", "Tenant indisponivel");
    }

    return tenant;
  }
}
