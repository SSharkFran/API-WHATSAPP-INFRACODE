import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  ClientMemoryTag,
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
import { normalizePhoneNumber, normalizeWhatsAppPhoneNumber, toJid } from "../../lib/phone.js";
import { ConversationAgent } from "../chatbot/agents/conversation.agent.js";
import { FiadoAgent } from "../chatbot/agents/fiado.agent.js";
import { MemoryAgent } from "../chatbot/agents/memory.agent.js";
import { AdminMemoryService } from "../chatbot/admin-memory.service.js";
import type { ChatMessage, ConversationSession, LeadData } from "../chatbot/agents/types.js";
import type { ClientMemoryService } from "../chatbot/memory.service.js";
import type { ChatbotService } from "../chatbot/service.js";
import type { PlanEnforcementService } from "../platform/plan-enforcement.service.js";
import type { WebhookService } from "../webhooks/service.js";
import type { FiadoService } from "../chatbot/fiado.service.js";
import type { PlatformAlertService } from "../platform/alert.service.js";

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
  adminMemoryService: AdminMemoryService;
  fiadoService: FiadoService;
  platformAlertService?: PlatformAlertService;
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
  rawMessage?: Record<string, unknown>;
  messageKey?: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
  };
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

interface PhoneNumberShareWorkerEvent {
  type: "phone-number-share";
  lid: string;
  jid: string;
}

type WorkerEvent =
  | StatusWorkerEvent
  | LogWorkerEvent
  | QrWorkerEvent
  | ProfileWorkerEvent
  | InboundMessageWorkerEvent
  | PhoneNumberShareWorkerEvent
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
const leadExtractionAwaitingTimeoutMs = 120_000;
const formatCurrencyValue = (value: number): string =>
  new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);

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
  private readonly clientMemoryService: ClientMemoryService;
  private readonly adminMemoryService: AdminMemoryService;
  private readonly chatbotService: ChatbotService;
  private readonly memoryAgent: MemoryAgent;
  private readonly conversationAgent: ConversationAgent;
  private readonly fiadoAgent: FiadoAgent;
  private readonly platformAlertService?: PlatformAlertService;
  private readonly logEmitter = new EventEmitter();
  private readonly qrEmitter = new EventEmitter();
  private readonly latestQrCodes = new Map<string, QrCodeEvent>();
  private readonly conversationSessions = new Map<string, ConversationSession>();
  private readonly workers = new Map<string, ManagedWorker>();

  public constructor(deps: InstanceOrchestratorDeps) {
    this.config = deps.config;
    this.metricsService = deps.metricsService;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.redis = deps.redis;
    this.webhookService = deps.webhookService;
    this.planEnforcementService = deps.planEnforcementService;
    this.clientMemoryService = deps.clientMemoryService;
    this.adminMemoryService = deps.adminMemoryService;
    this.chatbotService = deps.chatbotService;
    this.memoryAgent = new MemoryAgent({
      clientMemoryService: deps.clientMemoryService
    });
    this.conversationAgent = new ConversationAgent({
      chatbotService: deps.chatbotService
    });
    this.fiadoAgent = new FiadoAgent({
      fiadoService: deps.fiadoService
    });
    this.platformAlertService = deps.platformAlertService;
  }

  public setPlatformAlertService(service: PlatformAlertService): void {
    (this as unknown as { platformAlertService: PlatformAlertService }).platformAlertService = service;
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

  private async callWorkerRpc(
    tenantId: string,
    instanceId: string,
    commandType: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const workerKey = buildWorkerKey(tenantId, instanceId);
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
        type: commandType,
        requestId,
        ...payload
      });
    });
  }

  private async downloadMediaFromWorker(
    tenantId: string,
    instanceId: string,
    rawMessage: Record<string, unknown>,
    messageKey: { remoteJid?: string | null; id?: string | null }
  ): Promise<{ buffer: string; mimeType: string | null } | null> {
    try {
      const result = await this.callWorkerRpc(tenantId, instanceId, "download-media", {
        rawMessage,
        messageKey
      }) as { buffer: string; mimeType: string | null };
      return result;
    } catch (err) {
      console.error("[worker] erro ao baixar midia do worker:", err);
      return null;
    }
  }

  private async transcribeAudio(
    tenantId: string,
    instanceId: string,
    rawMessage: Record<string, unknown>,
    messageKey: { remoteJid?: string | null; id?: string | null }
  ): Promise<string | null> {
    const media = await this.downloadMediaFromWorker(tenantId, instanceId, rawMessage, messageKey);
    if (!media) return null;

    const buffer = Buffer.from(media.buffer, "base64");
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: media.mimeType ?? "audio/ogg" }), "audio.ogg");
    formData.append("model", "whisper-large-v3");
    formData.append("language", "pt");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.GROQ_API_KEY}`
      },
      body: formData
    });

    if (!response.ok) {
      console.error("[audio] Groq Whisper error:", await response.text());
      return null;
    }

    const data = (await response.json()) as { text: string };
    return data.text?.trim() ?? null;
  }

  private async analyzeImage(
    tenantId: string,
    instanceId: string,
    rawMessage: Record<string, unknown>,
    messageKey: { remoteJid?: string | null; id?: string | null },
    caption: string,
    visionPrompt?: string | null
  ): Promise<string | null> {
    const media = await this.downloadMediaFromWorker(tenantId, instanceId, rawMessage, messageKey);
    if (!media) return null;

    const base64Image = media.buffer;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.config.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: "image/jpeg",
                    data: base64Image
                  }
                },
                {
                  text: [
                    visionPrompt ??
                      "Descreva o que voce ve nesta imagem em portugues de forma concisa, focando em informacoes relevantes para o atendimento.",
                    caption ? `O cliente legendou a imagem com: "${caption}"` : null
                  ].filter(Boolean).join(" ")
                }
              ]
            }
          ],
          generationConfig: {
            maxOutputTokens: 300
          }
        })
      }
    );

    if (!response.ok) return null;
    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
          }>;
        };
      }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
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

    if (event.type === "phone-number-share") {
      await this.handlePhoneNumberShareEvent(prisma, instance.id, event);
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

        this.platformAlertService?.alertInstanceUp(tenantId, instance.id, instance.name).catch((err) => {
          console.error("[orchestrator] erro ao alertar reconexao:", err);
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

        this.platformAlertService?.alertInstanceDown(tenantId, instance.id, instance.name).catch((err) => {
          console.error("[orchestrator] erro ao alertar queda:", err);
        });
      }
    }
  }

  private async handlePhoneNumberShareEvent(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    instanceId: string,
    event: PhoneNumberShareWorkerEvent
  ): Promise<void> {
    const sharedPhoneNumber = normalizeWhatsAppPhoneNumber(event.jid);

    if (!sharedPhoneNumber) {
      return;
    }

    const lidDigits = normalizePhoneNumber(event.lid.split("@")[0] ?? event.lid);
    const contactByLid = await prisma.contact.findFirst({
      where: {
        instanceId,
        OR: [
          {
            fields: {
              path: ["lastRemoteJid"],
              equals: event.lid
            }
          },
          {
            phoneNumber: lidDigits
          }
        ]
      }
    });

    if (!contactByLid) {
      return;
    }

    const sharedPhoneContact = await prisma.contact.findUnique({
      where: {
        instanceId_phoneNumber: {
          instanceId,
          phoneNumber: sharedPhoneNumber
        }
      }
    });

    const lidFields =
      contactByLid.fields && typeof contactByLid.fields === "object"
        ? (contactByLid.fields as Record<string, unknown>)
        : {};

    if (sharedPhoneContact && sharedPhoneContact.id !== contactByLid.id) {
      const sharedPhoneFields =
        sharedPhoneContact.fields && typeof sharedPhoneContact.fields === "object"
          ? (sharedPhoneContact.fields as Record<string, unknown>)
          : {};

      await prisma.$transaction([
        prisma.contact.update({
          where: {
            id: sharedPhoneContact.id
          },
          data: {
            displayName: sharedPhoneContact.displayName ?? contactByLid.displayName ?? undefined,
            fields: {
              ...lidFields,
              ...sharedPhoneFields,
              lastRemoteJid: event.lid,
              sharedPhoneJid: event.jid
            } as Prisma.InputJsonValue
          }
        }),
        prisma.conversation.updateMany({
          where: {
            instanceId,
            contactId: contactByLid.id
          },
          data: {
            contactId: sharedPhoneContact.id
          }
        }),
        prisma.contact.delete({
          where: {
            id: contactByLid.id
          }
        })
      ]);

      return;
    }

    await prisma.contact.update({
      where: {
        id: contactByLid.id
      },
      data: {
        phoneNumber: sharedPhoneNumber,
        fields: {
          ...lidFields,
          lastRemoteJid: event.lid,
          sharedPhoneJid: event.jid
        } as Prisma.InputJsonValue
      }
    });
  }

  private async handleInboundMessage(
    tenantId: string,
    instance: Instance,
    event: InboundMessageWorkerEvent
  ): Promise<void> {
    await this.tenantPrismaRegistry.ensureSchema(this.platformPrisma, tenantId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const remotePhoneFromJid = normalizeWhatsAppPhoneNumber(event.remoteJid);
    const realPhoneFromRemoteJid = /@(s\.whatsapp\.net|c\.us)$/i.test(event.remoteJid)
      ? event.remoteJid.replace(/@.*$/, "").replace(/\D/g, "")
      : null;
    const remoteNumber = remotePhoneFromJid ?? normalizePhoneNumber(event.remoteJid.split("@")[0] ?? "");
    const sessionKey = this.buildConversationSessionKey(instance.id, event.remoteJid);
    const msgText = typeof event.payload.text === "string" ? event.payload.text.trim().toLowerCase() : "";

    if (msgText === "/reset") {
      const resetContact = await prisma.contact.findFirst({
        where: {
          instanceId: instance.id,
          OR: [
            {
              fields: {
                path: ["lastRemoteJid"],
                equals: event.remoteJid
              }
            },
            {
              phoneNumber: remoteNumber
            }
          ]
        },
        select: {
          id: true
        }
      });
      const resetConversation = resetContact
        ? await prisma.conversation.findFirst({
            where: {
              instanceId: instance.id,
              contactId: resetContact.id,
              status: {
                in: ["OPEN", "PENDING", "TRANSFERRED"]
              }
            },
            select: {
              id: true
            }
          })
        : null;

      if (resetConversation) {
        await prisma.conversation.update({
          where: {
            id: resetConversation.id
          },
          data: {
            awaitingLeadExtraction: false,
            leadSent: false
          } as Prisma.ConversationUncheckedUpdateInput
        });
        console.log("[lead] awaitingLeadExtraction reset para conversa:", resetConversation.id);
      }

      await prisma.message.deleteMany({
        where: {
          instanceId: instance.id,
          remoteJid: event.remoteJid
        }
      });
      this.conversationSessions.delete(sessionKey);

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

    const existingContactByRemoteJid = await prisma.contact.findFirst({
      where: {
        instanceId: instance.id,
        fields: {
          path: ["lastRemoteJid"],
          equals: event.remoteJid
        }
      }
    });
    const existingContactFields =
      existingContactByRemoteJid?.fields && typeof existingContactByRemoteJid.fields === "object"
        ? (existingContactByRemoteJid.fields as Record<string, unknown>)
        : null;
    const sharedPhoneNumber = normalizeWhatsAppPhoneNumber(
      typeof existingContactFields?.sharedPhoneJid === "string" ? existingContactFields.sharedPhoneJid : null
    );
    const storedContactPhoneNumber =
      sharedPhoneNumber ??
      realPhoneFromRemoteJid ??
      existingContactByRemoteJid?.phoneNumber ??
      remoteNumber;
    const existingContactByPhoneNumber =
      existingContactByRemoteJid ??
      (await prisma.contact.findUnique({
        where: {
          instanceId_phoneNumber: {
            instanceId: instance.id,
            phoneNumber: storedContactPhoneNumber
          }
        }
      }));
    const nextContactFields = {
      ...(existingContactByPhoneNumber?.fields && typeof existingContactByPhoneNumber.fields === "object"
        ? (existingContactByPhoneNumber.fields as Record<string, unknown>)
        : {}),
      lastRemoteJid: event.remoteJid,
      ...(realPhoneFromRemoteJid ? { sharedPhoneJid: event.remoteJid } : {})
    } as Prisma.InputJsonValue;
    const contact = await prisma.contact.upsert({
      where: {
        instanceId_phoneNumber: {
          instanceId: instance.id,
          phoneNumber: storedContactPhoneNumber
        }
      },
      update: {
        displayName: (event.payload.pushName as string | undefined) ?? undefined,
        fields: nextContactFields
      },
      create: {
        instanceId: instance.id,
        phoneNumber: storedContactPhoneNumber,
        displayName: (event.payload.pushName as string | undefined) ?? null,
        fields: nextContactFields
      }
    });
    const contactFields =
      contact.fields && typeof contact.fields === "object"
        ? (contact.fields as Record<string, unknown>)
        : null;
    const resolvedContactNumber =
      normalizeWhatsAppPhoneNumber(
        typeof contactFields?.sharedPhoneJid === "string" ? contactFields.sharedPhoneJid : null
      ) ??
      realPhoneFromRemoteJid ??
      normalizeWhatsAppPhoneNumber(contact.phoneNumber) ??
      remotePhoneFromJid ??
      contact.phoneNumber ??
      remoteNumber;

    const conversation = await prisma.conversation.findFirst({
      where: {
        instanceId: instance.id,
        contactId: contact.id,
        status: {
          in: ["OPEN", "PENDING", "TRANSFERRED"]
        }
      },
      select: {
        id: true,
        leadSent: true,
        awaitingLeadExtraction: true,
        updatedAt: true
      }
    });

    const isFirstContact = !conversation;
    let resolvedConversation = conversation;

    if (
      resolvedConversation?.awaitingLeadExtraction &&
      !resolvedConversation.leadSent &&
      Date.now() - resolvedConversation.updatedAt.getTime() > leadExtractionAwaitingTimeoutMs
    ) {
      resolvedConversation = await prisma.conversation.update({
        where: {
          id: resolvedConversation.id
        },
        data: {
          awaitingLeadExtraction: false
        } as Prisma.ConversationUncheckedUpdateInput,
        select: {
          id: true,
          leadSent: true,
          awaitingLeadExtraction: true,
          updatedAt: true
        }
      });
      console.log("[lead] awaitingLeadExtraction reset para conversa:", resolvedConversation.id);
    }

    const activeConversation = !resolvedConversation
      ? await prisma.conversation.create({
          data: {
            instanceId: instance.id,
            contactId: contact.id,
            lastMessageAt: new Date(),
            awaitingLeadExtraction: false
          },
          select: {
            id: true,
            leadSent: true,
            awaitingLeadExtraction: true,
            updatedAt: true
          }
        })
      : resolvedConversation.awaitingLeadExtraction
        ? resolvedConversation
        : await prisma.conversation.update({
          where: { id: resolvedConversation.id },
          data: {
            lastMessageAt: new Date()
          },
          select: {
            id: true,
            leadSent: true,
            awaitingLeadExtraction: true,
            updatedAt: true
          }
        });

    if (isFirstContact) {
      this.conversationSessions.delete(sessionKey);
    }

    const session = await this.getConversationSession(
      prisma,
      sessionKey,
      instance.id,
      event.remoteJid,
      activeConversation.leadSent,
      !isFirstContact
    );

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
      const inputText = typeof event.payload.text === "string" ? event.payload.text.trim() : "";

      let finalInputText = inputText;

      const rawMessage = event.rawMessage;
      const messageKey = event.messageKey ?? { remoteJid: event.remoteJid };

      const chatbotConfig = await prisma.chatbotConfig.findUnique({
        where: {
          instanceId: instance.id
        }
      });

      const audioMsg = rawMessage?.audioMessage ?? rawMessage?.pttMessage;
      if (audioMsg && (chatbotConfig?.audioEnabled ?? false)) {
        console.log("[audio] mensagem de audio detectada, transcrevendo...");
        try {
          const transcript = await this.transcribeAudio(
            tenantId,
            instance.id,
            rawMessage ?? {},
            messageKey
          );
          if (transcript) {
            console.log("[audio] transcricao:", transcript.slice(0, 100));
            finalInputText = transcript;
          }
        } catch (err) {
          console.error("[audio] erro na transcricao:", err);
        }
      }

      const imageMsg = rawMessage?.imageMessage;
      if (imageMsg && (chatbotConfig?.visionEnabled ?? false)) {
        console.log("[vision] imagem detectada, analisando...");
        try {
          const caption = (imageMsg as { caption?: string })?.caption ?? "";
          const visionResult = await this.analyzeImage(
            tenantId,
            instance.id,
            rawMessage ?? {},
            messageKey,
            caption,
            chatbotConfig?.visionPrompt
          );
          if (visionResult) {
            await prisma.message.create({
              data: {
                instanceId: instance.id,
                remoteJid: event.remoteJid,
                direction: "SYSTEM",
                type: "SYSTEM",
                status: "DELIVERED",
                payload: {
                  text: `[Análise de imagem do veículo]: ${visionResult}`
                } as Prisma.InputJsonValue
              }
            });
            finalInputText = `[O cliente enviou uma imagem. Analise: ${visionResult}]${caption ? ` Legenda: ${caption}` : ""}`;
          }
        } catch (err) {
          console.error("[vision] erro na analise:", err);
        }
      }

      const finalNormalizedInputText = finalInputText.normalize("NFKC").trim().toLowerCase();

      if (event.remoteJid.endsWith("@g.us")) {
        if (finalNormalizedInputText === "conectar") {
          const leadsGroupName =
            typeof event.payload.pushName === "string" && event.payload.pushName.trim()
              ? event.payload.pushName.trim()
              : "Grupo sem nome";

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

      if (activeConversation.awaitingLeadExtraction) {
        return;
      }

      const clientMemory = await this.clientMemoryService.findByPhone(tenantId, resolvedContactNumber);
      const platformConfig = await this.platformPrisma.platformConfig.findUnique({
        where: { id: "singleton" }
      });
      const adminPhone = platformConfig?.adminAlertPhone ?? null;

      if (
        finalInputText &&
        adminPhone &&
        await this.adminMemoryService.handleAdminMessage(
          instance.id,
          tenantId,
          adminPhone,
          resolvedContactNumber,
          finalInputText
        )
      ) {
        return;
      }

      if (clientMemory?.tags.includes("paused_by_human")) {
        return;
      }

      const { contextString } = await this.memoryAgent.getContext({
        tenantId,
        phoneNumber: resolvedContactNumber
      });

      if (!finalInputText) {
        if (imageMsg && (chatbotConfig?.visionEnabled ?? false)) {
          finalInputText = "[O cliente enviou uma imagem. Aguardando análise.]";
        } else {
          return;
        }
      }

      this.appendConversationHistory(session, "user", finalInputText);

      const fiadoResponse = await this.fiadoAgent.process({
        message: finalInputText,
        phoneNumber: resolvedContactNumber,
        tenantId,
        instanceId: instance.id,
        displayName: contact.displayName ?? null,
        fiadoEnabled: chatbotConfig?.fiadoEnabled ?? false
      });

      if (fiadoResponse) {
        await this.memoryAgent.update({
          tenantId,
          phoneNumber: resolvedContactNumber,
          clientMessage: finalInputText
        });
        await this.sendConversationWithDelay({
          tenantId,
          instanceId: instance.id,
          remoteNumber: resolvedContactNumber,
          targetJid: event.remoteJid,
          text: fiadoResponse,
          metadata: {
            action: "fiado_agent",
            kind: "chatbot"
          },
          session
        });
        return;
      }

      const chatbotResult = await this.conversationAgent.reply({
        tenantId,
        instanceId: instance.id,
        message: finalInputText,
        history: session.history,
        clientContext: contextString,
        isFirstContact,
        contactName: undefined,
        phoneNumber: contact.phoneNumber ?? remoteNumber,
        remoteJid: event.remoteJid
      });

      if (chatbotResult?.action === "HUMAN_HANDOFF") {
        await this.clientMemoryService.upsert(tenantId, resolvedContactNumber, {
          lastContactAt: new Date(),
          tags: [...new Set<ClientMemoryTag>([...(clientMemory?.tags ?? []), "paused_by_human"])]
        });

        if (adminPhone) {
          await this.sendMessage(tenantId, instance.id, {
            type: "text",
            to: adminPhone,
            text: `Transbordo humano solicitado pelo cliente ${resolvedContactNumber}. O bot foi pausado para este contato.`
          });
        }
        return;
      }

      const rawResponse = chatbotResult?.responseText ?? null;

      if (!rawResponse) {
        await this.memoryAgent.update({
          tenantId,
          phoneNumber: resolvedContactNumber,
          clientMessage: finalInputText
        });
        return;
      }

      const resumoMatch = rawResponse.match(/\[RESUMO_LEAD\][\s\S]*?\[\/RESUMO_LEAD\]/);
      const resumoLead = resumoMatch ? resumoMatch[0] : null;

      const clientText = rawResponse.replace(/\[RESUMO_LEAD\][\s\S]*?\[\/RESUMO_LEAD\]/, "").trim();

      console.log("[chatbot] rawResponse:", rawResponse.slice(0, 300));
      console.log("[chatbot] resumoDetectado:", !!resumoLead);
      console.log("[chatbot] clientText:", clientText.slice(0, 300));

      let leadData: LeadData | null = null;

      if (resumoLead) {
        const leadsPhone = chatbotConfig?.leadsPhoneNumber;
        const leadsEnabled = chatbotConfig?.leadsEnabled ?? true;

        const camposObrigatorios = [
          /Nome:\s*(?!não informado|nao informado|\(nome\))/i,
          /Serviço de interesse:\s*(?!não informado|nao informado)/i
        ];
        const camposOk = camposObrigatorios.every((r) => r.test(resumoLead));

        if (camposOk) {
          const nomeMatch = resumoLead.match(/Nome:\s*(.+)/i);
          const contatoMatch = resumoLead.match(/Contato:\s*(.+)/i);
          const emailMatch = resumoLead.match(/E-mail:\s*(.+)/i);
          const empresaMatch = resumoLead.match(/Empresa:\s*(.+)/i);
          const problemaMatch = resumoLead.match(/Problema:\s*(.+)/i);
          const servicoMatch = resumoLead.match(/Serviço de interesse:\s*(.+)/i);
          const horarioMatch = resumoLead.match(/Horário agendado:\s*(.+)/i);

          leadData = {
            rawSummary: resumoLead,
            name: nomeMatch ? nomeMatch[1].trim() : null,
            contact: contatoMatch ? contatoMatch[1].trim() : remoteNumber,
            email: emailMatch ? emailMatch[1].trim() : null,
            companyName: empresaMatch ? empresaMatch[1].trim() : null,
            problemDescription: problemaMatch ? problemaMatch[1].trim() : null,
            serviceInterest: servicoMatch ? servicoMatch[1].trim() : null,
            scheduledText: horarioMatch ? horarioMatch[1].trim() : null,
            scheduledAt: null,
            isComplete: true
          };
        }

        if (leadData?.isComplete && leadsPhone && leadsEnabled) {
          const hashInput = [
            leadData?.name ?? "",
            leadData?.serviceInterest ?? "",
            resolvedContactNumber
          ].join("|");
          const hash = Buffer.from(hashInput).toString("base64").slice(0, 32);
          const dedupeKey = `leads:dedup:${instance.id}:${remoteNumber}:${hash}`;
          const jaEnviado = await this.redis.get(dedupeKey).catch(() => null);

          if (!jaEnviado) {
            await this.redis.set(dedupeKey, "1", "EX", 86400);
            const leadsJid = `${leadsPhone}@s.whatsapp.net`;
            await this.sendAutomatedTextMessage(
              tenantId,
              instance.id,
              leadsPhone,
              leadsJid,
              `🔔 Novo lead agendado:\n\n${resumoLead}`,
              { action: "lead_summary", kind: "chatbot" }
            );

            const summaryAlertSent =
              (await this.platformAlertService?.alertNewLead(
                tenantId,
                instance.name,
                resumoLead,
                resolvedContactNumber
              ).catch((err) => {
                console.error("[orchestrator] erro ao alertar novo lead:", err);
                return false;
              })) ?? false;

            if (summaryAlertSent) {
              await this.markConversationLeadSent(prisma, activeConversation.id, session);
            }
          } else {
            console.log("[leads] resumo duplicado ignorado");
          }
        } else if (!leadData?.isComplete) {
          console.log("[leads] resumo incompleto, nao enviado:", resumoLead.slice(0, 100));
        }
      }

      await this.memoryAgent.update({
        tenantId,
        phoneNumber: resolvedContactNumber,
        clientMessage: finalInputText,
        leadData
      });

      if (leadData?.isComplete && (!chatbotConfig?.leadsPhoneNumber || chatbotConfig.leadsEnabled === false)) {
        this.emitLog(buildWorkerKey(tenantId, instance.id), {
          context: {
            instanceId: instance.id
          },
          instanceId: instance.id,
          level: "warn",
          message: "Resumo de lead gerado, mas leadsPhoneNumber nao configurado ou leadsEnabled=false",
          timestamp: new Date().toISOString()
        });
      }

      if (!clientText.trim()) {
        return;
      }

      const delayLeitura = Math.floor(Math.random() * 1000) + 1500;
      await new Promise((resolve) => setTimeout(resolve, delayLeitura));

      if (clientText.includes("|||")) {
        const partes = clientText.split("|||").map((p) => p.trim()).filter(Boolean);
        for (const parte of partes) {
          await this.sendAutomatedTextMessage(
            tenantId,
            instance.id,
            remoteNumber,
            event.remoteJid,
            parte,
            { action: "conversation_agent", kind: "chatbot" }
          );
          this.appendConversationHistory(session, "assistant", parte);
          const delayDigitacao = Math.floor(Math.random() * 1000) + 1500;
          await new Promise((resolve) => setTimeout(resolve, delayDigitacao));
        }
      } else {
        await this.sendAutomatedTextMessage(
          tenantId,
          instance.id,
          remoteNumber,
          event.remoteJid,
          clientText,
          { action: "conversation_agent", kind: "chatbot" }
        );
        this.appendConversationHistory(session, "assistant", clientText);
      }

      const leadAutoExtractValue = chatbotConfig?.leadAutoExtract as unknown;
      const leadAutoExtractEnabled = leadAutoExtractValue === true || leadAutoExtractValue === "true";
      const responseText = clientText.replace(/\|\|\|/g, " ");
      const isClosing = /consultor|agendamento|em instantes|encaminhei|entrar.{0,20}contato/i.test(responseText ?? "");

      if (leadAutoExtractEnabled && isClosing && !session.leadAlreadySent && !activeConversation.awaitingLeadExtraction) {
        await prisma.conversation.update({
          where: {
            id: activeConversation.id
          },
          data: {
            awaitingLeadExtraction: true
          } as Prisma.ConversationUncheckedUpdateInput
        });

        void (async () => {
          try {
            const resolvedChatbotConfig = await this.chatbotService.getConfig(tenantId, instance.id);
            const senderPhoneSource =
              (typeof contactFields?.sharedPhoneJid === "string" && contactFields.sharedPhoneJid) ||
              realPhoneFromRemoteJid ||
              contact.phoneNumber ||
              event.remoteJid;
            console.log("[lead:phone] source variable:", JSON.stringify(senderPhoneSource));
            const senderPhone =
              String(senderPhoneSource ?? "")
                .replace(/@s\.whatsapp\.net$/i, "")
                .replace(/@c\.us$/i, "")
                .replace(/@.*$/, "")
                .replace(/\D/g, "") || resolvedContactNumber;
            console.log("[lead:phone] passing to processLead:", JSON.stringify(senderPhone));
            await this.chatbotService.processLeadAfterConversation(
              activeConversation.id,
              {
                ...resolvedChatbotConfig,
                __tenantId: tenantId
              },
              senderPhone
            );
          } catch (error) {
            console.error("[lead] erro na extração:", error);
            await prisma.conversation.update({
              where: {
                id: activeConversation.id
              },
              data: {
                awaitingLeadExtraction: false
              } as Prisma.ConversationUncheckedUpdateInput
            });
          }
        })();
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

      this.platformAlertService?.alertCriticalError(
        tenantId,
        instance.id,
        error instanceof Error ? error.message : "Erro desconhecido no chatbot"
      ).catch((err) => {
        console.error("[orchestrator] erro ao alertar erro critico:", err);
      });
    }
  }

  private buildConversationSessionKey(instanceId: string, remoteJid: string): string {
    return `${instanceId}:${remoteJid}`;
  }

  private async getConversationSession(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    sessionKey: string,
    instanceId: string,
    remoteJid: string,
    leadAlreadySent: boolean,
    loadStoredHistory = true
  ): Promise<ConversationSession> {
    const existingSession = this.conversationSessions.get(sessionKey);

    if (existingSession) {
      existingSession.leadAlreadySent = existingSession.leadAlreadySent || leadAlreadySent;
      return existingSession;
    }

    if (!loadStoredHistory) {
      const session: ConversationSession = {
        history: [],
        leadAlreadySent
      };

      this.conversationSessions.set(sessionKey, session);
      return session;
    }

    const records = await prisma.message.findMany({
      where: {
        instanceId,
        remoteJid
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 20,
      select: {
        direction: true,
        payload: true
      }
    });

    const history: ChatMessage[] = [];

    for (const record of [...records].reverse()) {
      const payload = record.payload as Record<string, unknown> | null;
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";

      if (!text) {
        continue;
      }

      history.push({
        role: record.direction === "INBOUND" ? "user" : "assistant",
        content: text
      });
    }

    const session: ConversationSession = {
      history: history.slice(-20),
      leadAlreadySent
    };

    this.conversationSessions.set(sessionKey, session);

    return session;
  }

  private async markConversationLeadSent(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    conversationId: string,
    session: ConversationSession
  ): Promise<void> {
    if (session.leadAlreadySent) {
      return;
    }

    await prisma.conversation.update({
      where: {
        id: conversationId
      },
      data: {
        leadSent: true,
        awaitingLeadExtraction: false
      } as Prisma.ConversationUncheckedUpdateInput
    });

    session.leadAlreadySent = true;
  }

  private appendConversationHistory(session: ConversationSession, role: ChatMessage["role"], content: string): void {
    const trimmedContent = content.trim();

    if (!trimmedContent) {
      return;
    }

    const lastMessage = session.history.at(-1);

    if (lastMessage?.role === role && lastMessage.content.trim() === trimmedContent) {
      return;
    }

    session.history.push({
      role,
      content: trimmedContent
    });

    if (session.history.length > 20) {
      session.history.splice(0, session.history.length - 20);
    }
  }

  private async sendConversationWithDelay(params: {
    tenantId: string;
    instanceId: string;
    remoteNumber: string;
    targetJid: string;
    text: string;
    metadata: Record<string, unknown>;
    session: ConversationSession;
  }): Promise<void> {
    const responseParts = params.text
      .split("|||")
      .map((part) => part.trim())
      .filter(Boolean);

    if (responseParts.length === 0) {
      return;
    }

    const delayLeitura = Math.floor(Math.random() * 1000) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delayLeitura));

    for (const [index, responsePart] of responseParts.entries()) {
      await this.sendAutomatedTextMessage(
        params.tenantId,
        params.instanceId,
        params.remoteNumber,
        params.targetJid,
        responsePart,
        params.metadata
      );
      this.appendConversationHistory(params.session, "assistant", responsePart);

      if (index < responseParts.length - 1) {
        const delayDigitacao = Math.floor(Math.random() * 1000) + 1500;
        await new Promise((resolve) => setTimeout(resolve, delayDigitacao));
      }
    }
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

