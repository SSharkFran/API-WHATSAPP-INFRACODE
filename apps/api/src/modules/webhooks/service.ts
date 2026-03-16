import type { Queue } from "bullmq";
import type { PaginatedResult, WebhookConfig } from "@infracode/types";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { ApiError } from "../../lib/errors.js";
import type { MetricsService } from "../../lib/metrics.js";

interface WebhookServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
  queue: Queue;
  metricsService: MetricsService;
}

interface EnqueueWebhookEventInput {
  tenantId: string;
  instanceId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Gerencia configuracao, historico e enfileiramento de webhooks.
 */
export class WebhookService {
  private readonly config: AppConfig;
  private readonly platformPrisma: PlatformPrisma;
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;
  private readonly queue: Queue;
  private readonly metricsService: MetricsService;

  public constructor(deps: WebhookServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.queue = deps.queue;
    this.metricsService = deps.metricsService;
  }

  /**
   * Cria ou atualiza o endpoint de webhook de uma instancia.
   */
  public async upsertConfig(
    tenantId: string,
    instanceId: string,
    payload: {
      url: string;
      secret: string;
      headers: Record<string, string>;
      subscribedEvents: string[];
      isActive: boolean;
    }
  ): Promise<WebhookConfig> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instance = await prisma.instance.findFirst({
      where: {
        id: instanceId
      }
    });

    if (!instance) {
      throw new ApiError(404, "INSTANCE_NOT_FOUND", "Instancia nao encontrada");
    }

    const record = await prisma.webhookEndpoint.upsert({
      where: {
        instanceId
      },
      create: {
        instanceId,
        url: payload.url,
        secretEncrypted: encrypt(payload.secret, this.config.API_ENCRYPTION_KEY),
        headers: payload.headers,
        subscribedEvents: payload.subscribedEvents,
        isActive: payload.isActive
      },
      update: {
        url: payload.url,
        secretEncrypted: encrypt(payload.secret, this.config.API_ENCRYPTION_KEY),
        headers: payload.headers,
        subscribedEvents: payload.subscribedEvents,
        isActive: payload.isActive
      }
    });

    await this.platformPrisma.tenant.update({
      where: {
        id: tenantId
      },
      data: {
        onboardingStep: "WEBHOOK_CONFIGURED"
      }
    });

    return {
      id: record.id,
      instanceId,
      url: record.url,
      secret: payload.secret,
      headers: record.headers as Record<string, string>,
      subscribedEvents: record.subscribedEvents,
      isActive: record.isActive
    };
  }

  /**
   * Retorna a configuracao atual do webhook de uma instancia.
   */
  public async getConfig(tenantId: string, instanceId: string): Promise<WebhookConfig | null> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const record = await prisma.webhookEndpoint.findFirst({
      where: {
        instanceId
      }
    });

    if (!record) {
      return null;
    }

    return {
      id: record.id,
      instanceId,
      url: record.url,
      secret: this.decryptSecret(record.secretEncrypted),
      headers: record.headers as Record<string, string>,
      subscribedEvents: record.subscribedEvents,
      isActive: record.isActive
    };
  }

  /**
   * Lista historico de entregas de webhook da instancia.
   */
  public async listDeliveries(
    tenantId: string,
    instanceId: string,
    page: number,
    pageSize: number
  ): Promise<PaginatedResult<Record<string, unknown>>> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: {
        instanceId
      }
    });

    if (!endpoint) {
      return {
        data: [],
        page,
        pageSize,
        total: 0
      };
    }

    const where = {
      webhookEndpointId: endpoint.id
    };

    const [total, deliveries] = await Promise.all([
      prisma.webhookDelivery.count({ where }),
      prisma.webhookDelivery.findMany({
        where,
        orderBy: {
          createdAt: "desc"
        },
        skip: (page - 1) * pageSize,
        take: pageSize
      })
    ]);

    return {
      data: deliveries.map((delivery) => ({
        id: delivery.id,
        eventType: delivery.eventType,
        status: delivery.status,
        attempt: delivery.attempt,
        httpStatus: delivery.httpStatus,
        responseBody: delivery.responseBody,
        nextRetryAt: delivery.nextRetryAt?.toISOString() ?? null,
        createdAt: delivery.createdAt.toISOString(),
        updatedAt: delivery.updatedAt.toISOString()
      })),
      page,
      pageSize,
      total
    };
  }

  /**
   * Cria uma entrega e a adiciona na fila para processamento assincrono.
   */
  public async enqueueEvent(input: EnqueueWebhookEventInput): Promise<void> {
    const prisma = await this.tenantPrismaRegistry.getClient(input.tenantId);
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: {
        instanceId: input.instanceId,
        isActive: true
      }
    });

    if (!endpoint) {
      return;
    }

    if (!endpoint.subscribedEvents.includes("*") && !endpoint.subscribedEvents.includes(input.eventType)) {
      return;
    }

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookEndpointId: endpoint.id,
        eventType: input.eventType,
        payload: input.payload as Prisma.InputJsonValue
      }
    });

    await this.queue.add(`webhook:${delivery.id}`, {
      deliveryId: delivery.id,
      tenantId: input.tenantId,
      instanceId: input.instanceId
    });
  }

  /**
   * Descriptografa o secret persistido para uso no worker de dispatch.
   */
  public decryptSecret(value: string): string {
    return decrypt(value, this.config.API_ENCRYPTION_KEY);
  }

  /**
   * Atualiza metricas de entrega de webhook.
   */
  public recordDeliveryMetric(
    instanceId: string,
    tenantId: string,
    eventType: string,
    status: "SUCCESS" | "FAILED" | "DEAD_LETTER"
  ): void {
    this.metricsService.webhookDeliveriesTotal.inc({
      event_type: eventType,
      instance_id: instanceId,
      tenant_id: tenantId,
      status
    });
  }
}
