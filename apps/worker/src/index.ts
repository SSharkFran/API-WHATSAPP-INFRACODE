import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { Worker as BullWorker, type Job } from "bullmq";
import pino from "pino";
import { z } from "zod";
import { PrismaClient as PlatformPrismaClient } from "../../../prisma/generated/platform-client/index.js";
import { PrismaClient as TenantPrismaClient } from "../../../prisma/generated/tenant-client/index.js";

const envSchema = z.object({
  PLATFORM_DATABASE_URL: z.string().url().optional(),
  TENANT_DATABASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_ENCRYPTION_KEY: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10)
});

interface WebhookJobPayload {
  deliveryId: string;
  tenantId: string;
  instanceId: string;
}

const withSchema = (value: string, schema: string): string => {
  const url = new URL(value);
  url.searchParams.set("schema", schema);
  url.searchParams.set("connection_limit", "2");
  return url.toString();
};

const config = envSchema.parse(process.env);
const logger = pino({ level: process.env.NODE_ENV === "production" ? "info" : "debug" });
const platformBaseUrl = config.PLATFORM_DATABASE_URL ?? config.DATABASE_URL;
const tenantBaseUrl = config.TENANT_DATABASE_URL ?? config.DATABASE_URL;
const platformPrisma = new PlatformPrismaClient({
  datasourceUrl: withSchema(platformBaseUrl, "platform")
});
const tenantClients = new Map<string, TenantPrismaClient>();
const redisUrl = new URL(config.REDIS_URL);
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  db: redisUrl.pathname && redisUrl.pathname !== "/" ? Number(redisUrl.pathname.slice(1)) : undefined,
  maxRetriesPerRequest: null
};

const decrypt = (ciphertext: string, key: string): string => {
  const normalizedKey = createHash("sha256").update(key).digest();
  const [ivBase64, tagBase64, encryptedBase64] = ciphertext.split(".");

  if (!ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error("Payload criptografado invalido");
  }

  const decipher = createDecipheriv("aes-256-gcm", normalizedKey, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));

  return Buffer.concat([decipher.update(Buffer.from(encryptedBase64, "base64")), decipher.final()]).toString("utf8");
};

const buildHmacSignature = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

const getTenantPrisma = async (tenantId: string): Promise<TenantPrismaClient> => {
  const cached = tenantClients.get(tenantId);

  if (cached) {
    return cached;
  }

  const tenant = await platformPrisma.tenant.findUnique({
    where: {
      id: tenantId
    }
  });

  if (!tenant) {
    throw new Error(`Tenant ${tenantId} nao encontrado`);
  }

  const client = new TenantPrismaClient({
    datasourceUrl: withSchema(tenantBaseUrl, tenant.schemaName)
  });
  tenantClients.set(tenantId, client);
  return client;
};

const markDelivery = async (
  tenantId: string,
  job: Job<WebhookJobPayload>,
  status: "SUCCESS" | "FAILED" | "DEAD_LETTER",
  payload: {
    httpStatus?: number;
    responseBody?: string;
  }
): Promise<void> => {
  const prisma = await getTenantPrisma(tenantId);
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;
  const isDeadLetter = status === "DEAD_LETTER" || attempt >= maxAttempts;

  await prisma.webhookDelivery.update({
    where: {
      id: job.data.deliveryId
    },
    data: {
      attempt: attempt === 0 ? 1 : attempt,
      status: isDeadLetter ? "DEAD_LETTER" : status,
      httpStatus: payload.httpStatus,
      responseBody: payload.responseBody?.slice(0, 4_000),
      nextRetryAt:
        isDeadLetter || status === "SUCCESS" ? null : new Date(Date.now() + 5_000 * Math.max(job.attemptsMade, 1))
    }
  });
};

const worker = new BullWorker<WebhookJobPayload>(
  "webhook-dispatch",
  async (job) => {
    const prisma = await getTenantPrisma(job.data.tenantId);
    const delivery = await prisma.webhookDelivery.findUnique({
      where: {
        id: job.data.deliveryId
      },
      include: {
        webhookEndpoint: {
          include: {
            instance: true
          }
        }
      }
    });

    if (!delivery) {
      logger.warn({ jobId: job.id }, "Entrega de webhook nao encontrada");
      return;
    }

    const secret = decrypt(delivery.webhookEndpoint.secretEncrypted, config.API_ENCRYPTION_KEY);
    const body = JSON.stringify(delivery.payload);
    const headers = {
      "content-type": "application/json",
      "x-infracode-delivery-id": delivery.id,
      "x-infracode-event": delivery.eventType,
      "x-infracode-signature": buildHmacSignature(body, secret),
      ...(delivery.webhookEndpoint.headers as Record<string, string>)
    };

    try {
      const response = await fetch(delivery.webhookEndpoint.url, {
        method: "POST",
        headers,
        body
      });
      const responseBody = await response.text();

      if (!response.ok) {
        await markDelivery(job.data.tenantId, job, job.attemptsMade + 1 >= (job.opts.attempts ?? 1) ? "DEAD_LETTER" : "FAILED", {
          httpStatus: response.status,
          responseBody
        });
        throw new Error(`Webhook respondeu com HTTP ${response.status}`);
      }

      await prisma.webhookDelivery.update({
        where: {
          id: delivery.id
        },
        data: {
          attempt: job.attemptsMade + 1,
          status: "SUCCESS",
          httpStatus: response.status,
          responseBody: responseBody.slice(0, 4_000),
          nextRetryAt: null
        }
      });

      logger.info(
        {
          deliveryId: delivery.id,
          eventType: delivery.eventType,
          instanceId: job.data.instanceId,
          tenantId: job.data.tenantId
        },
        "Webhook entregue com sucesso"
      );
    } catch (error) {
      if ((error as Error).message.startsWith("Webhook respondeu com HTTP")) {
        throw error;
      }

      await markDelivery(job.data.tenantId, job, job.attemptsMade + 1 >= (job.opts.attempts ?? 1) ? "DEAD_LETTER" : "FAILED", {
        responseBody: error instanceof Error ? error.message : "Falha de rede"
      });

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: config.WORKER_CONCURRENCY
  }
);

worker.on("completed", (job) => {
  logger.debug({ deliveryId: job.data.deliveryId, jobId: job.id }, "Job de webhook concluido");
});

worker.on("failed", (job, error) => {
  logger.error(
    {
      deliveryId: job?.data.deliveryId,
      jobId: job?.id,
      error: error.message
    },
    "Job de webhook falhou"
  );
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "Encerrando worker");
  await worker.close();

  for (const client of tenantClients.values()) {
    await client.$disconnect();
  }

  await platformPrisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

logger.info({ concurrency: config.WORKER_CONCURRENCY }, "Worker de webhooks iniciado");
