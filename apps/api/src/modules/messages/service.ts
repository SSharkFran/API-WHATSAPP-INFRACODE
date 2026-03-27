import { randomInt } from "node:crypto";
import { Worker as BullWorker, type Job, type Queue } from "bullmq";
import type { MessageRecord, PaginatedResult, SendMessagePayload } from "@infracode/types";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import { Redis as IORedis } from "ioredis";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import type { MetricsService } from "../../lib/metrics.js";
import { assertValidPhoneNumber } from "../../lib/phone.js";
import { incrementExpiringCounter } from "../../lib/redis-rate-limit.js";
import { QUEUE_NAMES } from "../../queues/queue-names.js";
import type { InstanceOrchestrator } from "../instances/service.js";
import type { PlanEnforcementService } from "../platform/plan-enforcement.service.js";
import type { WebhookService } from "../webhooks/service.js";

interface MessageServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
  redis: IORedis;
  queue: Queue;
  metricsService: MetricsService;
  instanceOrchestrator: InstanceOrchestrator;
  webhookService: WebhookService;
  planEnforcementService: PlanEnforcementService;
}

interface SendMessageJobPayload {
  tenantId: string;
  instanceId: string;
  messageId: string;
}

/**
 * Coordena envio, agendamento, fila e persistencia de mensagens.
 */
export class MessageService {
  private readonly config: AppConfig;
  private readonly platformPrisma: PlatformPrisma;
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;
  private readonly queue: Queue;
  private readonly metricsService: MetricsService;
  private readonly instanceOrchestrator: InstanceOrchestrator;
  private readonly webhookService: WebhookService;
  private readonly planEnforcementService: PlanEnforcementService;
  private readonly workerConnection: IORedis;
  private readonly ownsWorkerConnection: boolean;
  private readonly sendWorker?: BullWorker<SendMessageJobPayload>;

  public constructor(deps: MessageServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.queue = deps.queue;
    this.metricsService = deps.metricsService;
    this.instanceOrchestrator = deps.instanceOrchestrator;
    this.webhookService = deps.webhookService;
    this.planEnforcementService = deps.planEnforcementService;

    if (this.config.NODE_ENV === "test") {
      this.workerConnection = deps.redis;
      this.ownsWorkerConnection = false;
      return;
    }

    this.workerConnection = deps.redis.duplicate();
    this.ownsWorkerConnection = true;

    this.sendWorker = new BullWorker<SendMessageJobPayload>(
      QUEUE_NAMES.SEND_MESSAGE,
      async (job) => this.processJob(job),
      {
        autorun: true,
        connection: this.workerConnection as never,
        concurrency: 4
      }
    );
  }

  /**
   * Coloca uma mensagem individual na fila de envio.
   */
  public async enqueueMessage(
    tenantId: string,
    instanceId: string,
    payload: SendMessagePayload,
    additionalDelayMs = 0
  ): Promise<MessageRecord> {
    assertValidPhoneNumber(payload.to);
    await this.planEnforcementService.assertCanSendMessage(tenantId);

    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instance = await prisma.instance.findFirst({
      where: {
        id: instanceId
      }
    });

    if (!instance) {
      throw new ApiError(404, "INSTANCE_NOT_FOUND", "Instancia nao encontrada");
    }

    if (instance.status === "BANNED") {
      throw new ApiError(409, "INSTANCE_BANNED", "A instancia esta banida");
    }

    const scheduledAt = payload.scheduledAt ? new Date(payload.scheduledAt) : null;
    const delayMs = Math.max(0, (scheduledAt?.getTime() ?? Date.now()) - Date.now() + additionalDelayMs);
    const message = await prisma.message.create({
      data: {
        instanceId,
        remoteJid: payload.targetJid ?? `${payload.to.replace(/[^\d]/g, "")}@s.whatsapp.net`,
        direction: "OUTBOUND",
        type: payload.type,
        status: delayMs > 0 ? "SCHEDULED" : "QUEUED",
        payload: payload as unknown as Prisma.InputJsonValue,
        traceId: payload.traceId ?? crypto.randomUUID(),
        scheduledAt: delayMs > 0 ? new Date(Date.now() + delayMs) : scheduledAt
      }
    });

    await this.queue.add(
      `message:${message.id}`,
      {
        tenantId,
        instanceId,
        messageId: message.id
      },
      {
        delay: delayMs
      }
    );

    return this.mapMessageRecord(tenantId, message);
  }

  /**
   * Agenda um lote de mensagens com jitter aleatorio entre envios.
   */
  public async enqueueBulkMessages(
    tenantId: string,
    instanceId: string,
    items: SendMessagePayload[],
    minDelayMs: number,
    maxDelayMs: number
  ): Promise<MessageRecord[]> {
    if (minDelayMs > maxDelayMs) {
      throw new ApiError(400, "INVALID_DELAY_RANGE", "minDelayMs nao pode ser maior que maxDelayMs");
    }

    let accumulatedDelay = 0;
    const records: MessageRecord[] = [];

    for (const item of items) {
      accumulatedDelay += randomInt(minDelayMs, maxDelayMs + 1);
      records.push(await this.enqueueMessage(tenantId, instanceId, item, accumulatedDelay));
    }

    return records;
  }

  /**
   * Lista mensagens com filtros e paginacao.
   */
  public async listMessages(
    tenantId: string,
    instanceId: string,
    page: number,
    pageSize: number,
    status?: string,
    type?: string
  ): Promise<PaginatedResult<MessageRecord>> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const where: Prisma.MessageWhereInput = {
      instanceId,
      status: status as never | undefined,
      type: type as never | undefined
    };

    const [total, messages] = await Promise.all([
      prisma.message.count({ where }),
      prisma.message.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize
      })
    ]);

    return {
      data: messages.map((message) => this.mapMessageRecord(tenantId, message)),
      page,
      pageSize,
      total
    };
  }

  /**
   * Retorna a profundidade logica da fila para uma instancia.
   */
  public async getQueueDepth(tenantId: string, instanceId: string): Promise<number> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    return prisma.message.count({
      where: {
        instanceId,
        status: {
          in: ["QUEUED", "SCHEDULED"]
        }
      }
    });
  }

  /**
   * Encerra o worker BullMQ local da API.
   */
  public async close(): Promise<void> {
    if (this.sendWorker) {
      await this.sendWorker.close();
    }

    if (this.ownsWorkerConnection) {
      await this.workerConnection.quit();
    }
  }

  private async processJob(job: Job<SendMessageJobPayload>): Promise<void> {
    const prisma = await this.tenantPrismaRegistry.getClient(job.data.tenantId);
    const message = await prisma.message.findUnique({
      where: {
        id: job.data.messageId
      },
      include: {
        instance: true
      }
    });

    if (!message) {
      return;
    }

    const timer = this.metricsService.messageLatencySeconds.startTimer({
      instance_id: message.instanceId,
      tenant_id: job.data.tenantId,
      type: message.type
    });

    try {
      const tenant = await this.platformPrisma.tenant.findUnique({
        where: {
          id: job.data.tenantId
        }
      });

      if (!tenant) {
        throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
      }

      await this.planEnforcementService.assertCanSendMessage(job.data.tenantId);
      await this.enforceRateLimit(message.instanceId, job.data.tenantId, tenant.rateLimitPerMinute);

      const payload = message.payload as unknown as SendMessagePayload;
      const rpcResult = await this.instanceOrchestrator.sendMessage(job.data.tenantId, message.instanceId, payload);
      const externalMessageId = rpcResult.externalMessageId as string | undefined;

      const updated = await prisma.message.update({
        where: { id: message.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          externalMessageId
        }
      });

      await prisma.instanceUsage.update({
        where: { instanceId: message.instanceId },
        data: {
          messagesSent: {
            increment: 1
          }
        }
      });

      await this.platformPrisma.tenant.update({
        where: { id: job.data.tenantId },
        data: {
          messagesThisMonth: {
            increment: 1
          }
        }
      });

      this.metricsService.messagesTotal.inc({
        direction: "OUTBOUND",
        instance_id: message.instanceId,
        status: updated.status,
        tenant_id: job.data.tenantId,
        type: message.type
      });

      await this.webhookService.enqueueEvent({
        tenantId: job.data.tenantId,
        instanceId: message.instanceId,
        eventType: "message.sent",
        payload: {
          externalMessageId: externalMessageId ?? null,
          instanceId: message.instanceId,
          messageId: message.id,
          status: updated.status,
          traceId: message.traceId,
          type: message.type
        }
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Falha ao enviar mensagem";

      await prisma.message.update({
        where: { id: message.id },
        data: {
          status: "FAILED",
          errorMessage: messageText
        }
      });

      await prisma.instanceUsage.update({
        where: { instanceId: message.instanceId },
        data: {
          errors: {
            increment: 1
          }
        }
      });

      this.metricsService.messagesTotal.inc({
        direction: "OUTBOUND",
        instance_id: message.instanceId,
        status: "FAILED",
        tenant_id: job.data.tenantId,
        type: message.type
      });

      await this.webhookService.enqueueEvent({
        tenantId: job.data.tenantId,
        instanceId: message.instanceId,
        eventType: "message.failed",
        payload: {
          error: messageText,
          instanceId: message.instanceId,
          messageId: message.id,
          traceId: message.traceId,
          type: message.type
        }
      });

      throw error;
    } finally {
      timer();
    }
  }

  private async enforceRateLimit(
    instanceId: string,
    tenantId: string,
    limitPerMinute: number
  ): Promise<void> {
    const now = new Date();
    const bucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
    const key = `rate:${tenantId}:${instanceId}:${bucket}`;
    const current = await incrementExpiringCounter(this.workerConnection, key, 60);

    if (current > limitPerMinute) {
      throw new ApiError(429, "INSTANCE_RATE_LIMIT_EXCEEDED", "Limite de mensagens por minuto excedido", {
        current,
        limitPerMinute
      });
    }
  }

  private mapMessageRecord(
    tenantId: string,
    message: {
      id: string;
      instanceId: string;
      remoteJid: string;
      direction: string;
      type: string;
      status: string;
      payload: unknown;
      traceId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }
  ): MessageRecord {
    return {
      id: message.id,
      tenantId,
      instanceId: message.instanceId,
      remoteJid: message.remoteJid,
      direction: message.direction as MessageRecord["direction"],
      type: message.type as MessageRecord["type"],
      status: message.status as MessageRecord["status"],
      payload: message.payload as Record<string, unknown>,
      traceId: message.traceId,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString()
    };
  }
}
