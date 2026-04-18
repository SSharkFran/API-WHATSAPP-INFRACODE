import { randomBytes } from "node:crypto";
import type { AppConfig } from "../../config.js";
import { dedupeScopes } from "../../lib/authz.js";
import { sha256 } from "../../lib/crypto.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import type { EmailService } from "../../lib/mail.js";

// ---------------------------------------------------------------------------
// Public interfaces for metrics endpoints
// ---------------------------------------------------------------------------

export interface TodayMetricsSnapshot {
  startedCount: number;
  endedCount: number;
  inactiveCount: number;
  handoffCount: number;
  avgDurationSeconds: number | null;
  avgFirstResponseMs: number | null;
  continuationRate: number | null; // percentage 0-100 or null if no closed sessions
}

export interface ActiveQueueEntry {
  id: string;
  instanceId: string;
  remoteJid: string;
  contactId: string | null;
  startedAt: string;
  urgencyScore: number;
  elapsedSeconds: number;
}

// ---------------------------------------------------------------------------
// Private row types for raw SQL queries
// ---------------------------------------------------------------------------

interface MetricsRow {
  startedCount: unknown;
  endedCount: unknown;
  inactiveCount: unknown;
  handoffCount: unknown;
  avgDurationSeconds: unknown;
  avgFirstResponseMs: unknown;
}

interface ContinuationRow {
  timedOutCount: unknown;
  totalClosedCount: unknown;
}

interface ActiveQueueRow {
  id: string;
  instanceId: string;
  remoteJid: string;
  contactId: string | null;
  startedAt: unknown;
  urgencyScore: number | null;
  elapsedSeconds: number | null;
}

function emptyMetricsSnapshot(): TodayMetricsSnapshot {
  return {
    startedCount: 0,
    endedCount: 0,
    inactiveCount: 0,
    handoffCount: 0,
    avgDurationSeconds: null,
    avgFirstResponseMs: null,
    continuationRate: null,
  };
}

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

    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      instances,
      connectedInstances,
      queuedMessages,
      usersUsed,
      messagesTodayOutbound,
      escalationsToday,
      knowledgeLearnedToday,
      resolvedCount,
      pendingCount
    ] = await Promise.all([
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
      }),
      prisma.message.count({
        where: {
          direction: "OUTBOUND",
          createdAt: { gte: startOfToday }
        }
      }),
      prisma.conversation.count({
        where: {
          awaitingAdminResponse: true,
          pendingClientQuestion: { not: null },
          updatedAt: { gte: startOfToday }
        }
      }),
      prisma.tenantKnowledge.count({
        where: { createdAt: { gte: startOfToday } }
      }),
      prisma.conversation.count({
        where: {
          awaitingAdminResponse: false,
          pendingClientQuestion: null,
          updatedAt: { gte: sevenDaysAgo }
        }
      }),
      prisma.conversation.count({
        where: {
          awaitingAdminResponse: true,
          updatedAt: { gte: sevenDaysAgo }
        }
      })
    ]);

    const total = resolvedCount + pendingCount;
    const resolutionRateLast7Days = total > 0 ? Math.round((resolvedCount / total) * 1000) / 10 : 0;

    return {
      activeInstances: connectedInstances,
      connectedInstances,
      escalationsToday,
      knowledgeLearnedToday,
      messagesPerMonth: tenant.messagesPerMonth,
      messagesThisMonth: tenant.messagesThisMonth,
      messagesTodayOutbound,
      queuedMessages,
      resolutionRateLast7Days,
      tenantId: tenant.id,
      tenantName: tenant.name,
      totalInstances: instances,
      usersLimit: tenant.usersLimit,
      usersUsed
    };
  }

  /**
   * Retorna metricas de atendimento do dia corrente para o tenant.
   */
  public async getTodayMetrics(tenantId: string): Promise<TodayMetricsSnapshot> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instances = await prisma.instance.findMany({
      where: { deletedAt: null },
      select: { id: true }
    });
    const instanceIds = instances.map((inst) => inst.id);
    if (instanceIds.length === 0) {
      return emptyMetricsSnapshot();
    }
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    const [metricsRows, continuationRows] = await Promise.all([
      prisma.$queryRawUnsafe<MetricsRow[]>(
        `SELECT
           COUNT(*) FILTER (WHERE "status" != 'INATIVA') AS "startedCount",
           COUNT(*) FILTER (WHERE "status" = 'ENCERRADA') AS "endedCount",
           COUNT(*) FILTER (WHERE "status" = 'INATIVA') AS "inactiveCount",
           COUNT(*) FILTER (WHERE "handoffCount" > 0) AS "handoffCount",
           ROUND(AVG("durationSeconds")::numeric, 0)::INTEGER AS "avgDurationSeconds",
           ROUND(AVG("firstResponseMs")::numeric, 0)::INTEGER AS "avgFirstResponseMs"
         FROM "ConversationSession"
         WHERE "instanceId" = ANY($1::text[])
           AND "startedAt" >= $2`,
        instanceIds,
        startOfToday
      ),
      prisma.$queryRawUnsafe<ContinuationRow[]>(
        `SELECT
           COUNT(*) FILTER (WHERE "closedReason" = 'timeout_no_response') AS "timedOutCount",
           COUNT(*) FILTER (WHERE "closedReason" IS NOT NULL) AS "totalClosedCount"
         FROM "ConversationSession"
         WHERE "instanceId" = ANY($1::text[])
           AND "startedAt" >= $2`,
        instanceIds,
        startOfToday
      )
    ]);

    const m = metricsRows[0];
    const c = continuationRows[0];
    const timedOut = parseInt(String(c?.timedOutCount ?? 0), 10);
    const totalClosed = parseInt(String(c?.totalClosedCount ?? 0), 10);
    const continuationRate = totalClosed > 0
      ? parseFloat(((1 - timedOut / totalClosed) * 100).toFixed(1))
      : null;

    return {
      startedCount: parseInt(String(m?.startedCount ?? 0), 10),
      endedCount: parseInt(String(m?.endedCount ?? 0), 10),
      inactiveCount: parseInt(String(m?.inactiveCount ?? 0), 10),
      handoffCount: parseInt(String(m?.handoffCount ?? 0), 10),
      avgDurationSeconds: m?.avgDurationSeconds ? parseInt(String(m.avgDurationSeconds), 10) : null,
      avgFirstResponseMs: m?.avgFirstResponseMs ? parseInt(String(m.avgFirstResponseMs), 10) : null,
      continuationRate,
    };
  }

  /**
   * Retorna fila de atendimentos ativos ordenada por urgencia para o tenant.
   */
  public async getActiveQueue(tenantId: string): Promise<ActiveQueueEntry[]> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instances = await prisma.instance.findMany({
      where: { deletedAt: null },
      select: { id: true }
    });
    const instanceIds = instances.map((inst) => inst.id);
    if (instanceIds.length === 0) return [];

    const rows = await prisma.$queryRawUnsafe<ActiveQueueRow[]>(
      `SELECT
         cs."id",
         cs."instanceId",
         cs."remoteJid",
         cs."contactId",
         cs."startedAt",
         cs."urgencyScore",
         EXTRACT(EPOCH FROM (NOW() - cs."startedAt"))::INTEGER AS "elapsedSeconds"
       FROM "ConversationSession" cs
       WHERE cs."instanceId" = ANY($1::text[])
         AND cs."status" = 'ATIVA'
       ORDER BY cs."urgencyScore" DESC, cs."startedAt" ASC
       LIMIT 50`,
      instanceIds
    );

    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instanceId,
      remoteJid: r.remoteJid,
      contactId: r.contactId ?? null,
      startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : String(r.startedAt),
      urgencyScore: r.urgencyScore ?? 0,
      elapsedSeconds: r.elapsedSeconds ?? 0,
    }));
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
