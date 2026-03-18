import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  ClientMemory,
  InstanceHealthReport,
  InstanceLogEvent,
  InstanceSummary,
  MessageType,
  QrCodeEvent,
  SendMessagePayload
} from "@infracode/types";
import type { Prisma, Instance, InstanceUsage } from "../../../../../prisma/generated/tenant-client/index.js";
import { Redis as IORedis } from "ioredis";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import type { MetricsService } from "../../lib/metrics.js";
import { normalizePhoneNumber, toJid } from "../../lib/phone.js";
import type { ClientMemoryService } from "../chatbot/memory.service.js";
import type { ChatbotService } from "../chatbot/service.js";
import type { PlanEnforcementService } from "../platform/plan-enforcement.service.js";
import type { WebhookService } from "../webhooks/service.js";
import type { FiadoService } from "../chatbot/fiado.service.js";

interface InstanceOrchestratorDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
  redis: IORedis;
  metricsService: MetricsService;
  webhookService: WebhookService;
  planEnforcementService: PlanEnforcementService;
  chatbotService: ChatbotService;
  clientMemoryService: ClientMemoryService;
  fiadoService: FiadoService;
}

interface StatusWorkerEvent {
  type: "status";
  status: InstanceSummary["status"];
  reconnectAttempts?: number;
  lastError?: string;
}

interface LogWorkerEvent {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

interface QrWorkerEvent {
  type: "qr";
  qrCodeBase64: string;
  expiresInSeconds: number;
}

interface ProfileWorkerEvent {
  type: "profile";
  phoneNumber?: string | null;
  avatarUrl?: string | null;
}

interface InboundMessageWorkerEvent {
  type: "inbound-message";
  remoteJid: string;
  externalMessageId?: string;
  payload: Record<string, unknown>;
  messageType: MessageType;
}

interface RpcResultWorkerEvent {
  type: "rpc-result";
  requestId: string;
  data: Record<string, unknown>;
}

interface RpcErrorWorkerEvent {
  type: "rpc-error";
  requestId: string;
  error: {
    message: string;
  };
}

type WorkerEvent =
  | StatusWorkerEvent
  | LogWorkerEvent
  | QrWorkerEvent
  | ProfileWorkerEvent
  | InboundMessageWorkerEvent
  | RpcResultWorkerEvent
  | RpcErrorWorkerEvent;

interface ManagedWorker {
  worker: Worker;
  paused: boolean;
  currentStatus: InstanceSummary["status"];
  pendingRequests: Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason?: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >;
}

interface CreateInstanceInput {
  name: string;
  proxyUrl?: string;
  autoStart: boolean;
}

const buildWorkerKey = (tenantId: string, instanceId: string): string => `${tenantId}:${instanceId}`;

/**
 * Orquestra o ciclo de vida das instancias WhatsApp em workers isolados.
 */
export class InstanceOrchestrator {
  private readonly config: AppConfig;
  private readonly metricsService: MetricsService;
  private readonly platformPrisma: PlatformPrisma;
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;
  private readonly redis: IORedis;
  private readonly webhookService: WebhookService;
  private readonly planEnforcementService: PlanEnforcementService;
  private readonly chatbotService: ChatbotService;
  private readonly clientMemoryService: ClientMemoryService;
  private readonly fiadoService: FiadoService;
  private readonly logEmitter = new EventEmitter();
  private readonly qrEmitter = new EventEmitter();
  private readonly latestQrCodes = new Map<string, QrCodeEvent>();
  private readonly workers = new Map<string, ManagedWorker>();

  public constructor(deps: InstanceOrchestratorDeps) {
    this.config = deps.config;
    this.metricsService = deps.metricsService;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.redis = deps.redis;
    this.webhookService = deps.webhookService;
    this.planEnforcementService = deps.planEnforcementService;
    this.chatbotService = deps.chatbotService;
    this.clientMemoryService = deps.clientMemoryService;
    this.fiadoService = deps.fiadoService;
  }

  /**
   * Reinicia automaticamente instancias persistidas de tenants ativos.
   */
  public async bootstrapPersistedInstances(): Promise<void> {
    const tenants = await this.platformPrisma.tenant.findMany({
      where: {
        status: "ACTIVE",
        suspendedAt: null
      },
      select: {
        id: true
      }
    });

    for (const tenant of tenants) {
      const prisma = await this.tenantPrismaRegistry.getClient(tenant.id);
      const instances = await prisma.instance.findMany({
        where: {
          status: {
            notIn: ["PAUSED", "BANNED"]
          }
        }
      });

      for (const instance of instances) {
        await this.startInstance(tenant.id, instance.id);
      }
    }
  }

  /**
   * Lista as instancias de um tenant com resumo de uso.
   */
  public async listInstances(tenantId: string): Promise<InstanceSummary[]> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instances = await prisma.instance.findMany({
      include: { usage: true },
      orderBy: { createdAt: "desc" }
    });

    return instances.map((instance) => this.mapInstanceSummary(tenantId, instance));
  }

  /**
   * Cria uma nova instancia e inicializa a estrutura de sessao.
   */
  public async createInstance(tenantId: string, input: CreateInstanceInput): Promise<InstanceSummary> {
    await this.planEnforcementService.assertCanCreateInstance(tenantId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instanceId = crypto.randomUUID();
    const paths = this.resolveStoragePaths(tenantId, instanceId);

    await mkdir(paths.authDirectory, { recursive: true });
    await mkdir(dirname(paths.sessionDbPath), { recursive: true });

    const created = await prisma.instance.create({
      data: {
        id: instanceId,
        name: input.name,
        status: "INITIALIZING",
        proxyUrl: input.proxyUrl,
        authDirectory: paths.authDirectory,
        sessionDbPath: paths.sessionDbPath,
        usage: {
          create: {}
        }
      },
      include: {
        usage: true
      }
    });

    await this.platformPrisma.tenant.update({
      where: {
        id: tenantId
      },
      data: {
        onboardingStep: "INSTANCE_CREATED"
      }
    });

    this.metricsService.setInstanceStatus(created.id, tenantId, created.status);

    if (input.autoStart) {
      await this.startInstance(tenantId, created.id);
      const started = await this.requireInstanceWithUsage(tenantId, created.id);
      return this.mapInstanceSummary(tenantId, started);
    }

    return this.mapInstanceSummary(tenantId, created);
  }

  /**
   * Inicia ou reinicia o worker associado a uma instancia.
   */
  public async startInstance(tenantId: string, instanceId: string): Promise<InstanceSummary> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instance = await this.requireInstanceWithUsage(tenantId, instanceId);

    if (instance.status === "BANNED") {
      throw new ApiError(409, "INSTANCE_BANNED", "Instancia marcada como banida e nao pode ser iniciada");
    }

    const workerKey = buildWorkerKey(tenantId, instanceId);

    if (this.workers.has(workerKey)) {
      return this.mapInstanceSummary(tenantId, instance);
    }

    await prisma.instance.update({
      where: { id: instanceId },
      data: {
        pausedAt: null,
        status: "INITIALIZING",
        lastError: null
      }
    });

    await this.spawnWorker(tenantId, instance);
    const updated = await this.requireInstanceWithUsage(tenantId, instanceId);
    return this.mapInstanceSummary(tenantId, updated);
  }

  /**
   * Pausa a instancia e preserva os dados de autenticacao.
   */
  public async pauseInstance(tenantId: string, instanceId: string): Promise<InstanceSummary> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    await this.requireInstanceWithUsage(tenantId, instanceId);
    await this.stopWorker(tenantId, instanceId, true);

    const updated = await prisma.instance.update({
      where: { id: instanceId },
      data: {
        pausedAt: new Date(),
        status: "PAUSED"
      },
      include: { usage: true }
    });

    this.metricsService.setInstanceStatus(updated.id, tenantId, updated.status);
    return this.mapInstanceSummary(tenantId, updated);
  }

  /**
   * Reinicia a instancia mantendo a sessao persistida.
   */
  public async restartInstance(tenantId: string, instanceId: string): Promise<InstanceSummary> {
    await this.pauseInstance(tenantId, instanceId);
    return this.startInstance(tenantId, instanceId);
  }

  /**
   * Remove a instancia, dados de sessao e registros associados.
   */
  public async deleteInstance(tenantId: string, instanceId: string): Promise<void> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    await this.requireInstanceWithUsage(tenantId, instanceId);
    await this.stopWorker(tenantId, instanceId, false);
    await prisma.instance.delete({
      where: { id: instanceId }
    });
    await rm(this.resolveStoragePaths(tenantId, instanceId).baseDirectory, {
      recursive: true,
      force: true
    });
    this.latestQrCodes.delete(buildWorkerKey(tenantId, instanceId));
  }

  /**
   * Retorna o relatorio de health detalhado da instancia.
   */
  public async getHealthReport(
    tenantId: string,
    instanceId: string,
    queueDepth: number
  ): Promise<InstanceHealthReport> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instance = await this.requireInstanceWithUsage(tenantId, instanceId);
    const managedWorker = this.workers.get(buildWorkerKey(tenantId, instanceId));
    let databaseConnected = true;

    try {
      await prisma.$queryRawUnsafe("SELECT 1");
    } catch {
      databaseConnected = false;
    }

    const qr = this.latestQrCodes.get(buildWorkerKey(tenantId, instanceId));

    return {
      instanceId,
      status: instance.status as InstanceHealthReport["status"],
      workerOnline: Boolean(managedWorker),
      redisConnected: this.redis.status === "ready",
      databaseConnected,
      qrExpiresIn: qr?.expiresInSeconds,
      lastActivityAt: instance.lastActivityAt?.toISOString() ?? null,
      lastError: instance.lastError ?? null,
      reconnectAttempts: instance.reconnectAttempts,
      uptimeSeconds: instance.usage?.uptimeSeconds ?? 0,
      queueDepth
    };
  }

  /**
   * Envia uma chamada RPC para o worker da instancia.
   */
  public async sendMessage(
    tenantId: string,
    instanceId: string,
    payload: SendMessagePayload
  ): Promise<Record<string, unknown>> {
    const instance = await this.requireInstanceWithUsage(tenantId, instanceId);

    if (instance.status === "PAUSED") {
      throw new ApiError(409, "INSTANCE_PAUSED", "A instancia esta pausada");
    }

    if (instance.status === "BANNED") {
      throw new ApiError(409, "INSTANCE_BANNED", "A instancia esta banida");
    }

    const workerKey = buildWorkerKey(tenantId, instanceId);

    if (!this.workers.has(workerKey)) {
      await this.startInstance(tenantId, instanceId);
    }

    const managedWorker = this.workers.get(workerKey);

    if (!managedWorker) {
      throw new ApiError(503, "WORKER_UNAVAILABLE", "Worker da instancia indisponivel");
    }

    const requestId = crypto.randomUUID();

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        managedWorker.pendingRequests.delete(requestId);
        reject(new ApiError(504, "INSTANCE_RPC_TIMEOUT", "Tempo limite excedido no worker da instancia"));
      }, 60_000);

      managedWorker.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout
      });

      managedWorker.worker.postMessage({
        type: "send-message",
        requestId,
        payload
      });
    });
  }

  /**
   * Assina eventos de log em tempo real para SSE.
   */
  public subscribeLogs(tenantId: string, instanceId: string, listener: (event: InstanceLogEvent) => void): () => void {
    const key = buildWorkerKey(tenantId, instanceId);
    this.logEmitter.on(key, listener);
    return () => this.logEmitter.off(key, listener);
  }

  /**
   * Assina eventos de QR Code em tempo real para WebSocket.
   */
  public subscribeQr(tenantId: string, instanceId: string, listener: (event: QrCodeEvent) => void): () => void {
    const key = buildWorkerKey(tenantId, instanceId);
    this.qrEmitter.on(key, listener);
    return () => this.qrEmitter.off(key, listener);
  }

  /**
   * Retorna o ultimo QR gerado para a instancia, se existir.
   */
  public getLatestQr(tenantId: string, instanceId: string): QrCodeEvent | undefined {
    return this.latestQrCodes.get(buildWorkerKey(tenantId, instanceId));
  }

  /**
   * Encerra todos os workers ativos da API.
   */
  public async close(): Promise<void> {
    for (const workerKey of [...this.workers.keys()]) {
      const [tenantId, instanceId] = workerKey.split(":");
      await this.stopWorker(tenantId ?? "", instanceId ?? "", false);
    }
  }

  private resolveStoragePaths(tenantId: string, instanceId: string) {
    const baseDirectory = resolve(this.config.DATA_DIR, "sessions", tenantId, instanceId);

    return {
      baseDirectory,
      authDirectory: resolve(baseDirectory, "auth"),
      sessionDbPath: resolve(baseDirectory, "session.sqlite")
    };
  }

  private async spawnWorker(tenantId: string, instance: Instance & { usage?: InstanceUsage | null }): Promise<void> {
    const worker = new Worker(new URL("./baileys-session.worker.js", import.meta.url), {
      workerData: {
        instanceId: instance.id,
        tenantId,
        instanceName: instance.name,
        authDirectory: instance.authDirectory,
        sessionDbPath: instance.sessionDbPath,
        proxyUrl: instance.proxyUrl
      }
    });

    const workerKey = buildWorkerKey(tenantId, instance.id);
    const managedWorker: ManagedWorker = {
      worker,
      paused: false,
      currentStatus: "INITIALIZING",
      pendingRequests: new Map()
    };

    this.workers.set(workerKey, managedWorker);

    worker.on("message", (event: WorkerEvent) => {
      void this.handleWorkerEvent(tenantId, instance, managedWorker, event);
    });

    worker.on("error", async (error) => {
      this.emitLog(workerKey, {
        context: { error: error.message },
        instanceId: instance.id,
        level: "error",
        message: "Worker da instancia falhou",
        timestamp: new Date().toISOString()
      });

      const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
      await prisma.instance.update({
        where: { id: instance.id },
        data: {
          status: "DISCONNECTED",
          lastError: error.message
        }
      });
    });

    worker.on("exit", () => {
      const current = this.workers.get(workerKey);

      if (!current) {
        return;
      }

      for (const pending of current.pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new ApiError(503, "INSTANCE_WORKER_EXITED", "Worker da instancia encerrado"));
      }

      this.workers.delete(workerKey);
    });
  }

  private async stopWorker(tenantId: string, instanceId: string, paused: boolean): Promise<void> {
    const workerKey = buildWorkerKey(tenantId, instanceId);
    const managedWorker = this.workers.get(workerKey);

    if (!managedWorker) {
      return;
    }

    managedWorker.paused = paused;

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }

        finished = true;
        this.workers.delete(workerKey);
        resolve();
      };

      managedWorker.worker.once("exit", finish);
      managedWorker.worker.postMessage({
        type: paused ? "pause" : "shutdown"
      });

      setTimeout(() => {
        void managedWorker.worker.terminate().finally(finish);
      }, 5_000);
    });
  }

  private async handleWorkerEvent(
    tenantId: string,
    instance: Instance,
    managedWorker: ManagedWorker,
    event: WorkerEvent
  ): Promise<void> {
    const workerKey = buildWorkerKey(tenantId, instance.id);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);

    if (event.type === "rpc-result") {
      const pending = managedWorker.pendingRequests.get(event.requestId);

      if (pending) {
        clearTimeout(pending.timeout);
        managedWorker.pendingRequests.delete(event.requestId);
        pending.resolve(event.data);
      }

      return;
    }

    if (event.type === "rpc-error") {
      const pending = managedWorker.pendingRequests.get(event.requestId);

      if (pending) {
        clearTimeout(pending.timeout);
        managedWorker.pendingRequests.delete(event.requestId);
        pending.reject(new ApiError(500, "INSTANCE_RPC_ERROR", event.error.message));
      }

      return;
    }

    if (event.type === "log") {
      this.emitLog(workerKey, {
        context: event.context,
        instanceId: instance.id,
        level: event.level,
        message: event.message,
        timestamp: event.timestamp
      });
      return;
    }

    if (event.type === "qr") {
      const qrEvent: QrCodeEvent = {
        instanceId: instance.id,
        qrCodeBase64: event.qrCodeBase64,
        expiresInSeconds: event.expiresInSeconds
      };

      this.latestQrCodes.set(workerKey, qrEvent);
      this.qrEmitter.emit(workerKey, qrEvent);
      return;
    }

    if (event.type === "profile") {
      await prisma.instance.update({
        where: { id: instance.id },
        data: {
          phoneNumber: event.phoneNumber ? normalizePhoneNumber(event.phoneNumber) : undefined,
          avatarUrl: event.avatarUrl,
          lastActivityAt: new Date()
        }
      });

      return;
    }

    if (event.type === "inbound-message") {
      await this.handleInboundMessage(tenantId, instance, event);
      return;
    }

    if (event.type === "status") {
      managedWorker.currentStatus = event.status;
      this.metricsService.setInstanceStatus(instance.id, tenantId, event.status);

      const updated = await prisma.instance.update({
        where: { id: instance.id },
        data: {
          status: event.status,
          reconnectAttempts: event.reconnectAttempts ?? 0,
          lastError: event.lastError,
          connectedAt: event.status === "CONNECTED" ? new Date() : undefined,
          pausedAt: event.status === "PAUSED" ? new Date() : null,
          workerHeartbeatAt: new Date(),
          lastActivityAt: new Date()
        }
      });

      if (event.status === "CONNECTED") {
        await this.platformPrisma.tenant.update({
          where: {
            id: tenantId
          },
          data: {
            onboardingStep: "INSTANCE_CONNECTED"
          }
        });

        await this.webhookService.enqueueEvent({
          eventType: "instance.connected",
          instanceId: instance.id,
          payload: {
            instanceId: instance.id,
            status: updated.status
          },
          tenantId
        });
      }

      if (event.status === "DISCONNECTED" || event.status === "BANNED") {
        await this.webhookService.enqueueEvent({
          eventType: "instance.disconnected",
          instanceId: instance.id,
          payload: {
            instanceId: instance.id,
            lastError: event.lastError ?? null,
            reconnectAttempts: event.reconnectAttempts ?? 0,
            status: updated.status
          },
          tenantId
        });
      }
    }
  }

  private async handleInboundMessage(
    tenantId: string,
    instance: Instance,
    event: InboundMessageWorkerEvent
  ): Promise<void> {
    await this.tenantPrismaRegistry.ensureSchema(this.platformPrisma, tenantId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const remoteNumber = normalizePhoneNumber(event.remoteJid.split("@")[0] ?? "");
    const msgText = typeof event.payload.text === "string" ? event.payload.text.trim().toLowerCase() : "";

    if (msgText === "/reset") {
      await prisma.message.deleteMany({
        where: {
          instanceId: instance.id,
          remoteJid: event.remoteJid
        }
      });

      await this.sendAutomatedTextMessage(
        tenantId,
        instance.id,
        remoteNumber,
        event.remoteJid,
        "🔄 Conversa resetada!",
        {
          action: "reset",
          kind: "chatbot"
        }
      );

      return;
    }

    const contact = await prisma.contact.upsert({
      where: {
        instanceId_phoneNumber: {
          instanceId: instance.id,
          phoneNumber: remoteNumber
        }
      },
      update: {
        displayName: (event.payload.pushName as string | undefined) ?? undefined
      },
      create: {
        instanceId: instance.id,
        phoneNumber: remoteNumber,
        displayName: (event.payload.pushName as string | undefined) ?? null
      }
    });
    let clientMemory = await this.clientMemoryService.findByPhone(tenantId, contact.phoneNumber);

    try {
      await this.clientMemoryService.upsert(tenantId, contact.phoneNumber, {
        name: contact.displayName?.trim() || undefined,
        lastContactAt: new Date()
      });
    } catch (memoryError) {
      console.error("[memory] erro ao atualizar ultimo contato:", memoryError);
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        instanceId: instance.id,
        contactId: contact.id,
        status: {
          in: ["OPEN", "PENDING", "TRANSFERRED"]
        }
      }
    });

    const isFirstContact = !conversation;

    if (!conversation) {
      await prisma.conversation.create({
        data: {
          instanceId: instance.id,
          contactId: contact.id,
          lastMessageAt: new Date()
        }
      });
    } else {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date()
        }
      });
    }

    await prisma.message.create({
      data: {
        instanceId: instance.id,
        remoteJid: event.remoteJid,
        externalMessageId: event.externalMessageId,
        direction: "INBOUND",
        type: event.messageType,
        status: "DELIVERED",
        payload: event.payload as Prisma.InputJsonValue
      }
    });

    await prisma.instanceUsage.update({
      where: { instanceId: instance.id },
      data: {
        messagesReceived: {
          increment: 1
        }
      }
    });

    this.metricsService.messagesTotal.inc({
      direction: "INBOUND",
      instance_id: instance.id,
      status: "DELIVERED",
      tenant_id: tenantId,
      type: event.messageType
    });

    await this.webhookService.enqueueEvent({
      tenantId,
      instanceId: instance.id,
      eventType: "message.received",
      payload: {
        externalMessageId: event.externalMessageId ?? null,
        instanceId: instance.id,
        payload: event.payload,
        remoteJid: event.remoteJid,
        type: event.messageType
      }
    });

    if (contact.isBlacklisted) {
      return;
    }

    try {
      const inputText = typeof event.payload.text === "string" ? event.payload.text : null;
      const normalizedInputText = (inputText ?? "").normalize("NFKC").trim().toLowerCase();

      if (event.remoteJid.endsWith("@g.us")) {
        if (normalizedInputText === "conectar") {
          const leadsGroupName =
            typeof event.payload.pushName === "string" && event.payload.pushName.trim()
              ? event.payload.pushName.trim()
              : "Grupo sem nome";
          const chatbotConfig = await prisma.chatbotConfig.findUnique({
            where: {
              instanceId: instance.id
            }
          });

          if (chatbotConfig) {
            await prisma.chatbotConfig.update({
              where: {
                instanceId: instance.id
              },
              data: {
                leadsGroupJid: event.remoteJid,
                leadsGroupName
              }
            });
          } else {
            await prisma.chatbotConfig.create({
              data: {
                instanceId: instance.id,
                isEnabled: false,
                rules: [] as Prisma.InputJsonValue,
                aiSettings: {} as Prisma.InputJsonValue,
                leadsGroupJid: event.remoteJid,
                leadsGroupName
              }
            });
          }

          await this.sendAutomatedTextMessage(
            tenantId,
            instance.id,
            remoteNumber,
            event.remoteJid,
            "Grupo conectado com sucesso! Os resumos de leads serao enviados aqui.",
            {
              action: "leads_group_connected",
              kind: "chatbot"
            }
          );
        }

        return;
      }

      if (this.isFollowUpCandidateMessage(normalizedInputText)) {
        try {
          clientMemory = await this.clientMemoryService.upsert(tenantId, contact.phoneNumber, {
            status: "lead_frio",
            tags: ["follow_up"]
          });
        } catch (memoryError) {
          console.error("[memory] erro ao marcar lead para follow-up:", memoryError);
        }
      }

      const chatbotConfig = await prisma.chatbotConfig.findUnique({
        where: {
          instanceId: instance.id
        }
      });
      const chatbotResult = await this.chatbotService.evaluateInbound(tenantId, instance.id, {
        text: inputText,
        isFirstContact,
        contactName: contact.displayName,
        phoneNumber: contact.phoneNumber,
        remoteJid: event.remoteJid,
        clientContext: this.buildClientMemoryContext(clientMemory)
      });

      console.log("[leads] responseText:", chatbotResult?.responseText?.slice(0, 500));
      console.log("[leads] temResumo:", chatbotResult?.responseText?.includes("[RESUMO_LEAD]"));
      console.log("[leads] leadsPhone banco:", chatbotConfig?.leadsPhoneNumber ?? "NAO CONFIGURADO");

      if (!chatbotResult?.responseText) {
        return;
      }

      const responseText = chatbotResult.responseText;
      const resumoRegex = /\[RESUMO_LEAD\]([\s\S]*?)\[\/RESUMO_LEAD\]/;
      console.log("[leads] extraindo resumo...");
      const resumoMatch = responseText.match(resumoRegex);
      console.log("[leads] resumoMatch:", resumoMatch ? "encontrado" : "nao encontrado");
      const resumoLead = resumoMatch?.[1]?.trim() ?? null;
      const clientResponseText = responseText.replace(resumoRegex, "").trim();
      const automationMetadata = {
        action: chatbotResult.action,
        matchedRuleId: chatbotResult.matchedRuleId ?? null,
        matchedRuleName: chatbotResult.matchedRuleName ?? null
      };
      const parsedLeadSummary = resumoLead ? this.parseLeadSummary(resumoLead) : null;

      const fiadoEnabled = chatbotConfig?.fiadoEnabled ?? false;
      if (fiadoEnabled && inputText) {
        const fiadoRegex = /(\d+)\s+(.+?)\s+(?:por\s+)?(?:R\$\s*)?(\d+(?:[.,]\d{1,2})?)/i;
        const match = inputText.match(fiadoRegex);
        if (match) {
          const qty = parseInt(match[1]);
          const desc = `${qty}x ${match[2].trim()}`;
          const value = parseFloat(match[3].replace(",", "."));
          if (!isNaN(value) && value > 0) {
            try {
              const tab = await this.fiadoService.addItem(
                tenantId,
                instance.id,
                remoteNumber,
                contact.displayName ?? null,
                desc,
                value
              );
              const totalFormatted = tab.total.toFixed(2).replace(".", ",");
              await this.sendAutomatedTextMessage(
                tenantId,
                instance.id,
                remoteNumber,
                event.remoteJid,
                `✅ Adicionado: ${desc} — R$${value.toFixed(2).replace(".", ",")}\nSeu total: R$${totalFormatted}`,
                { action: "fiado_add", kind: "chatbot" }
              );

              const leadsPhone = chatbotConfig?.leadsPhoneNumber;
              const leadsEnabled2 = chatbotConfig?.leadsEnabled ?? true;
              if (leadsPhone && leadsEnabled2) {
                const name = contact.displayName ?? remoteNumber;
                await this.sendAutomatedTextMessage(
                  tenantId,
                  instance.id,
                  leadsPhone,
                  undefined,
                  `🧾 ${name} adicionou: ${desc} — R$${value.toFixed(2).replace(".", ",")}\nTotal atual: R$${totalFormatted}`,
                  { action: "fiado_notify", kind: "chatbot" }
                );
              }
              return;
            } catch (err) {
              console.error("[fiado] erro:", err);
            }
          }
        }
      }

      const leadsPhone = chatbotConfig?.leadsPhoneNumber;

      if (resumoLead) {
        console.log("[leads] conteudo:", resumoLead.slice(0, 100));
        console.log("[leads] leadsPhone para envio:", leadsPhone ?? "UNDEFINED");
      }

      const leadsEnabled = chatbotConfig?.leadsEnabled ?? true;
      const camposObrigatorios = [
        /Nome:\s*(?!não informado|nao informado|\(nome\))/i,
        /Contato:\s*\d{8,}/,
        /Horário agendado:\s*(?!não informado|nao informado)/i,
        /Serviço de interesse:\s*(?!não informado|nao informado)/i
      ];
      const resumoCompleto = camposObrigatorios.every((regex) => regex.test(resumoLead ?? ""));

      if (parsedLeadSummary) {
        try {
          clientMemory = await this.clientMemoryService.upsert(tenantId, contact.phoneNumber, {
            name: parsedLeadSummary.name ?? undefined,
            projectDescription: parsedLeadSummary.problemDescription ?? undefined,
            serviceInterest: parsedLeadSummary.serviceInterest ?? undefined,
            scheduledAt: parsedLeadSummary.scheduledAt,
            ...(resumoCompleto
              ? {
                  status: "lead_quente",
                  tags: ["follow_up"]
                }
              : {})
          });
        } catch (memoryError) {
          console.error("[memory] erro ao atualizar memoria pelo resumo:", memoryError);
        }
      }

      if (!resumoCompleto) {
        console.log("[leads] resumo incompleto, aguardando mais informações");
      } else {
        const resumoDedupeKey = `leads:sent:${instance.id}:${remoteNumber}:${Date.now().toString().slice(0, -3)}`;
        const jaEnviado = resumoLead ? await this.redis.get(resumoDedupeKey) : null;

        if (jaEnviado) {
          console.log("[leads] resumo duplicado ignorado para:", remoteNumber);
        } else if (leadsPhone && leadsEnabled && resumoLead) {
          console.log("[leads] tentando enviar para telefone configurado...");
          try {
            await this.sendAutomatedTextMessage(
              tenantId,
              instance.id,
              leadsPhone,
              `${leadsPhone}@s.whatsapp.net`,
              `🔔 Novo lead agendado:\n\n${resumoLead}`,
              {
                action: "lead_summary",
                kind: "chatbot"
              }
            );
            console.log("[leads] enviado com sucesso!");
            await this.redis.set(resumoDedupeKey, "1", "EX", 30);
          } catch (err) {
            console.error("[leads] erro ao enviar:", err);
          }
        } else if (resumoLead) {
          console.log("[leads] leadsPhone nao encontrado, nao enviou");
          this.emitLog(buildWorkerKey(tenantId, instance.id), {
            context: {
              instanceId: instance.id
            },
            instanceId: instance.id,
            level: "warn",
            message: "Resumo de lead gerado, mas leadsPhoneNumber não configurado ou leadsEnabled=false",
            timestamp: new Date().toISOString()
          });
        }
      }
      if (!clientResponseText.trim()) {
        return;
      }

      const delayLeitura = Math.floor(Math.random() * 1000) + 1500;
      await new Promise((resolve) => setTimeout(resolve, delayLeitura));

      if (clientResponseText.includes("|||")) {
        const responseParts = clientResponseText
          .split("|||")
          .map((part) => part.trim())
          .filter(Boolean);

        for (const responsePart of responseParts) {
          await this.sendAutomatedTextMessage(tenantId, instance.id, remoteNumber, event.remoteJid, responsePart, automationMetadata);
          const delayDigitacao = Math.floor(Math.random() * 1000) + 1500;
          await new Promise((resolve) => setTimeout(resolve, delayDigitacao));
        }
      } else {
        await this.sendAutomatedTextMessage(tenantId, instance.id, remoteNumber, event.remoteJid, clientResponseText, automationMetadata);
      }
    } catch (error) {
      this.emitLog(buildWorkerKey(tenantId, instance.id), {
        context: {
          error: error instanceof Error ? error.message : "unknown"
        },
        instanceId: instance.id,
        level: "warn",
        message: "Falha ao processar resposta automatica do chatbot",
        timestamp: new Date().toISOString()
      });
    }
  }

  private buildClientMemoryContext(clientMemory: ClientMemory | null): string {
    if (!clientMemory) {
      return "";
    }

    return [
      "CONTEXTO DO CLIENTE (use para personalizar o atendimento, mas nao mencione que tem esses dados):",
      `- Nome registrado: ${clientMemory.name ?? "nao informado"}`,
      `- E cliente existente: ${clientMemory.isExistingClient ? "SIM" : "NAO ou desconhecido"}`,
      `- Projeto anterior: ${clientMemory.projectDescription ?? "nenhum registrado"}`,
      `- Interesse anterior: ${clientMemory.serviceInterest ?? "nenhum registrado"}`,
      `- Status: ${clientMemory.status}`,
      `- Tags: ${clientMemory.tags.join(", ") || "nenhuma"}`,
      `- Observacoes: ${clientMemory.notes ?? "nenhuma"}`
    ].join("\n");
  }

  private isFollowUpCandidateMessage(input: string): boolean {
    if (!input) {
      return false;
    }

    return [
      /\b(?:nao|não)\s+(?:tenho\s+)?interesse\b/i,
      /\b(?:nao|não)\s+agora\b/i,
      /\bvou\s+pensar\b/i,
      /\bdepois\s+eu\s+(?:vejo|falo|retorno)\b/i,
      /\bte\s+aviso\b/i
    ].some((pattern) => pattern.test(input));
  }

  private parseLeadSummary(resumoLead: string): {
    name: string | null;
    contact: string | null;
    problemDescription: string | null;
    serviceInterest: string | null;
    scheduledAt: Date | null;
  } {
    const scheduledLabel = this.extractLeadField(resumoLead, /^Hor(?:Ã¡|á|a)rio agendado:\s*(.+)$/im);

    return {
      name: this.sanitizeLeadField(this.extractLeadField(resumoLead, /^Nome:\s*(.+)$/im)),
      contact: this.sanitizeLeadField(this.extractLeadField(resumoLead, /^Contato:\s*(.+)$/im)),
      problemDescription: this.sanitizeLeadField(this.extractLeadField(resumoLead, /^Problema:\s*(.+)$/im)),
      serviceInterest: this.sanitizeLeadField(this.extractLeadField(resumoLead, /^Servi(?:Ã§|ç|c)o de interesse:\s*(.+)$/im)),
      scheduledAt: this.parseLeadScheduledAt(scheduledLabel)
    };
  }

  private extractLeadField(summary: string, pattern: RegExp): string | null {
    return summary.match(pattern)?.[1]?.trim() ?? null;
  }

  private sanitizeLeadField(value: string | null): string | null {
    if (!value) {
      return null;
    }

    const normalized = value.normalize("NFKC").trim();

    if (!normalized) {
      return null;
    }

    if (
      ["nao informado", "não informado", "(nome)", "(número)", "(numero)", "(celular)"].includes(
        normalized.toLowerCase()
      )
    ) {
      return null;
    }

    return normalized;
  }

  private parseLeadScheduledAt(value: string | null): Date | null {
    const sanitized = this.sanitizeLeadField(value);

    if (!sanitized) {
      return null;
    }

    const directDate = new Date(sanitized);

    if (!Number.isNaN(directDate.getTime())) {
      return directDate;
    }

    const match = sanitized.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?:\s*(?:as|às)?\s*(\d{1,2})(?::|h)?(\d{2})?)?/i);

    if (!match) {
      return null;
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const hour = match[4] ? Number(match[4]) : 0;
    const minute = match[5] ? Number(match[5]) : 0;
    const parsed = new Date(year, month - 1, day, hour, minute);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private async sendAutomatedTextMessage(
    tenantId: string,
    instanceId: string,
    remoteNumber: string,
    targetJid: string | undefined,
    text: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.planEnforcementService.assertCanSendMessage(tenantId);
    const tenant = await this.platformPrisma.tenant.findUnique({
      where: {
        id: tenantId
      }
    });

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    await this.enforceAutomatedRateLimit(instanceId, tenantId, tenant.rateLimitPerMinute);
    const payload: SendMessagePayload = {
      type: "text",
      to: remoteNumber,
      targetJid,
      text
    };
    console.log("[sendAutomatedTextMessage] payload final:", JSON.stringify(payload));
    const rpcResult = await this.sendMessage(tenantId, instanceId, payload);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const created = await prisma.message.create({
      data: {
        instanceId,
        remoteJid: (rpcResult.remoteJid as string | undefined) ?? targetJid ?? toJid(remoteNumber),
        externalMessageId: (rpcResult.externalMessageId as string | undefined) ?? null,
        direction: "OUTBOUND",
        type: "text",
        status: "SENT",
        payload: {
          ...payload,
          automation: {
            kind: "chatbot",
            ...metadata
          }
        } as Prisma.InputJsonValue,
        traceId: crypto.randomUUID(),
        sentAt: new Date()
      }
    });

    await prisma.instanceUsage.update({
      where: { instanceId },
      data: {
        messagesSent: {
          increment: 1
        }
      }
    });

    await this.platformPrisma.tenant.update({
      where: { id: tenantId },
      data: {
        messagesThisMonth: {
          increment: 1
        }
      }
    });

    this.metricsService.messagesTotal.inc({
      direction: "OUTBOUND",
      instance_id: instanceId,
      status: "SENT",
      tenant_id: tenantId,
      type: "text"
    });

    await this.webhookService.enqueueEvent({
      tenantId,
      instanceId,
      eventType: "message.sent",
      payload: {
        externalMessageId: (rpcResult.externalMessageId as string | undefined) ?? null,
        instanceId,
        messageId: created.id,
        status: created.status,
        traceId: created.traceId,
        type: created.type
      }
    });
  }

  private async enforceAutomatedRateLimit(instanceId: string, tenantId: string, limitPerMinute: number): Promise<void> {
    const now = new Date();
    const bucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
    const key = `rate:auto:${tenantId}:${instanceId}:${bucket}`;
    const current = await this.redis.incr(key);

    if (current === 1) {
      await this.redis.expire(key, 60);
    }

    if (current > limitPerMinute) {
      throw new ApiError(429, "INSTANCE_RATE_LIMIT_EXCEEDED", "Limite de mensagens por minuto excedido", {
        current,
        limitPerMinute
      });
    }
  }

  private async requireInstanceWithUsage(tenantId: string, instanceId: string) {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instance = await prisma.instance.findFirst({
      where: {
        id: instanceId
      },
      include: {
        usage: true
      }
    });

    if (!instance) {
      throw new ApiError(404, "INSTANCE_NOT_FOUND", "Instancia nao encontrada");
    }

    return instance;
  }

  private mapInstanceSummary(tenantId: string, instance: Instance & { usage?: InstanceUsage | null }): InstanceSummary {
    return {
      id: instance.id,
      tenantId,
      name: instance.name,
      phoneNumber: instance.phoneNumber,
      avatarUrl: instance.avatarUrl,
      status: instance.status as InstanceSummary["status"],
      lastActivityAt: instance.lastActivityAt?.toISOString() ?? null,
      lastError: instance.lastError ?? null,
      connectedAt: instance.connectedAt?.toISOString() ?? null,
      createdAt: instance.createdAt.toISOString(),
      updatedAt: instance.updatedAt.toISOString(),
      usage: {
        instanceId: instance.id,
        messagesSent: instance.usage?.messagesSent ?? 0,
        messagesReceived: instance.usage?.messagesReceived ?? 0,
        errors: instance.usage?.errors ?? 0,
        uptimeSeconds: instance.usage?.uptimeSeconds ?? 0,
        riskScore: instance.riskScore
      }
    };
  }

  private emitLog(key: string, event: InstanceLogEvent): void {
    this.logEmitter.emit(key, event);
  }
}
