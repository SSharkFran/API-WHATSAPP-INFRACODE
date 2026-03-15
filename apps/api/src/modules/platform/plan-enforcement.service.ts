import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";

interface PlanEnforcementServiceDeps {
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
}

/**
 * Aplica limites contratuais por tenant antes das operacoes mais sensiveis.
 */
export class PlanEnforcementService {
  private readonly platformPrisma: PlatformPrisma;
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;

  public constructor(deps: PlanEnforcementServiceDeps) {
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
  }

  /**
   * Garante que o tenant pode criar mais uma instancia.
   */
  public async assertCanCreateInstance(tenantId: string): Promise<void> {
    const tenant = await this.requireActiveTenant(tenantId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const count = await prisma.instance.count();

    if (count >= tenant.instanceLimit) {
      throw new ApiError(409, "INSTANCE_LIMIT_REACHED", "Limite de instancias do plano atingido", {
        current: count,
        limit: tenant.instanceLimit
      });
    }
  }

  /**
   * Garante que o tenant pode criar mais um usuario humano.
   */
  public async assertCanCreateUser(tenantId: string): Promise<void> {
    const tenant = await this.requireActiveTenant(tenantId);
    const count = await this.platformPrisma.tenantMembership.count({
      where: {
        tenantId
      }
    });

    if (count >= tenant.usersLimit) {
      throw new ApiError(409, "USERS_LIMIT_REACHED", "Limite de usuarios do plano atingido", {
        current: count,
        limit: tenant.usersLimit
      });
    }
  }

  /**
   * Garante que o tenant ainda pode consumir mensagens no periodo atual.
   */
  public async assertCanSendMessage(tenantId: string): Promise<void> {
    const tenant = await this.requireActiveTenant(tenantId);

    if (tenant.messagesThisMonth >= tenant.messagesPerMonth) {
      throw new ApiError(429, "PLAN_MESSAGE_LIMIT_REACHED", "Limite mensal de mensagens atingido", {
        current: tenant.messagesThisMonth,
        limit: tenant.messagesPerMonth
      });
    }
  }

  /**
   * Retorna o limite de rate limit HTTP/mensageria para o tenant.
   */
  public async getTenantRateLimitPerMinute(tenantId: string): Promise<number> {
    const tenant = await this.requireActiveTenant(tenantId);
    return tenant.rateLimitPerMinute;
  }

  /**
   * Valida se o tenant esta operacional para acesso ou automacoes.
   */
  public async assertTenantOperational(tenantId: string): Promise<void> {
    await this.requireActiveTenant(tenantId);
  }

  private async requireActiveTenant(tenantId: string) {
    const tenant = await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      }
    });

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    if (tenant.status !== "ACTIVE" || tenant.suspendedAt) {
      throw new ApiError(403, "TENANT_SUSPENDED", "Tenant suspenso");
    }

    return tenant;
  }
}
