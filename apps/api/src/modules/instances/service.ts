import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  ChatbotModules,
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
import { normalizePhoneNumber, normalizeWhatsAppPhoneNumber, toJid, looksLikeRealPhone } from "../../lib/phone.js";
import { AdminIdentityService, type AdminIdentityInput } from "./admin-identity.service.js";
import { ConversationAgent } from "../chatbot/agents/conversation.agent.js";
import { FiadoAgent } from "../chatbot/agents/fiado.agent.js";
import { MemoryAgent } from "../chatbot/agents/memory.agent.js";
import { AdminMemoryService } from "../chatbot/admin-memory.service.js";
import type { AdminCommandService } from "../chatbot/admin-command.service.js";
import type { ChatMessage, LeadData } from "../chatbot/agents/types.js";
import { ConversationSessionManager } from "./conversation-session-manager.js";
import type { ConversationSession } from "./conversation-session-manager.js";
import type { EscalationService } from "../chatbot/escalation.service.js";
import type { ClientMemoryService } from "../chatbot/memory.service.js";
import {
  getAgendamentoAdminModuleConfig,
  getAprendizadoContinuoModuleConfig,
  getAntiSpamModuleConfig,
  getHorarioAtendimentoModuleConfig,
  getMemoriaPersonalizadaModuleConfig,
  getResumoDiarioModuleConfig,
  getSessaoInatividadeModuleConfig,
  isPhoneAllowedByListaBranca,
  isPhoneBlockedByBlacklist,
  isWithinHorarioAtendimento,
  matchesPauseWord,
  sanitizeChatbotModules
} from "../chatbot/module-runtime.js";
import { renderReplyTemplate, type ChatbotService } from "../chatbot/service.js";
import type { PlanEnforcementService } from "../platform/plan-enforcement.service.js";
import type { WebhookService } from "../webhooks/service.js";
import type { FiadoService } from "../chatbot/fiado.service.js";
import type { PlatformAlertService } from "../platform/alert.service.js";
import type { Queue } from "bullmq";

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
  adminCommandService: AdminCommandService;
  fiadoService: FiadoService;
  escalationService: EscalationService;
  platformAlertService?: PlatformAlertService;
  sendMessageQueue?: Queue;
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
  senderJid?: string | null;
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

interface ChatPhoneMappingWorkerEvent {
  type: "chat-phone-mapping";
  lid: string;
  jid: string;
}

interface AdminJidResolvedWorkerEvent {
  type: "admin-jid-resolved";
  resolvedJid: string;
}

type WorkerEvent =
  | StatusWorkerEvent
  | LogWorkerEvent
  | QrWorkerEvent
  | ProfileWorkerEvent
  | InboundMessageWorkerEvent
  | PhoneNumberShareWorkerEvent
  | ChatPhoneMappingWorkerEvent
  | AdminJidResolvedWorkerEvent
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

interface PendingConversationTurnContext {
  tenantId: string;
  instance: Instance;
  targetJid: string;
  remoteNumber: string;
  resolvedContactNumber: string;
  contactPhoneNumber: string;
  contactDisplayName: string | null;
  contactFields: Record<string, unknown> | null;
  chatbotConfig: {
    isEnabled?: boolean | null;
    welcomeMessage?: string | null;
    fallbackMessage?: string | null;
    leadsPhoneNumber?: string | null;
    leadsEnabled?: boolean | null;
    fiadoEnabled?: boolean | null;
    audioEnabled?: boolean | null;
    visionEnabled?: boolean | null;
    visionPrompt?: string | null;
    responseDelayMs?: number | null;
    leadAutoExtract?: boolean | null;
    modules?: ChatbotModules | null;
  } | null;
  conversationId: string;
  conversationPhoneNumber: string | null;
  isFirstContact: boolean;
}

const buildWorkerKey = (tenantId: string, instanceId: string): string => `${tenantId}:${instanceId}`;

/**
 * Divide o texto da resposta do bot em partes para envio separado.
 * Prioridade: separador explícito "|||" → parágrafos duplos (\n\n) se texto longo.
 */
const splitBotResponse = (text: string): string[] => {
  if (text.includes("|||")) {
    return text.split("|||").map((p) => p.trim()).filter(Boolean);
  }
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) {
    return paragraphs;
  }
  return [text];
};
const leadExtractionAwaitingTimeoutMs = 120_000;
const defaultChatbotResponseDelayMs = 10_000;
const adminEscalationTimeoutMs = 30 * 60 * 1000;
const formatCurrencyValue = (value: number): string =>
  new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
const resolveChatbotResponseDelayMs = (value?: number | null): number =>
  Math.min(60_000, Math.max(0, value ?? defaultChatbotResponseDelayMs));

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
  private readonly adminCommandService: AdminCommandService;
  private readonly chatbotService: ChatbotService;
  private readonly memoryAgent: MemoryAgent;
  private readonly conversationAgent: ConversationAgent;
  private readonly fiadoAgent: FiadoAgent;
  private readonly escalationService: EscalationService;
  private readonly platformAlertService?: PlatformAlertService;
  private readonly sendMessageQueue?: Queue;
  private readonly adminIdentityService = new AdminIdentityService();
  private readonly logEmitter = new EventEmitter();
  private readonly qrEmitter = new EventEmitter();
  private readonly latestQrCodes = new Map<string, QrCodeEvent>();
  private readonly sessionManager = new ConversationSessionManager();
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly workerStartLocks = new Map<string, Promise<InstanceSummary>>();
  private readonly automatedOutboundEchoIgnoreMap = new Map<string, NodeJS.Timeout>();
  private readonly dailySummarySentDates = new Map<string, string>(); // key: tenantId:instanceId, value: YYYY-MM-DD
  private escalationCleanupInterval: NodeJS.Timeout | null = null;
  private dailySummaryInterval: NodeJS.Timeout | null = null;
  // RISCO-07: instancias cujo admin ja recebeu aviso de ambiguidade de escalacao;
  // na proxima resposta sem citar, processa normalmente (confirmacao implicita)
  private readonly escalationAmbiguityAcknowledged = new Map<string, NodeJS.Timeout>();

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
    this.adminCommandService = deps.adminCommandService;
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
    this.escalationService = deps.escalationService;
    this.platformAlertService = deps.platformAlertService;
    this.sendMessageQueue = deps.sendMessageQueue;
  }

  public setPlatformAlertService(service: PlatformAlertService): void {
    (this as unknown as { platformAlertService: PlatformAlertService }).platformAlertService = service;
  }

  /**
   * Inicia schedulers periódicos:
   * - A cada 15 min: libera escalações travadas em todas instâncias ativas
   * - A cada hora: envia resumo diário às 8h para admins que tiverem aprendizado contínuo habilitado
   */
  public startSchedulers(): void {
    // Limpa escalações travadas a cada 15 minutos
    this.escalationCleanupInterval = setInterval(() => {
      void this.runEscalationCleanup().catch((err) => {
        console.warn("[scheduler] erro no cleanup de escalacoes:", err);
      });
    }, 15 * 60 * 1000);

    // Agenda resumo diário para disparar exatamente na próxima hora cheia UTC
    // e depois repetir a cada 1h — evita disparos duplos após restart
    const scheduleDailySummaryTick = (): void => {
      const now = new Date();
      const msUntilNextHour =
        (60 - now.getUTCMinutes()) * 60 * 1000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
      this.dailySummaryInterval = setTimeout(() => {
        void this.runDailySummaryForAllInstances().catch((err) => {
          console.warn("[scheduler] erro no resumo diario:", err);
        });
        // Reagenda para a próxima hora exata
        scheduleDailySummaryTick();
      }, msUntilNextHour);
    };
    scheduleDailySummaryTick();

    // MELHORIA: GC de sessoes de conversa inativas a cada 30 min
    this.sessionManager.startGc();
  }

  public stopSchedulers(): void {
    if (this.escalationCleanupInterval) {
      clearInterval(this.escalationCleanupInterval);
      this.escalationCleanupInterval = null;
    }
    if (this.dailySummaryInterval) {
      clearTimeout(this.dailySummaryInterval);
      this.dailySummaryInterval = null;
    }
    this.sessionManager.stopGc();
  }

  private async runEscalationCleanup(): Promise<void> {
    for (const workerKey of this.workers.keys()) {
      const [tenantId, instanceId] = workerKey.split(":");
      if (!tenantId || !instanceId) continue;
      try {
        await this.escalationService.releaseTimedOutEscalations(tenantId, instanceId);
      } catch {
        // ignora erros por instância individualmente
      }
    }
  }

  private async runDailySummaryForAllInstances(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);

    for (const workerKey of this.workers.keys()) {
      const [tenantId, instanceId] = workerKey.split(":");
      if (!tenantId || !instanceId) continue;

      const summaryKey = `${tenantId}:${instanceId}`;
      const redisDedupeKey = `daily-summary:sent:${summaryKey}:${today}`;
      const alreadySentRedis = await this.redis.get(redisDedupeKey).catch(() => null);
      if (alreadySentRedis || this.dailySummarySentDates.get(summaryKey) === today) continue;

      try {
        const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
        const config = await prisma.chatbotConfig.findUnique({
          where: { instanceId },
          select: { modules: true }
        });

        const sanitizedModules = sanitizeChatbotModules(config?.modules);
        const resumoDiarioModule = getResumoDiarioModuleConfig(sanitizedModules);
        const aprendizadoModule = getAprendizadoContinuoModuleConfig(sanitizedModules);

        // resumoDiario precisa estar ativo; se não configurado, usa comportamento legado (aprendizadoContinuo ativo)
        const summaryEnabled = resumoDiarioModule?.isEnabled === true ||
          (resumoDiarioModule == null && aprendizadoModule?.isEnabled === true);
        if (!summaryEnabled) continue;

        // Verifica se já passou da hora configurada (default: 8h UTC)
        const sendHour = resumoDiarioModule?.horaEnvioUtc ?? 8;
        if (new Date().getUTCHours() < sendHour) continue;

        const adminPhone = aprendizadoModule?.verifiedPhone ?? aprendizadoModule?.configuredAdminPhone ?? null;
        if (!adminPhone) continue;

        const instance = await prisma.instance.findUnique({
          where: { id: instanceId },
          select: { id: true }
        });
        if (!instance) continue;

        const summary = await this.adminCommandService.generateDailySummary(tenantId, instanceId);
        await this.sendAutomatedTextMessage(
          tenantId, instanceId, adminPhone,
          `${adminPhone}@s.whatsapp.net`, summary,
          { action: "daily_summary", kind: "chatbot" }
        );

        this.dailySummarySentDates.set(summaryKey, today);
        await this.redis.set(redisDedupeKey, "1", "EX", 86400).catch(() => null);
      } catch (err) {
        console.warn(`[scheduler] erro ao enviar resumo diario para ${workerKey}:`, err);
      }
    }
  }

  private buildAutomatedOutboundEchoKey(instanceId: string, externalMessageId: string): string {
    return `${instanceId}:${externalMessageId}`;
  }

  public rememberAutomatedOutboundEcho(instanceId: string, externalMessageId?: string | null): void {
    const normalizedExternalMessageId = externalMessageId?.trim();
    if (!normalizedExternalMessageId) {
      return;
    }

    const key = this.buildAutomatedOutboundEchoKey(instanceId, normalizedExternalMessageId);
    const existingTimeout = this.automatedOutboundEchoIgnoreMap.get(key);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(() => {
      this.automatedOutboundEchoIgnoreMap.delete(key);
    }, 2 * 60 * 1000);
    timeout.unref?.();
    this.automatedOutboundEchoIgnoreMap.set(key, timeout);

    // RISCO-01: persiste no Redis para sobreviver a reinicializacoes (TTL 120s)
    void this.redis.set(`echo:ignore:${key}`, "1", "EX", 120).catch(() => null);
  }

  private async consumeAutomatedOutboundEcho(instanceId: string, externalMessageId?: string | null): Promise<boolean> {
    const normalizedExternalMessageId = externalMessageId?.trim();
    if (!normalizedExternalMessageId) {
      return false;
    }

    const key = this.buildAutomatedOutboundEchoKey(instanceId, normalizedExternalMessageId);
    const timeout = this.automatedOutboundEchoIgnoreMap.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.automatedOutboundEchoIgnoreMap.delete(key);
      void this.redis.del(`echo:ignore:${key}`).catch(() => null);
      return true;
    }

    // RISCO-01: fallback para Redis — cobre echos apos reinicializacao
    const redisHit = await this.redis.getdel(`echo:ignore:${key}`).catch(() => null);
    return redisHit !== null;
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
    const workerKey = buildWorkerKey(tenantId, instanceId);
    const ongoingStart = this.workerStartLocks.get(workerKey);

    if (ongoingStart) {
      return ongoingStart;
    }

    const startPromise = (async () => {
      const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
      const instance = await this.requireInstanceWithUsage(tenantId, instanceId);

      if (instance.status === "BANNED") {
        throw new ApiError(409, "INSTANCE_BANNED", "Instancia marcada como banida e nao pode ser iniciada");
      }

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
    })();

    this.workerStartLocks.set(workerKey, startPromise);

    try {
      return await startPromise;
    } finally {
      if (this.workerStartLocks.get(workerKey) === startPromise) {
        this.workerStartLocks.delete(workerKey);
      }
    }
  }

  /**
   * Pausa a instancia e preserva os dados de autenticacao.
   */
  public async pauseInstance(tenantId: string, instanceId: string): Promise<InstanceSummary> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    await this.requireInstanceWithUsage(tenantId, instanceId);
    await this.stopWorker(tenantId, instanceId, "pause");

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
   * Desconecta a sessao ativa do WhatsApp e limpa os artefatos locais.
   */
  public async disconnectInstance(tenantId: string, instanceId: string): Promise<InstanceSummary> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instance = await this.requireInstanceWithUsage(tenantId, instanceId);

    await this.stopWorker(tenantId, instanceId, "logout");
    await this.clearInstanceSessionStorage(instance);

    this.latestQrCodes.delete(buildWorkerKey(tenantId, instanceId));

    const updated = await prisma.instance.update({
      where: { id: instanceId },
      data: {
        status: "DISCONNECTED",
        pausedAt: null,
        connectedAt: null,
        lastError: null,
        reconnectAttempts: 0,
        phoneNumber: null,
        avatarUrl: null
      },
      include: { usage: true }
    });

    this.metricsService.setInstanceStatus(updated.id, tenantId, updated.status);
    return this.mapInstanceSummary(tenantId, updated);
  }

  /**
   * Limpa a sessao persistida e reinicia a instancia para gerar um novo QR code.
   */
  public async reconnectInstance(tenantId: string, instanceId: string): Promise<InstanceSummary> {
    await this.disconnectInstance(tenantId, instanceId);
    return this.startInstance(tenantId, instanceId);
  }

  /**
   * Limpa a sessao persistida e reinicia a instancia para gerar um novo QR code.
   */
  public async resetSession(tenantId: string, instanceId: string): Promise<InstanceSummary> {
    return this.reconnectInstance(tenantId, instanceId);
  }

  /**
   * Remove a instancia, dados de sessao e registros associados.
   */
  public async deleteInstance(tenantId: string, instanceId: string): Promise<void> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    await this.requireInstanceWithUsage(tenantId, instanceId);
    await this.stopWorker(tenantId, instanceId, "shutdown");
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

    // MELHORIA: usa o rotador de chaves GROQ compartilhado com o ChatbotService
    const apiKey = this.chatbotService.getNextGroqApiKey() ?? this.config.GROQ_API_KEY;

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      this.chatbotService.reportGroqKeyResult(apiKey, response.status);
      console.error("[audio] Groq Whisper error:", await response.text());
      return null;
    }

    this.chatbotService.reportGroqKeyResult(apiKey, "success");
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
    this.stopSchedulers();
    this.sessionManager.clearAll();
    for (const workerKey of [...this.workers.keys()]) {
      const [tenantId, instanceId] = workerKey.split(":");
      await this.stopWorker(tenantId ?? "", instanceId ?? "", "shutdown");
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
    // Resolve adminPhone from configs so the worker can call onWhatsApp() at connection open
    const prismaForAdmin = await this.tenantPrismaRegistry.getClient(tenantId);
    const chatbotCfgForAdmin = await prismaForAdmin.chatbotConfig.findFirst({ where: { instanceId: instance.id } });
    const platformCfgForAdmin = await this.platformPrisma.platformConfig.findFirst();
    const adminPhone = chatbotCfgForAdmin?.leadsPhoneNumber ?? platformCfgForAdmin?.adminAlertPhone ?? null;

    const worker = new Worker(new URL("./baileys-session.worker.js", import.meta.url), {
      workerData: {
        instanceId: instance.id,
        tenantId,
        instanceName: instance.name,
        authDirectory: instance.authDirectory,
        sessionDbPath: instance.sessionDbPath,
        proxyUrl: instance.proxyUrl,
        adminPhone
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
      void this.handleWorkerEvent(tenantId, instance, managedWorker, event).catch((error) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));

        console.error("[orchestrator] erro ao processar evento do worker:", {
          error: normalizedError.message,
          eventType: event.type,
          instanceId: instance.id,
          stack: normalizedError.stack,
          tenantId
        });

        this.emitLog(workerKey, {
          context: {
            error: normalizedError.message,
            eventType: event.type
          },
          instanceId: instance.id,
          level: "error",
          message: "Falha ao processar evento do worker",
          timestamp: new Date().toISOString()
        });
      });
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

    worker.on("exit", (code) => {
      const current = this.workers.get(workerKey);

      if (!current) {
        return;
      }

      console.warn("[orchestrator] worker da instancia encerrado", {
        code,
        instanceId: instance.id,
        paused: current.paused,
        status: current.currentStatus,
        tenantId
      });

      for (const pending of current.pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new ApiError(503, "INSTANCE_WORKER_EXITED", "Worker da instancia encerrado"));
      }

      this.workers.delete(workerKey);
    });
  }

  private async clearInstanceSessionStorage(instance: Pick<Instance, "authDirectory" | "sessionDbPath">): Promise<void> {
    await rm(instance.authDirectory, {
      recursive: true,
      force: true
    });
    await rm(instance.sessionDbPath, {
      force: true
    });

    await mkdir(instance.authDirectory, { recursive: true });
    await mkdir(dirname(instance.sessionDbPath), { recursive: true });
  }

  private async stopWorker(
    tenantId: string,
    instanceId: string,
    mode: "pause" | "shutdown" | "logout"
  ): Promise<void> {
    const workerKey = buildWorkerKey(tenantId, instanceId);
    const managedWorker = this.workers.get(workerKey);

    if (!managedWorker) {
      return;
    }

    managedWorker.paused = mode === "pause";

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
        type: mode
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

    if (event.type === "admin-jid-resolved") {
      const resolvedJid = event.resolvedJid;
      if (resolvedJid) {
        await this.redis.set(`instance:${instance.id}:admin_jid`, resolvedJid);
        console.log("[admin-identity] JID do admin cacheado no Redis", {
          instanceId: instance.id,
          resolvedJid
        });
      }
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

    if (event.type === "chat-phone-mapping") {
      await this.handleChatPhoneMappingEvent(prisma, instance.id, event);
      return;
    }

    if (event.type === "status") {
      managedWorker.currentStatus = event.status;
      console.log("[worker-status]", {
        instanceId: instance.id,
        lastError: event.lastError ?? null,
        reconnectAttempts: event.reconnectAttempts ?? 0,
        status: event.status,
        tenantId
      });
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

      if (event.status === "DISCONNECTED" || event.status === "PAUSED") {
        await this.redis.del(`instance:${instance.id}:admin_jid`);
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

  private async persistLidPhoneMapping(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    instanceId: string,
    lid: string,
    jid: string
  ): Promise<void> {
    const sharedPhoneNumber = normalizeWhatsAppPhoneNumber(jid);

    if (!sharedPhoneNumber) {
      return;
    }

    const lidDigits = normalizePhoneNumber(lid.split("@")[0] ?? lid);
    const contactByLid = await prisma.contact.findFirst({
      where: {
        instanceId,
        OR: [
          {
            fields: {
              path: ["lastRemoteJid"],
              equals: lid
            }
          },
          {
            phoneNumber: lidDigits
          },
          {
            fields: {
              path: ["sharedPhoneJid"],
              equals: jid
            }
          }
        ]
      }
    });

    const sharedPhoneContact = await prisma.contact.findUnique({
      where: {
        instanceId_phoneNumber: {
          instanceId,
          phoneNumber: sharedPhoneNumber
        }
      }
    });

    if (!contactByLid && !sharedPhoneContact) {
      return;
    }

    const lidFields =
      contactByLid?.fields && typeof contactByLid.fields === "object"
        ? (contactByLid.fields as Record<string, unknown>)
        : {};

    if (sharedPhoneContact && contactByLid && sharedPhoneContact.id !== contactByLid.id) {
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
              lastRemoteJid: lid,
              sharedPhoneJid: jid
            } as Prisma.InputJsonValue
          }
        }),
        prisma.conversation.updateMany({
          where: {
            instanceId,
            contactId: contactByLid.id
          },
          data: {
            contactId: sharedPhoneContact.id,
            phoneNumber: sharedPhoneNumber
          }
        }),
        prisma.conversation.updateMany({
          where: {
            instanceId,
            contactId: sharedPhoneContact.id
          },
          data: {
            phoneNumber: sharedPhoneNumber
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

    const targetContact = sharedPhoneContact ?? contactByLid ?? null;
    const targetContactId = targetContact?.id;

    if (!targetContactId) {
      return;
    }

    const targetFields =
      targetContact?.fields && typeof targetContact.fields === "object"
        ? (targetContact.fields as Record<string, unknown>)
        : {};

    await prisma.contact.update({
      where: {
        id: targetContactId
      },
      data: {
        phoneNumber: sharedPhoneNumber,
        fields: {
          ...targetFields,
          ...lidFields,
          lastRemoteJid: lid,
          sharedPhoneJid: jid
        } as Prisma.InputJsonValue
      }
    });

    await prisma.conversation.updateMany({
      where: {
        instanceId,
        contactId: targetContactId
      },
      data: {
        phoneNumber: sharedPhoneNumber
      }
    });
  }

  private async handlePhoneNumberShareEvent(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    instanceId: string,
    event: PhoneNumberShareWorkerEvent
  ): Promise<void> {
    await this.persistLidPhoneMapping(prisma, instanceId, event.lid, event.jid);
    await this.linkAprendizadoContinuoAdminAlias(prisma, instanceId, event.lid, event.jid);
    const linkedConversationId = this.escalationService.linkAdminAlertChatAlias(event.lid, event.jid);

    if (linkedConversationId) {
      console.log("[escalation] alias @lid vinculado ao chat do admin", {
        conversationId: linkedConversationId,
        jid: event.jid,
        lid: event.lid
      });
    }
  }

  private async handleChatPhoneMappingEvent(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    instanceId: string,
    event: ChatPhoneMappingWorkerEvent
  ): Promise<void> {
    await this.persistLidPhoneMapping(prisma, instanceId, event.lid, event.jid);
    await this.linkAprendizadoContinuoAdminAlias(prisma, instanceId, event.lid, event.jid);
    const linkedConversationId = this.escalationService.linkAdminAlertChatAlias(event.lid, event.jid);

    if (linkedConversationId) {
      console.log("[escalation] alias de chat mapeado para alerta admin", {
        conversationId: linkedConversationId,
        jid: event.jid,
        lid: event.lid
      });
    }
  }

  private async linkAprendizadoContinuoAdminAlias(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    instanceId: string,
    lid: string,
    jid: string
  ): Promise<void> {
    const chatbotConfig = await prisma.chatbotConfig.findUnique({
      where: {
        instanceId
      },
      select: {
        modules: true
      }
    });
    const sanitizedModules = sanitizeChatbotModules(chatbotConfig?.modules);
    const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(sanitizedModules);

    if (
      !aprendizadoContinuoModule?.isEnabled ||
      aprendizadoContinuoModule.verificationStatus !== "VERIFIED"
    ) {
      return;
    }

    const candidatePhones = [
      normalizeWhatsAppPhoneNumber(jid),
      normalizePhoneNumber(jid.split("@")[0] ?? ""),
      normalizePhoneNumber(lid.split("@")[0] ?? "")
    ];
    const shouldLinkAlias =
      this.adminIdentityService.matchesAnyExpectedPhones(
        [
          aprendizadoContinuoModule.configuredAdminPhone,
          aprendizadoContinuoModule.verifiedPhone,
          ...aprendizadoContinuoModule.verifiedPhones,
          ...(aprendizadoContinuoModule.additionalAdminPhones ?? [])
        ],
        candidatePhones
      ) ||
      this.adminIdentityService.matchesAnyExpectedJids(
        [
          ...aprendizadoContinuoModule.verifiedRemoteJids,
          ...aprendizadoContinuoModule.verifiedSenderJids
        ],
        [jid, lid]
      );

    if (!shouldLinkAlias) {
      return;
    }

    const updatedModules = sanitizeChatbotModules({
      ...sanitizedModules,
      aprendizadoContinuo: {
        ...aprendizadoContinuoModule,
        verifiedPhone:
          aprendizadoContinuoModule.verifiedPhone ??
          normalizeWhatsAppPhoneNumber(jid) ??
          aprendizadoContinuoModule.configuredAdminPhone,
        verifiedPhones: this.appendUniqueStrings(
          [
            ...aprendizadoContinuoModule.verifiedPhones,
            aprendizadoContinuoModule.configuredAdminPhone,
            aprendizadoContinuoModule.verifiedPhone,
            ...candidatePhones
          ],
          (value) => normalizePhoneNumber(value)
        ),
        verifiedRemoteJids: this.appendUniqueStrings([
          ...aprendizadoContinuoModule.verifiedRemoteJids,
          jid,
          lid
        ]),
        verifiedSenderJids: this.appendUniqueStrings([
          ...aprendizadoContinuoModule.verifiedSenderJids,
          jid,
          lid
        ])
      }
    });

    await prisma.chatbotConfig.update({
      where: {
        instanceId
      },
      data: {
        modules: updatedModules as unknown as Prisma.InputJsonValue
      }
    });
  }

  private async tryVerifyAprendizadoContinuoAdmin(params: {
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>;
    tenantId: string;
    instanceId: string;
    chatbotConfigModules: ChatbotModules;
    rawTextInput: string;
    configuredAdminPhone: string | null;
    adminSenderCandidates: Array<string | null | undefined>;
    event: InboundMessageWorkerEvent;
    senderJid: string;
    resolvedContactNumber: string;
    remoteNumber: string;
    contactId: string;
    contactFields: Record<string, unknown> | null;
  }): Promise<boolean> {
    const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(params.chatbotConfigModules);

    if (
      !aprendizadoContinuoModule?.isEnabled ||
      aprendizadoContinuoModule.verificationStatus !== "PENDING" ||
      !aprendizadoContinuoModule.pendingCode
    ) {
      return false;
    }

    const expiresAt = aprendizadoContinuoModule.pendingCodeExpiresAt
      ? new Date(aprendizadoContinuoModule.pendingCodeExpiresAt).getTime()
      : Number.NaN;

    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      const expiredModules = sanitizeChatbotModules({
        ...params.chatbotConfigModules,
        aprendizadoContinuo: {
          ...aprendizadoContinuoModule,
          verificationStatus: "UNVERIFIED",
          pendingCode: null,
          pendingCodeExpiresAt: null,
          challengeMessageId: null,
          challengeRemoteJid: null
        }
      });

      await params.prisma.chatbotConfig.update({
        where: {
          instanceId: params.instanceId
        },
        data: {
          modules: expiredModules as unknown as Prisma.InputJsonValue
        }
      });

      return false;
    }

    const extractedVerificationCode =
      params.rawTextInput.match(/\b(\d{6})\b/)?.[1] ??
      (() => {
        const digitsOnly = params.rawTextInput.replace(/\D/g, "");
        return digitsOnly.length === 6 ? digitsOnly : null;
      })();
    const normalizedConfiguredAdminPhone = normalizePhoneNumber(
      aprendizadoContinuoModule.configuredAdminPhone ?? params.configuredAdminPhone ?? ""
    ) || null;
    const matchesPendingCode = extractedVerificationCode === aprendizadoContinuoModule.pendingCode;
    const canPromoteCurrentConversationToAdmin = Boolean(
      matchesPendingCode &&
      normalizedConfiguredAdminPhone &&
      !params.event.remoteJid.endsWith("@g.us")
    );
    const quotedExternalMessageId = this.extractQuotedMessageExternalId(params.event.rawMessage);
    const matchesConfiguredPhone = this.adminIdentityService.phonesMatch(
      aprendizadoContinuoModule.configuredAdminPhone ?? params.configuredAdminPhone,
      params.adminSenderCandidates
    );
    const matchesChallengeMessage = Boolean(
      aprendizadoContinuoModule.challengeMessageId &&
      quotedExternalMessageId &&
      aprendizadoContinuoModule.challengeMessageId === quotedExternalMessageId
    );
    const matchesChallengeChat = this.adminIdentityService.matchesAnyExpectedJids(
      [aprendizadoContinuoModule.challengeRemoteJid],
      [params.event.remoteJid, params.senderJid]
    );

    const matchesChallengeAlias = this.adminIdentityService.matchesAnyExpectedJids(
      [aprendizadoContinuoModule.challengeRemoteJid],
      [
        (params.contactFields?.sharedPhoneJid as string) ?? null,
        (params.contactFields?.lastRemoteJid as string) ?? null
      ]
    );

    const challengeConversationId = this.escalationService.resolveConversationIdByAdminAlertChat(
      aprendizadoContinuoModule.challengeRemoteJid
    );
    const eventConversationId =
      this.escalationService.resolveConversationIdByAdminAlertChat(params.event.remoteJid) ??
      this.escalationService.resolveConversationIdByAdminAlertChat(params.senderJid);
    const matchesEscalationAlias = Boolean(
      challengeConversationId &&
      eventConversationId &&
      challengeConversationId === eventConversationId
    );

    if (
      !canPromoteCurrentConversationToAdmin &&
      !matchesConfiguredPhone &&
      !matchesChallengeMessage &&
      !matchesChallengeChat &&
      !matchesChallengeAlias &&
      !matchesEscalationAlias
    ) {
      console.warn("[aprendizado-continuo] codigo de verificacao recebido, mas remetente nao corresponde ao admin esperado", {
        challengeRemoteJid: aprendizadoContinuoModule.challengeRemoteJid,
        configuredAdminPhone: aprendizadoContinuoModule.configuredAdminPhone,
        instanceId: params.instanceId,
        remoteJid: params.event.remoteJid,
        senderJid: params.senderJid,
        matchesConfiguredPhone,
        matchesChallengeMessage,
        matchesChallengeChat,
        matchesChallengeAlias,
        matchesEscalationAlias,
        challengeConversationId,
        eventConversationId
      });
      return false;
    }

    console.log("[aprendizado-continuo] mensagem recebida durante verificacao pendente", {
      hasCodeCandidate: Boolean(extractedVerificationCode),
      instanceId: params.instanceId,
      matchesChallengeChat,
      matchesChallengeMessage,
      matchesConfiguredPhone,
      matchesPendingCode,
      remoteJid: params.event.remoteJid,
      senderJid: params.senderJid,
      textPreview: params.rawTextInput.slice(0, 120)
    });

    if (extractedVerificationCode !== aprendizadoContinuoModule.pendingCode) {
      // Rate limiting: bloqueia após 5 tentativas erradas em 10 minutos
      if (extractedVerificationCode) {
        const rateLimitKey = `aprendizado:verify:ratelimit:${params.instanceId}:${params.event.remoteJid}`;
        const attempts = await this.redis.incr(rateLimitKey).catch(() => null);
        if (attempts === 1) {
          await this.redis.expire(rateLimitKey, 10 * 60).catch(() => null);
        }
        if (attempts !== null && attempts >= 5) {
          console.warn("[aprendizado-continuo] rate limit atingido para verificacao de admin", {
            instanceId: params.instanceId,
            remoteJid: params.event.remoteJid,
            attempts
          });
          return true;
        }
      }

      if (params.rawTextInput.trim()) {
        console.log("[aprendizado-continuo] mensagem recebida durante verificacao pendente, aguardando codigo correto", {
          instanceId: params.instanceId,
          remoteJid: params.event.remoteJid,
          senderJid: params.senderJid,
          textPreview: params.rawTextInput.slice(0, 120)
        });
      }

      return true;
    }

    if (
      canPromoteCurrentConversationToAdmin &&
      !matchesConfiguredPhone &&
      !matchesChallengeMessage &&
      !matchesChallengeChat &&
      !matchesChallengeAlias &&
      !matchesEscalationAlias
    ) {
      console.warn("[aprendizado-continuo] codigo correto recebido fora dos aliases conhecidos; promovendo conversa atual a admin", {
        configuredAdminPhone: aprendizadoContinuoModule.configuredAdminPhone,
        instanceId: params.instanceId,
        remoteJid: params.event.remoteJid,
        senderJid: params.senderJid
      });
    }

    const verifiedPhone =
      this.adminIdentityService.findMatchingExpectedPhone(
        [normalizedConfiguredAdminPhone],
        params.adminSenderCandidates
      ) ??
      normalizedConfiguredAdminPhone ??
      params.resolvedContactNumber ??
      params.remoteNumber;
    const verifiedPhoneJid = verifiedPhone ? `${normalizePhoneNumber(verifiedPhone)}@s.whatsapp.net` : null;
    const updatedModules = sanitizeChatbotModules({
      ...params.chatbotConfigModules,
      aprendizadoContinuo: {
        ...aprendizadoContinuoModule,
        verificationStatus: "VERIFIED",
        configuredAdminPhone:
          aprendizadoContinuoModule.configuredAdminPhone ?? params.configuredAdminPhone,
        verifiedPhone,
        pendingCode: null,
        pendingCodeExpiresAt: null,
        lastVerificationRequestedAt: aprendizadoContinuoModule.lastVerificationRequestedAt ?? new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        challengeMessageId: null,
        challengeRemoteJid: null,
        verifiedPhones: this.appendUniqueStrings(
          [
            ...aprendizadoContinuoModule.verifiedPhones,
            aprendizadoContinuoModule.configuredAdminPhone,
            verifiedPhone,
            ...params.adminSenderCandidates
          ],
          (value) => normalizePhoneNumber(value)
        ),
        verifiedRemoteJids: this.appendUniqueStrings([
          ...aprendizadoContinuoModule.verifiedRemoteJids,
          aprendizadoContinuoModule.challengeRemoteJid,
          params.event.remoteJid,
          verifiedPhoneJid
        ]),
        verifiedSenderJids: this.appendUniqueStrings([
          ...aprendizadoContinuoModule.verifiedSenderJids,
          params.senderJid,
          params.event.remoteJid,
          verifiedPhoneJid
        ])
      }
    });

    await params.prisma.chatbotConfig.update({
      where: {
        instanceId: params.instanceId
      },
      data: {
        modules: updatedModules as unknown as Prisma.InputJsonValue
      }
    });

    if (verifiedPhoneJid && params.event.remoteJid.endsWith("@lid")) {
      await this.persistLidPhoneMapping(params.prisma, params.instanceId, params.event.remoteJid, verifiedPhoneJid);
    }

    const verifiedContact =
      verifiedPhone
        ? await params.prisma.contact.findUnique({
            where: {
              instanceId_phoneNumber: {
                instanceId: params.instanceId,
                phoneNumber: verifiedPhone
              }
            }
          })
        : null;
    const targetContactId = verifiedContact?.id ?? params.contactId;
    const targetContactFields =
      verifiedContact?.fields && typeof verifiedContact.fields === "object"
        ? (verifiedContact.fields as Record<string, unknown>)
        : {};
    const nextContactFields = {
      ...targetContactFields,
      ...(params.contactFields ?? {}),
      adminVerified: true,
      lastRemoteJid: params.event.remoteJid,
      ...(verifiedPhoneJid ? { sharedPhoneJid: verifiedPhoneJid } : {})
    } as Prisma.InputJsonValue;

    await params.prisma.contact.update({
      where: {
        id: targetContactId
      },
      data: {
        ...(verifiedPhone ? { phoneNumber: verifiedPhone } : {}),
        fields: nextContactFields
      }
    });

    if (verifiedPhone) {
      await params.prisma.conversation.updateMany({
        where: {
          instanceId: params.instanceId,
          contactId: targetContactId
        },
        data: {
          phoneNumber: verifiedPhone
        }
      });
    }

    console.log("[aprendizado-continuo] admin verificado com sucesso", {
      instanceId: params.instanceId,
      remoteJid: params.event.remoteJid,
      senderJid: params.senderJid,
      verifiedPhone
    });

    return true;
  }

  private async handleInboundMessage(
    tenantId: string,
    instance: Instance,
    event: InboundMessageWorkerEvent
  ): Promise<void> {
    await this.tenantPrismaRegistry.ensureSchema(this.platformPrisma, tenantId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const cleanPhoneFromRemoteJid = String(event.remoteJid ?? "")
      .replace(/@s\.whatsapp\.net$/i, "")
      .replace(/@c\.us$/i, "")
      .replace(/@.*$/, "")
      .replace(/\D/g, "");
    const remotePhoneFromJid = normalizeWhatsAppPhoneNumber(event.remoteJid);
    const realPhoneFromRemoteJid = /@(s\.whatsapp\.net|c\.us)$/i.test(event.remoteJid)
      ? cleanPhoneFromRemoteJid
      : null;
    const remoteNumber = remotePhoneFromJid ?? normalizePhoneNumber(event.remoteJid.split("@")[0] ?? "");
    const sessionKey = this.sessionManager.buildKey(instance.id, event.remoteJid);
    // Extrai texto do payload; fallback para extendedTextMessage.text direto no rawMessage
    // (necessario para quoted replies onde payload.text pode chegar null do worker)
    const payloadText = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
    const rawMessageExtText = (() => {
      const raw = event.rawMessage;
      if (!raw || typeof raw !== "object") return "";
      const ext = (raw as Record<string, unknown>).extendedTextMessage;
      if (ext && typeof ext === "object") {
        const t = (ext as Record<string, unknown>).text;
        return typeof t === "string" ? t.trim() : "";
      }
      return "";
    })();
    const rawTextInput = payloadText || rawMessageExtText;
    const msgText = rawTextInput.toLowerCase();
    const hasMeaningfulInboundContent = event.messageType !== "text" || rawTextInput.length > 0;
    const isTemporaryTakeoverCommand = msgText === "*";
    const isPermanentDisableCommand = msgText === "**";
    const isResetCommand = msgText === "/reset";
    const isControlCommand = isTemporaryTakeoverCommand || isPermanentDisableCommand || isResetCommand;
    if (event.messageKey?.fromMe && !hasMeaningfulInboundContent) {
      return;
    }

    if (event.messageKey?.fromMe && event.externalMessageId) {
      if (await this.consumeAutomatedOutboundEcho(instance.id, event.externalMessageId)) {
        return;
      }

      const echoedOutboundMessage = await prisma.message.findFirst({
        where: {
          instanceId: instance.id,
          externalMessageId: event.externalMessageId,
          direction: "OUTBOUND"
        },
        select: {
          payload: true
        }
      });
      const outboundPayload =
        echoedOutboundMessage?.payload && typeof echoedOutboundMessage.payload === "object"
          ? (echoedOutboundMessage.payload as Record<string, unknown>)
          : null;
      const automationPayload =
        outboundPayload?.automation && typeof outboundPayload.automation === "object"
          ? (outboundPayload.automation as Record<string, unknown>)
          : null;

      if (automationPayload?.kind === "chatbot") {
        return;
      }
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
    const [chatbotConfig, currentInstance, platformConfig] = await Promise.all([
      prisma.chatbotConfig.findUnique({
        where: {
          instanceId: instance.id
        }
      }),
      prisma.instance.findUnique({
        where: {
          id: instance.id
        },
        select: {
          phoneNumber: true
        }
      }),
      this.platformPrisma.platformConfig.findUnique({
        where: { id: "singleton" }
      })
    ]);
    const chatbotConfigWithTakeoverMessages = chatbotConfig as
      | (typeof chatbotConfig & {
          humanTakeoverStartMessage?: string | null;
          humanTakeoverEndMessage?: string | null;
        })
      | null;
    const humanTakeoverStartMessage =
      chatbotConfigWithTakeoverMessages?.humanTakeoverStartMessage?.trim() ||
      "A partir de agora, seu atendimento será realizado por um de nossos especialistas. Em instantes ele entrará em contato.";
    const humanTakeoverEndMessage =
      chatbotConfigWithTakeoverMessages?.humanTakeoverEndMessage?.trim() ||
      "Olá! Estou de volta para te ajudar. Como posso te atender?";
    const sanitizedChatbotModules = sanitizeChatbotModules(chatbotConfig?.modules);
    const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(sanitizedChatbotModules);
    const senderJid = event.senderJid?.trim() || event.remoteJid;
    const senderNumber =
      normalizeWhatsAppPhoneNumber(senderJid) ??
      normalizePhoneNumber(String(senderJid ?? "").split("@")[0]?.split(":")[0] ?? "");
    const remoteChatNumber =
      normalizeWhatsAppPhoneNumber(event.remoteJid) ??
      normalizePhoneNumber(String(event.remoteJid ?? "").split("@")[0]?.split(":")[0] ?? "");
    const sharedPhoneNumberFromFields =
      normalizeWhatsAppPhoneNumber(
        typeof contactFields?.sharedPhoneJid === "string" ? contactFields.sharedPhoneJid : null
      ) ??
      normalizePhoneNumber(
        typeof contactFields?.sharedPhoneJid === "string"
          ? String(contactFields.sharedPhoneJid).split("@")[0] ?? ""
          : ""
      );
    const lastRemoteNumber =
      normalizeWhatsAppPhoneNumber(
        typeof contactFields?.lastRemoteJid === "string" ? contactFields.lastRemoteJid : null
      ) ??
      normalizePhoneNumber(
        typeof contactFields?.lastRemoteJid === "string"
          ? String(contactFields.lastRemoteJid).split("@")[0] ?? ""
          : ""
      );
    const adminCandidatePhones = [
      platformConfig?.adminAlertPhone ?? null,
      chatbotConfig?.leadsPhoneNumber ?? null
    ];
    const instanceOwnPhone =
      normalizeWhatsAppPhoneNumber(currentInstance?.phoneNumber ?? instance.phoneNumber) ??
      normalizePhoneNumber(currentInstance?.phoneNumber ?? instance.phoneNumber ?? "");
    const adminSenderCandidates = [
      senderNumber,
      remoteChatNumber,
      resolvedContactNumber,
      normalizePhoneNumber(contact.phoneNumber ?? ""),
      remoteNumber,
      realPhoneFromRemoteJid,
      cleanPhoneFromRemoteJid,
      sharedPhoneNumberFromFields,
      lastRemoteNumber
    ];
    // Resolve escalation conversation ID (async I/O — stays in handleInboundMessage, passed to service)
    const quotedLearningConversationIdFromSignals =
      this.extractQuotedLearningConversationId(event.rawMessage) ??
      this.extractLearningConversationIdFromText(rawTextInput) ??
      await this.escalationService.resolveConversationIdByAdminAlertMessageAsync(
        this.extractQuotedMessageExternalId(event.rawMessage)
      ) ??
      this.escalationService.resolveConversationIdByAdminAlertChat(event.remoteJid) ??
      this.escalationService.resolveConversationIdByAdminAlertChat(senderJid);
    let persistedAdminPromptConversationId: string | null = null;
    if (!quotedLearningConversationIdFromSignals && rawTextInput) {
      try {
        persistedAdminPromptConversationId = await this.escalationService.resolveConversationIdByPersistedAdminPrompt(
          tenantId,
          instance.id,
          [event.remoteJid, senderJid],
          adminSenderCandidates
        );
      } catch (error) {
        console.error("[escalation] falha ao consultar alerta admin persistido:", error);
      }
    }
    const quotedLearningConversationId = quotedLearningConversationIdFromSignals ?? persistedAdminPromptConversationId;
    // Read cached admin JID from Redis (set at connection open by admin-jid-resolved handler)
    const cachedAdminJid = await this.redis.get(`instance:${instance.id}:admin_jid`);
    // Build AdminIdentityInput and resolve admin identity via service
    const adminIdentityInput: AdminIdentityInput = {
      remoteJid: event.remoteJid,
      senderJid,
      fromMe: event.messageKey?.fromMe,
      rawTextInput,
      adminCandidatePhones,
      aprendizadoContinuoModule: aprendizadoContinuoModule
        ? {
            isEnabled: aprendizadoContinuoModule.isEnabled,
            verificationStatus: aprendizadoContinuoModule.verificationStatus,
            configuredAdminPhone: aprendizadoContinuoModule.configuredAdminPhone ?? null,
            verifiedPhone: aprendizadoContinuoModule.verifiedPhone ?? null,
            verifiedPhones: aprendizadoContinuoModule.verifiedPhones ?? [],
            additionalAdminPhones: aprendizadoContinuoModule.additionalAdminPhones ?? null,
            verifiedRemoteJids: aprendizadoContinuoModule.verifiedRemoteJids ?? [],
            verifiedSenderJids: aprendizadoContinuoModule.verifiedSenderJids ?? []
          }
        : null,
      instanceOwnPhone,
      contactPhoneNumber: contact.phoneNumber ?? null,
      sharedPhoneJid: typeof contactFields?.sharedPhoneJid === "string" ? contactFields.sharedPhoneJid : null,
      lastRemoteJid: typeof contactFields?.lastRemoteJid === "string" ? contactFields.lastRemoteJid : null,
      escalationConversationId: quotedLearningConversationId,
      senderNumber,
      remoteChatNumber,
      resolvedContactNumber,
      remoteNumber,
      realPhoneFromRemoteJid,
      cleanPhoneFromRemoteJid,
      sharedPhoneNumberFromFields,
      lastRemoteNumber,
      cachedAdminJid
    };
    const adminCtx = this.adminIdentityService.resolve(adminIdentityInput);
    const {
      isAdmin: isAdminSender,
      isVerifiedAdmin: isVerifiedAprendizadoContinuoAdminSender,
      isInstanceSelf: isInstanceSender,
      isAdminSelfChat,
      canReceiveLearningReply: canProcessAprendizadoContinuoReply,
      matchedAdminPhone,
      isAdminOrInstanceSender,
      shouldBypassDirectSenderTakeover,
      isAdminLearningReply
    } = adminCtx;
    // matchedVerifiedAdminPhone: the verified admin phone that matched the sender (used for fallback/logging).
    // Computed once after service call for downstream usage.
    const verifiedAdminPhonesForMatch =
      aprendizadoContinuoModule?.isEnabled && aprendizadoContinuoModule.verificationStatus === "VERIFIED"
        ? [
            aprendizadoContinuoModule.configuredAdminPhone ?? null,
            aprendizadoContinuoModule.verifiedPhone ?? null,
            ...aprendizadoContinuoModule.verifiedPhones,
            ...(aprendizadoContinuoModule.additionalAdminPhones ?? [])
          ]
        : [];
    const matchedVerifiedAdminPhone = this.adminIdentityService.findMatchingExpectedPhone(
      verifiedAdminPhonesForMatch,
      adminSenderCandidates
    );
    if (
      rawTextInput &&
      (
        Boolean(matchedAdminPhone) ||
        Boolean(quotedLearningConversationId) ||
        /aprendizado necessario/i.test(rawTextInput) ||
        /\bID:\s*[a-z0-9]+\b/i.test(rawTextInput)
      )
    ) {
      console.log("[escalation] inbound admin candidate", {
        instanceId: instance.id,
        externalMessageId: event.externalMessageId,
        matchedAdminPhone,
        quotedLearningConversationId,
        remoteJid: event.remoteJid,
        senderJid,
        textPreview: rawTextInput.slice(0, 500)
      });
    }
    if (isVerifiedAprendizadoContinuoAdminSender) {
      console.log("[aprendizado-continuo] remetente reconhecido como admin verificado", {
        instanceId: instance.id,
        remoteJid: event.remoteJid,
        senderJid,
        quotedLearningConversationId,
        textPreview: rawTextInput.slice(0, 120)
      });
    }

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
        awaitingAdminResponse: true,
        pendingClientJid: true,
        humanTakeover: true,
        humanTakeoverAt: true,
        aiDisabledPermanent: true,
        updatedAt: true,
        phoneNumber: true
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
          awaitingAdminResponse: true,
          pendingClientJid: true,
          humanTakeover: true,
          humanTakeoverAt: true,
          aiDisabledPermanent: true,
          updatedAt: true,
          phoneNumber: true
        }
      });
      console.log("[lead] awaitingLeadExtraction reset para conversa:", resolvedConversation.id);
    }

    const activeConversation = !resolvedConversation
      ? await prisma.conversation.create({
          data: {
            instanceId: instance.id,
            contactId: contact.id,
            phoneNumber: cleanPhoneFromRemoteJid || resolvedContactNumber,
            lastMessageAt: new Date(),
            awaitingLeadExtraction: false,
            awaitingAdminResponse: false,
            humanTakeover: false,
            aiDisabledPermanent: false
          },
          select: {
            id: true,
            leadSent: true,
            awaitingLeadExtraction: true,
            awaitingAdminResponse: true,
            pendingClientJid: true,
            humanTakeover: true,
            humanTakeoverAt: true,
            aiDisabledPermanent: true,
            updatedAt: true,
            phoneNumber: true
          }
        })
      : resolvedConversation.awaitingLeadExtraction || resolvedConversation.awaitingAdminResponse
        ? resolvedConversation
        : await prisma.conversation.update({
          where: { id: resolvedConversation.id },
          data: {
            lastMessageAt: new Date(),
            ...(cleanPhoneFromRemoteJid ? { phoneNumber: cleanPhoneFromRemoteJid } : {})
          },
          select: {
            id: true,
            leadSent: true,
            awaitingLeadExtraction: true,
            awaitingAdminResponse: true,
            pendingClientJid: true,
            humanTakeover: true,
            humanTakeoverAt: true,
            aiDisabledPermanent: true,
            updatedAt: true,
            phoneNumber: true
          }
        });

    if (
      activeConversation.humanTakeover &&
      activeConversation.humanTakeoverAt &&
      (Date.now() - activeConversation.humanTakeoverAt.getTime()) / 3_600_000 >= 24
    ) {
      await prisma.conversation.update({
        where: {
          id: activeConversation.id
        },
        data: {
          humanTakeover: false,
          humanTakeoverAt: null
        } as Prisma.ConversationUncheckedUpdateInput
      });
      activeConversation.humanTakeover = false;
      activeConversation.humanTakeoverAt = null;
      await this.clearPausedByHumanIfReleased({
        tenantId,
        phoneNumber: resolvedContactNumber,
        conversation: activeConversation,
        reason: "stale_tag"
      });
    }

    if (
      activeConversation.awaitingAdminResponse &&
      aprendizadoContinuoModule?.isEnabled !== true
    ) {
      await prisma.conversation.update({
        where: {
          id: activeConversation.id
        },
        data: {
          awaitingAdminResponse: false,
          pendingClientQuestion: null,
          pendingClientJid: null,
          pendingClientConversationId: null
        } as Prisma.ConversationUncheckedUpdateInput
      });

      activeConversation.awaitingAdminResponse = false;
      activeConversation.pendingClientJid = null;

      console.log("[aprendizado-continuo] conversa destravada porque o modulo esta desativado", {
        conversationId: activeConversation.id,
        instanceId: instance.id
      });
    }

    if (
      await this.tryVerifyAprendizadoContinuoAdmin({
        prisma,
        tenantId,
        instanceId: instance.id,
        chatbotConfigModules: sanitizedChatbotModules,
        rawTextInput,
        configuredAdminPhone: chatbotConfig?.leadsPhoneNumber ?? null,
        adminSenderCandidates,
        event,
        senderJid,
        resolvedContactNumber,
        remoteNumber,
        contactId: contact.id,
        contactFields
      })
    ) {
      return;
    }

    // Deduplicação de mensagens inbound do admin via Redis.
    // O Baileys pode entregar o mesmo evento duas vezes (reconexão, ack duplicado).
    // Se já processamos este externalMessageId para este instanceId, ignoramos.
    if (canProcessAprendizadoContinuoReply && event.externalMessageId) {
      const dedupKey = `admin-msg-dedup:${instance.id}:${event.externalMessageId}`;
      const alreadyProcessed = await this.redis.set(dedupKey, "1", "EX", 30, "NX");
      if (!alreadyProcessed) {
        console.warn(`[admin-dedup] mensagem ${event.externalMessageId} já processada, ignorando duplicata`);
        return;
      }
    }

    const hasPendingEscalationsForAdminBypass = canProcessAprendizadoContinuoReply
      ? await this.escalationService.hasPendingEscalations(tenantId, instance.id)
      : false;

    if (isAdminOrInstanceSender && isPermanentDisableCommand) {
      this.sessionManager.clear(sessionKey);

      await prisma.conversation.update({
        where: {
          id: activeConversation.id
        },
        data: {
          aiDisabledPermanent: true,
          humanTakeover: false,
          humanTakeoverAt: null
        } as Prisma.ConversationUncheckedUpdateInput
      });

      activeConversation.aiDisabledPermanent = true;
      activeConversation.humanTakeover = false;
      activeConversation.humanTakeoverAt = null;

      return;
    }

    if (isAdminOrInstanceSender && isTemporaryTakeoverCommand) {
      this.sessionManager.clear(sessionKey);

      if (activeConversation.humanTakeover) {
        await prisma.conversation.update({
          where: {
            id: activeConversation.id
          },
          data: {
            humanTakeover: false,
            humanTakeoverAt: null
          } as Prisma.ConversationUncheckedUpdateInput
        });

        activeConversation.humanTakeover = false;
        activeConversation.humanTakeoverAt = null;
        await this.clearPausedByHumanIfReleased({
          tenantId,
          phoneNumber: resolvedContactNumber,
          conversation: activeConversation,
          reason: "takeover_ended"
        });

        await this.sendAutomatedTextMessage(
          tenantId,
          instance.id,
          resolvedContactNumber,
          event.remoteJid,
          humanTakeoverEndMessage,
          {
            action: "human_takeover_disabled",
            kind: "chatbot"
          }
        );

        return;
      }

      if (activeConversation.aiDisabledPermanent) {
        return;
      }

      const humanTakeoverAt = new Date();
      await prisma.conversation.update({
        where: {
          id: activeConversation.id
        },
        data: {
          humanTakeover: true,
          humanTakeoverAt
        } as Prisma.ConversationUncheckedUpdateInput
      });

      activeConversation.humanTakeover = true;
      activeConversation.humanTakeoverAt = humanTakeoverAt;

      await this.sendAutomatedTextMessage(
        tenantId,
        instance.id,
        resolvedContactNumber,
        event.remoteJid,
        humanTakeoverStartMessage,
        {
          action: "human_takeover_enabled",
          kind: "chatbot"
        }
      );

      return;
    }

    if (isResetCommand && !event.remoteJid.endsWith("@g.us")) {
      await prisma.conversation.update({
        where: {
          id: activeConversation.id
        },
        data: {
          awaitingLeadExtraction: false,
          leadSent: false,
          awaitingAdminResponse: false,
          pendingClientQuestion: null,
          pendingClientJid: null,
          pendingClientConversationId: null,
          humanTakeover: false,
          humanTakeoverAt: null,
          aiDisabledPermanent: false
        } as Prisma.ConversationUncheckedUpdateInput
      });
      console.log("[lead] awaitingLeadExtraction reset para conversa:", activeConversation.id);

      await prisma.message.deleteMany({
        where: {
          instanceId: instance.id,
          remoteJid: event.remoteJid
        }
      });
      await this.clientMemoryService.deleteByPhone(tenantId, resolvedContactNumber);
      this.sessionManager.clear(sessionKey);

      await this.sendAutomatedTextMessage(
        tenantId,
        instance.id,
        resolvedContactNumber,
        event.remoteJid,
        "🔄 Conversa resetada com sucesso.",
        {
          action: "reset",
          kind: "chatbot"
        }
      );

      return;
    }

    if (
      isAdminOrInstanceSender &&
      hasMeaningfulInboundContent &&
      !isControlCommand &&
      !shouldBypassDirectSenderTakeover &&
      !hasPendingEscalationsForAdminBypass
    ) {
      this.sessionManager.clear(sessionKey);

      if (!activeConversation.aiDisabledPermanent) {
        const humanTakeoverAt = new Date();
        await prisma.conversation.update({
          where: {
            id: activeConversation.id
          },
          data: {
            humanTakeover: true,
            humanTakeoverAt
          } as Prisma.ConversationUncheckedUpdateInput
        });

        activeConversation.humanTakeover = true;
        activeConversation.humanTakeoverAt = humanTakeoverAt;
      }

      return;
    }

    if (isFirstContact) {
      this.sessionManager.clear(sessionKey);
    }

    await prisma.message.create({
      data: {
        instanceId: instance.id,
        remoteJid: event.remoteJid,
        externalMessageId: event.externalMessageId,
        direction: "INBOUND",
        type: event.messageType,
        status: "DELIVERED",
        payload: event.payload as Prisma.InputJsonValue,
        traceId: activeConversation.id
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

    // INCOMPLETA-03: aplicar modulos de filtragem apenas para mensagens de clientes
    if (!isAdminOrInstanceSender && !isControlCommand) {
      // blacklist por modulo (complementa contact.isBlacklisted que e por DB)
      if (isPhoneBlockedByBlacklist(sanitizedChatbotModules, resolvedContactNumber)) {
        console.log("[blacklist] numero bloqueado pelo modulo:", resolvedContactNumber);
        return;
      }

      // lista branca: so responde numeros da lista quando modo = "permitir_lista"
      if (!isPhoneAllowedByListaBranca(sanitizedChatbotModules, resolvedContactNumber)) {
        console.log("[lista-branca] numero nao permitido:", resolvedContactNumber);
        return;
      }

      // horario de atendimento
      const horarioModule = getHorarioAtendimentoModuleConfig(sanitizedChatbotModules);
      if (horarioModule?.isEnabled) {
        if (!isWithinHorarioAtendimento(horarioModule)) {
          await this.sendAutomatedTextMessage(
            tenantId,
            instance.id,
            resolvedContactNumber,
            event.remoteJid,
            horarioModule.mensagemForaHorario,
            { action: "fora_horario_atendimento", kind: "chatbot" }
          );
          return;
        }
      }

      // anti-spam: limita mensagens por contato usando Redis
      const antiSpamModule = getAntiSpamModuleConfig(sanitizedChatbotModules);
      if (antiSpamModule?.isEnabled && resolvedContactNumber) {
        const spamKey = `antispam:${instance.id}:${resolvedContactNumber}`;
        const spamCount = await this.redis.incr(spamKey).catch(() => null);
        if (spamCount === 1) {
          const ttlSeconds = antiSpamModule.intervaloMinutos * 60;
          await this.redis.expire(spamKey, ttlSeconds).catch(() => null);
        }
        if (spamCount !== null && spamCount > antiSpamModule.maxMensagens) {
          console.log("[anti-spam] mensagem bloqueada para:", resolvedContactNumber);
          return;
        }
      }
    }

    const isAiBlocked = activeConversation.aiDisabledPermanent || activeConversation.humanTakeover;

    if (isControlCommand && !isAdminOrInstanceSender) {
      return;
    }

    if (isAiBlocked && !isAdminOrInstanceSender && !isControlCommand) {
      return;
    }

    const sessaoInatividadeModule = getSessaoInatividadeModuleConfig(sanitizedChatbotModules);
    const inactivityMs = sessaoInatividadeModule?.isEnabled === true
      ? sessaoInatividadeModule.horasInatividade * 60 * 60 * 1000
      : null;

    // INCOMPLETA-06: detectar reset por inatividade antes de obter a sessao
    // para poder enviar a mensagem de reset ao cliente
    const existingSessionForInactivityCheck = this.sessionManager.get(sessionKey);
    const sessionWillResetByInactivity = Boolean(
      !isAdminOrInstanceSender &&
      existingSessionForInactivityCheck &&
      inactivityMs != null &&
      Date.now() - existingSessionForInactivityCheck.lastActivityAt.getTime() > inactivityMs
    );

    const session = await this.sessionManager.getOrCreate(
      prisma,
      sessionKey,
      instance.id,
      event.remoteJid,
      activeConversation.leadSent,
      !isFirstContact,
      inactivityMs
    );

    if (sessionWillResetByInactivity && sessaoInatividadeModule?.mensagemReset) {
      await this.sendAutomatedTextMessage(
        tenantId,
        instance.id,
        resolvedContactNumber,
        event.remoteJid,
        sessaoInatividadeModule.mensagemReset,
        { action: "sessao_inatividade_reset", kind: "chatbot" }
      );
    }

    try {
      // rawTextInput ja inclui fallback de extendedTextMessage para quoted replies
      const inputText = rawTextInput;

      let finalInputText = inputText;

      const rawMessage = event.rawMessage;
      const messageKey = event.messageKey ?? { remoteJid: event.remoteJid };

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
                traceId: activeConversation.id,
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

      if (
        activeConversation.awaitingAdminResponse &&
        Date.now() - activeConversation.updatedAt.getTime() > adminEscalationTimeoutMs
      ) {
        const releasedCount = await this.escalationService.releaseTimedOutEscalations(tenantId, instance.id);
        if (releasedCount > 0) {
          activeConversation.awaitingAdminResponse = false;
        }
      }

      if (
        activeConversation.awaitingLeadExtraction &&
        !isAdminOrInstanceSender &&
        !hasPendingEscalationsForAdminBypass
      ) {
        return;
      }

      if (activeConversation.awaitingLeadExtraction && (isAdminOrInstanceSender || hasPendingEscalationsForAdminBypass)) {
        console.log("[escalation] ignorando awaitingLeadExtraction do chat do admin para processar aprendizado pendente", {
          activeConversationId: activeConversation.id,
          hasPendingEscalationsForAdminBypass,
          instanceId: instance.id,
          isAdminOrInstanceSender,
          remoteJid: event.remoteJid,
          senderJid
        });
      }

      const clientMemory = await this.clientMemoryService.findByPhone(tenantId, resolvedContactNumber);
      // Permite comandos de ensino (/pitaco, /regra) para admin verificado via aprendizadoContinuo
      const effectiveAdminPhone = matchedAdminPhone ??
        (isVerifiedAprendizadoContinuoAdminSender
          ? (matchedVerifiedAdminPhone ?? aprendizadoContinuoModule?.verifiedPhone ?? aprendizadoContinuoModule?.configuredAdminPhone ?? null)
          : null);
      if (
        finalInputText &&
        effectiveAdminPhone &&
        await this.adminMemoryService.handleAdminMessage(
          instance.id,
          tenantId,
          effectiveAdminPhone,
          effectiveAdminPhone,
          finalInputText
        )
      ) {
        return;
      }

      // ── Prefixo de comentário interno do admin ──────────────────────────────
      // Mensagens que começam com ">>" ou "//" são tratadas como notas internas:
      // não são processadas como aprendizado, agendamento ou resposta a escalação.
      // Ex: ">> isso foi errado, não use essa resposta"
      if (finalInputText && isAdminSender && /^\s*(>>|\/\/)/.test(finalInputText)) {
        await this.sendAutomatedTextMessage(
          tenantId,
          instance.id,
          remoteNumber,
          event.remoteJid,
          "💬 Comentário interno registrado. Nenhuma ação tomada.",
          { action: "admin_internal_comment", kind: "chatbot" }
        );
        return;
      }

      // Detecta correcao: admin respondendo (reply/quote) a confirmacao "Aprendi e respondi"
      // Este check e independente de pendingEscalations — pode ocorrer a qualquer momento
      if (finalInputText && isVerifiedAprendizadoContinuoAdminSender) {
        const correctionQuestion = this.extractQuotedConfirmationQuestion(event.rawMessage);
        if (correctionQuestion) {
          console.log("[escalation] correcao detectada pelo admin", { question: correctionQuestion, instanceId: instance.id });
          await this.escalationService.processAdminCorrection(tenantId, instance.id, correctionQuestion, finalInputText);
          void this.chatbotService.triggerKnowledgeSynthesis(tenantId, instance.id)
            .catch((err) => console.warn("[knowledge-synthesis] erro na correcao:", err));
          await this.sendAutomatedTextMessage(
            tenantId,
            instance.id,
            remoteNumber,
            event.remoteJid,
            `✅ Correção registrada!\n\nPergunta: "${correctionQuestion}"\nNova resposta: "${finalInputText}"`,
            { action: "admin_learning_correction", kind: "chatbot" }
          );
          return;
        }
      }

      if (finalInputText && canProcessAprendizadoContinuoReply) {
        await this.escalationService.releaseTimedOutEscalations(tenantId, instance.id);

        const hasPendingEscalations = hasPendingEscalationsForAdminBypass;
        if (hasPendingEscalations) {
          // RISCO-07: quando admin responde sem citar a mensagem de escalacao e ha mais
          // de uma conversa pendente, avisar qual cliente seria afetado antes de processar.
          // Na segunda resposta sem citar (acknowledged), processa normalmente.
          if (!quotedLearningConversationId) {
            const pendingCount = await this.escalationService.countPendingEscalations(tenantId, instance.id);
            if (pendingCount > 1) {
              const ackKey = `${instance.id}:${event.remoteJid}`;
              const alreadyAcknowledged = this.escalationAmbiguityAcknowledged.has(ackKey);
              if (alreadyAcknowledged) {
                // Admin ja foi avisado — limpa o estado e processa normalmente
                const ackTimeout = this.escalationAmbiguityAcknowledged.get(ackKey);
                if (ackTimeout) clearTimeout(ackTimeout);
                this.escalationAmbiguityAcknowledged.delete(ackKey);
              } else {
                // Primeira vez sem citar: avisa e bloqueia ate proxima resposta
                const oldest = await this.escalationService.peekOldestPendingEscalation(tenantId, instance.id);
                if (oldest) {
                  const clientDisplay =
                    normalizeWhatsAppPhoneNumber(oldest.clientJid) ??
                    String(oldest.clientJid).split("@")[0] ??
                    oldest.clientJid;
                  await this.sendAutomatedTextMessage(
                    tenantId,
                    instance.id,
                    remoteNumber,
                    event.remoteJid,
                    [
                      `⚠️ Há ${pendingCount} clientes aguardando resposta.`,
                      "",
                      `Sua resposta seria enviada ao cliente: *${clientDisplay}*`,
                      `Pergunta: "${oldest.clientQuestion.slice(0, 120)}"`,
                      "",
                      "Para confirmar, envie sua resposta novamente.",
                      "Para responder outro cliente, cite a mensagem de escalação correspondente."
                    ].join("\n"),
                    { action: "admin_escalation_ambiguity_warning", kind: "chatbot" }
                  );
                  // Marca como avisado — expira em 5 min
                  const ackTimeout = setTimeout(() => {
                    this.escalationAmbiguityAcknowledged.delete(ackKey);
                  }, 5 * 60 * 1000);
                  ackTimeout.unref?.();
                  this.escalationAmbiguityAcknowledged.set(ackKey, ackTimeout);
                  return;
                }
              }
            }
          }

          const learningResult = await this.escalationService.processAdminReply(
            tenantId,
            instance.id,
            finalInputText,
            quotedLearningConversationId
          );

          if (learningResult) {
            const clientResponse = await this.chatbotService.formulateAdminAnswerForClient(
              tenantId,
              instance.id,
              learningResult.clientQuestion,
              learningResult.formulatedAnswer
            );
            const clientRemoteNumber =
              normalizeWhatsAppPhoneNumber(learningResult.clientJid) ??
              normalizePhoneNumber(String(learningResult.clientJid).split("@")[0] ?? "");

            if (clientRemoteNumber) {
              await this.sendAutomatedTextMessage(
                tenantId,
                instance.id,
                clientRemoteNumber,
                learningResult.clientJid,
                clientResponse,
                { action: "admin_learning_reply", kind: "chatbot" }
              );

              const clientSessionKey = this.sessionManager.buildKey(instance.id, learningResult.clientJid);
              const clientSession = this.sessionManager.get(clientSessionKey);
              if (clientSession) {
                this.appendConversationHistory(clientSession, "assistant", clientResponse);
              }
            } else {
              console.warn("[escalation] nao foi possivel derivar o numero do cliente a partir do JID");
            }

            const learningAdminPhone = this.resolveConfiguredPhone(
              aprendizadoContinuoModule?.verifiedPhone ?? null,
              ...(aprendizadoContinuoModule?.verifiedPhones ?? []),
              ...(aprendizadoContinuoModule?.additionalAdminPhones ?? []),
              chatbotConfig?.leadsPhoneNumber,
              platformConfig?.adminAlertPhone
            );
            if (learningAdminPhone) {
              const delivered = await this.platformAlertService?.sendInstanceAlert(
                tenantId,
                instance.id,
                learningAdminPhone,
                [
                  "Aprendi e respondi o cliente!",
                  "",
                  `Pergunta: "${learningResult.clientQuestion}"`,
                  `Resposta enviada: "${clientResponse}"`,
                  "",
                  "Se quiser corrigir a resposta, envie o texto correto nos proximos 5 min."
                ].join("\n")
              );

              if (delivered === false) {
                console.warn("[escalation] falha ao enviar confirmacao de aprendizado ao admin");
              }

              // PENDING_REVIEW: janela de 5 min para correcao pos-aprendizado
              const adminPhoneNormalized = learningAdminPhone.replace(/\D/g, "");
              if (adminPhoneNormalized) {
                this.escalationService.trackPendingKnowledgeCorrection(
                  instance.id,
                  adminPhoneNormalized,
                  learningResult.savedKnowledgeId,
                  tenantId,
                  learningResult.clientQuestion,
                  clientResponse
                );
              }
            }

            // fire-and-forget: sintetiza conhecimento apos novo aprendizado
            void this.chatbotService.triggerKnowledgeSynthesis(tenantId, instance.id)
              .catch((err) => console.warn("[knowledge-synthesis] erro no fire-and-forget:", err));

            return;
          }

          if (canProcessAprendizadoContinuoReply) {
            await this.sendAutomatedTextMessage(
              tenantId,
              instance.id,
              remoteNumber,
              event.remoteJid,
              "Nao consegui vincular sua resposta a um aprendizado pendente. Tente responder novamente a mensagem do aprendizado.",
              { action: "admin_learning_unmatched_reply", kind: "chatbot" }
            );
            return;
          }
        }

      }

      // ── Agendamento via Admin (prioridade máxima) ───────────────────────────
      // Deve ser checado ANTES de handleCommand para que respostas de disponibilidade
      // não sejam interceptadas pelo processador de comandos livres do admin.
      //
      // RECONHECIMENTO: usa isAdminSender OU isVerifiedAprendizadoContinuoAdminSender.
      // Admins com JID @lid (Linked Identity Device) não batem em comparações de telefone,
      // mas são reconhecidos via verifiedRemoteJids/verifiedSenderJids do módulo de
      // aprendizado contínuo — a "âncora" de identidade já existente no sistema.
      const agendamentoModuleForAdminReply = getAgendamentoAdminModuleConfig(sanitizedChatbotModules);
      const isRecognizedAdminSender = isAdminSender || isVerifiedAprendizadoContinuoAdminSender;
      if (finalInputText && isRecognizedAdminSender && agendamentoModuleForAdminReply?.isEnabled) {
        // Espelha EXATAMENTE os candidatos usados na gravação do pending map
        // (ver handleChatbotSchedulingRequest → resolvedAdminPhone).
        // Assim o lookup sempre encontra a chave certa, independente de JID @lid ou 9º dígito.
        const adminPhoneLookupCandidates = (
          [
            agendamentoModuleForAdminReply.adminPhone,
            aprendizadoContinuoModule?.verifiedPhone,
            aprendizadoContinuoModule?.configuredAdminPhone,
            ...(aprendizadoContinuoModule?.verifiedPhones ?? []),
            ...(aprendizadoContinuoModule?.additionalAdminPhones ?? []),
            chatbotConfig?.leadsPhoneNumber,
            platformConfig?.adminAlertPhone,
            matchedAdminPhone,
            matchedVerifiedAdminPhone,
            resolvedContactNumber,
          ] as Array<string | null | undefined>
        ).filter((p): p is string => typeof p === "string" && p.trim() !== "");
        const uniqueAdminPhoneCandidates = [...new Set(adminPhoneLookupCandidates)];

        let schedulingPending: { tenantId: string; instanceId: string; clientJid: string; clientName: string; assunto: string; dataPreferencia: string } | null = null;
        for (const candidate of uniqueAdminPhoneCandidates) {
          schedulingPending = await this.escalationService.consumePendingSchedulingReply(
            instance.id,
            candidate
          );
          if (schedulingPending) break;
        }
        if (schedulingPending) {
          const clientRemoteNumber =
            (normalizeWhatsAppPhoneNumber(schedulingPending.clientJid) ??
            normalizePhoneNumber(String(schedulingPending.clientJid).split("@")[0] ?? "")) ||
            schedulingPending.clientJid;

          if (clientRemoteNumber && clientRemoteNumber.trim()) {
            const hasClientPreference =
              schedulingPending.dataPreferencia &&
              schedulingPending.dataPreferencia.trim().toLowerCase() !== "sem preferência" &&
              schedulingPending.dataPreferencia.trim().toLowerCase() !== "sem preferencia" &&
              schedulingPending.dataPreferencia.trim() !== "";

            const questionContext = hasClientPreference
              ? `O cliente ${schedulingPending.clientName} quer agendar: ${schedulingPending.assunto}. Preferência de horário do cliente: ${schedulingPending.dataPreferencia}. Resposta do administrador:`
              : `O cliente ${schedulingPending.clientName} quer agendar: ${schedulingPending.assunto}. Resposta do administrador sobre disponibilidade:`;

            const msgToClient = await this.chatbotService.formulateAdminAnswerForClient(
              tenantId,
              instance.id,
              questionContext,
              finalInputText
            ).catch(() =>
              hasClientPreference
                ? `Olá! Temos uma atualização sobre o seu agendamento para *${schedulingPending.dataPreferencia}*.\n\n${finalInputText}`
                : finalInputText
            );

            await this.sendAutomatedTextMessage(
              tenantId,
              instance.id,
              clientRemoteNumber,
              schedulingPending.clientJid,
              msgToClient,
              { action: "scheduling_admin_reply_to_client", kind: "chatbot" }
            );

            await this.sendAutomatedTextMessage(
              tenantId,
              instance.id,
              remoteNumber,
              event.remoteJid,
              `✅ Resposta enviada para *${schedulingPending.clientName}*!\n\nAssunto: ${schedulingPending.assunto}${hasClientPreference ? `\nPreferência do cliente: ${schedulingPending.dataPreferencia}` : ""}`,
              { action: "scheduling_admin_reply_ack", kind: "chatbot" }
            );
          } else {
            console.warn("[scheduling] falha ao normalizar numero do cliente para agendamento", {
              instanceId: instance.id,
              clientJid: schedulingPending.clientJid,
              clientRemoteNumber
            });
          }
          return;
        }
      }

      // Comando livre do admin verificado — não é reply de aprendizado nem correção
      if (finalInputText && isVerifiedAprendizadoContinuoAdminSender) {
        const handled = await this.adminCommandService.handleCommand({
          tenantId,
          instanceId: instance.id,
          text: finalInputText,
          adminPhone: remoteNumber,
          sendResponse: async (text) => {
            await this.sendAutomatedTextMessage(
              tenantId,
              instance.id,
              remoteNumber,
              event.remoteJid,
              text,
              { action: "admin_command_response", kind: "chatbot" }
            );
          },
          sendMessageToClient: async (jid, normalizedPhone, text) => {
            try {
              await this.sendAutomatedTextMessage(
                tenantId,
                instance.id,
                normalizedPhone,
                jid,
                text,
                { action: "admin_command_send_client", kind: "chatbot" }
              );
              return true;
            } catch {
              return false;
            }
          }
        });
        if (handled) return;

        // PENDING_REVIEW: verifica se admin esta corrigindo conhecimento recem-aprendido
        if (finalInputText && resolvedContactNumber) {
          const correctionConsumed = await this.escalationService.consumePendingKnowledgeCorrection(
            instance.id,
            resolvedContactNumber,
            finalInputText
          );
          if (correctionConsumed) {
            await this.sendAutomatedTextMessage(
              tenantId,
              instance.id,
              remoteNumber,
              event.remoteJid,
              "Conhecimento atualizado!",
              { action: "admin_knowledge_correction_ack", kind: "chatbot" }
            );
            return;
          }
        }

      }

      if (finalInputText && activeConversation.awaitingAdminResponse && !canProcessAprendizadoContinuoReply) {
        console.warn("[escalation] mensagem recebida com aprendizado pendente, mas remetente nao foi reconhecido como admin", {
          instanceId: instance.id,
          conversationId: activeConversation.id,
          remoteJid: event.remoteJid,
          senderJid,
          adminCandidatePhones: adminCandidatePhones.filter(Boolean),
          verifiedAdminPhones: verifiedAdminPhonesForMatch.filter(Boolean),
          adminSenderCandidates: adminSenderCandidates.filter(Boolean),
          quotedLearningConversationId
        });
      }

      if (activeConversation.awaitingAdminResponse && !canProcessAprendizadoContinuoReply) {
        console.log("[escalation] conversa pausada, ignorando mensagem do cliente");
        return;
      }

      if (clientMemory?.tags.includes("paused_by_human")) {
        const removedPausedTag = await this.clearPausedByHumanIfReleased({
          tenantId,
          phoneNumber: resolvedContactNumber,
          conversation: activeConversation,
          reason: "stale_tag"
        });

        if (!removedPausedTag) {
          return;
        }
      }

      if (!finalInputText) {
        if (imageMsg && (chatbotConfig?.visionEnabled ?? false)) {
          finalInputText = "[O cliente enviou uma imagem. Aguardando análise.]";
        } else {
          return;
        }
      }

      // Agendamento: cliente esta respondendo com preferencia de horario
      if (!isAdminOrInstanceSender && finalInputText && resolvedContactNumber) {
        const clientPref = await this.escalationService.consumePendingSchedulingClientPreference(
          instance.id,
          resolvedContactNumber
        );
        if (clientPref) {
          const adminJid = clientPref.adminJid || `${clientPref.adminPhone}@s.whatsapp.net`;

          // Confirma ao cliente
          const clientConfirmMsg = `Perfeito! ✅ Sua preferência foi registrada. Em breve nossa equipe confirmará o agendamento com você.`;
          await this.sendAutomatedTextMessage(
            tenantId,
            instance.id,
            resolvedContactNumber,
            event.remoteJid,
            clientConfirmMsg,
            { action: "scheduling_client_preference_ack", kind: "chatbot" }
          );

          // Notifica o admin com o horario escolhido pelo cliente
          const adminNotifyMsg = [
            `📅 *${clientPref.clientName}* escolheu um horário para: *${clientPref.assunto}*`,
            ``,
            `Disponibilidade que você informou: ${clientPref.adminAvailability}`,
            `Preferência do cliente: ${finalInputText}`,
            ``,
            `Confirme o agendamento diretamente com o cliente.`
          ].join("\n");

          await this.sendAutomatedTextMessage(
            tenantId,
            instance.id,
            clientPref.adminPhone,
            adminJid,
            adminNotifyMsg,
            { action: "scheduling_admin_confirmation_alert", kind: "chatbot" }
          ).catch((err) => console.warn("[scheduling] falha ao notificar admin com preferencia do cliente:", err));

          return;
        }
      }

      // INCOMPLETA-03: palavra-pausa — desativa o bot ao detectar palavra-chave do cliente
      if (!isAdminOrInstanceSender && finalInputText) {
        const pauseResult = matchesPauseWord(sanitizedChatbotModules, finalInputText);
        if (pauseResult.matched) {
          if (pauseResult.message) {
            await this.sendAutomatedTextMessage(
              tenantId,
              instance.id,
              resolvedContactNumber,
              event.remoteJid,
              pauseResult.message,
              { action: "palavra_pausa", kind: "chatbot" }
            );
          }
          await prisma.conversation.update({
            where: { id: activeConversation.id },
            data: { humanTakeover: true, humanTakeoverAt: new Date() } as Prisma.ConversationUncheckedUpdateInput
          });
          this.sessionManager.clear(sessionKey);
          console.log("[palavra-pausa] bot desativado para conversa:", activeConversation.id);
          return;
        }
      }

      this.queueConversationTurn(session, finalInputText, {
        tenantId,
        instance,
        targetJid: event.remoteJid,
        remoteNumber,
        resolvedContactNumber,
        contactPhoneNumber: contact.phoneNumber ?? remoteNumber,
        contactDisplayName: contact.displayName ?? null,
        contactFields,
        chatbotConfig: chatbotConfig
          ? {
              ...chatbotConfig,
              modules: sanitizedChatbotModules
            }
          : null,
        conversationId: activeConversation.id,
        conversationPhoneNumber: activeConversation.phoneNumber,
        isFirstContact
      });
      return;

      /*
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

        const camposVerificacao = [
          {
            regex: /Nome:\s*(?!n[ãa]o informado|\(nome\))/i,
            pergunta: "Antes de confirmar, pode me dizer seu nome? 😊"
          },
          {
            regex: /Servi[çc]o de interesse:\s*(?!n[ãa]o informado)/i,
            pergunta: "Me conta o que você precisa — seria um app, sistema web ou automação? 🤔"
          },
          {
            regex: /Hor[áa]rio agendado:\s*(?!n[ãa]o informado|a confirmar)/i,
            pergunta: "Qual dia e horário ficaria melhor pra você para a reunião? 📅"
          }
        ];

        const campoFaltando = camposVerificacao.find((c) => !c.regex.test(resumoLead));
        const camposOk = !campoFaltando;

        if (!camposOk && campoFaltando) {
          console.log("[leads] RESUMO_LEAD incompleto, reforçando coleta:", campoFaltando.pergunta);
          const delayReforco = Math.floor(Math.random() * 500) + 1000;
          await new Promise((resolve) => setTimeout(resolve, delayReforco));
          await this.sendAutomatedTextMessage(
            tenantId,
            instance.id,
            remoteNumber,
            event.remoteJid,
            campoFaltando.pergunta,
            { action: "lead_field_reinforcement", kind: "chatbot" }
          );
          this.appendConversationHistory(session, "assistant", campoFaltando.pergunta);
        }

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

      await new Promise((resolve) => setTimeout(resolve, initialAiResponseDelayMs));

      const partes = splitBotResponse(clientText);
      for (let i = 0; i < partes.length; i++) {
        const parte = partes[i]!;
        await this.sendAutomatedTextMessage(
          tenantId,
          instance.id,
          remoteNumber,
          event.remoteJid,
          parte,
          { action: "conversation_agent", kind: "chatbot" }
        );
        this.appendConversationHistory(session, "assistant", parte);
        if (i < partes.length - 1) {
          const delayDigitacao = Math.floor(Math.random() * 1000) + 1500;
          await new Promise((resolve) => setTimeout(resolve, delayDigitacao));
        }
      }

      const memoriaModule = getMemoriaPersonalizadaModuleConfig(sanitizeChatbotModules(chatbotConfig?.modules));
      if (memoriaModule?.isEnabled === true && memoriaModule.fields.length > 0) {
        void this.chatbotService.extractPersistentMemory(
          tenantId,
          instance.id,
          resolvedContactNumber,
          session.history
        ).catch((err) => {
          console.warn("[persistent-memory] erro no fire-and-forget:", err);
        });
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
            const senderRemoteJid =
              /@(s\.whatsapp\.net|c\.us)$/i.test(event.remoteJid)
                ? event.remoteJid
                : typeof contactFields?.sharedPhoneJid === "string" && contactFields.sharedPhoneJid.trim()
                  ? contactFields.sharedPhoneJid.trim()
                  : activeConversation.phoneNumber &&
                      activeConversation.phoneNumber !== cleanPhoneFromRemoteJid
                    ? toJid(activeConversation.phoneNumber)
                    : "";
            console.log("[lead:phone] source variable:", JSON.stringify(senderRemoteJid || event.remoteJid));
            const senderPhone =
              String(senderRemoteJid ?? "")
                .replace(/@s\.whatsapp\.net$/i, "")
                .replace(/@c\.us$/i, "")
                .replace(/@.*$/, "")
                .replace(/\D/g, "");
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
      */
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

  private async clearPausedByHumanIfReleased(params: {
    tenantId: string;
    phoneNumber: string;
    conversation: {
      id: string;
      humanTakeover: boolean;
      aiDisabledPermanent: boolean;
    };
    reason: "takeover_ended" | "stale_tag";
  }): Promise<boolean> {
    const normalizedPhoneNumber = normalizePhoneNumber(params.phoneNumber);

    if (!normalizedPhoneNumber) {
      return false;
    }

    if (params.conversation.humanTakeover || params.conversation.aiDisabledPermanent) {
      return false;
    }

    await this.clientMemoryService.removeTag(params.tenantId, normalizedPhoneNumber, "paused_by_human");
    console.log("[chatbot] removendo paused_by_human residual", {
      conversationId: params.conversation.id,
      phoneNumber: normalizedPhoneNumber,
      reason: params.reason
    });
    return true;
  }

  private isSessionExecutionStale(session: ConversationSession, expectedGeneration: number): boolean {
    return session.resetGeneration !== expectedGeneration;
  }

  private appendUniqueStrings(
    values: Array<string | null | undefined>,
    normalizer?: (value: string) => string | null
  ): string[] {
    const seen = new Set<string>();
    const output: string[] = [];

    for (const value of values) {
      const trimmed = value?.trim();
      if (!trimmed) {
        continue;
      }

      const normalized = normalizer ? normalizer(trimmed) : trimmed;
      const finalValue = normalized?.trim();

      if (!finalValue || seen.has(finalValue)) {
        continue;
      }

      seen.add(finalValue);
      output.push(finalValue);
    }

    return output;
  }

  private resolveConfiguredPhone(...candidates: Array<string | null | undefined>): string | null {
    for (const candidate of candidates) {
      const trimmed = candidate?.trim();
      if (trimmed) {
        return trimmed;
      }
    }

    return null;
  }

  private extractQuotedMessageText(rawMessage?: Record<string, unknown>): string | null {
    if (!rawMessage) {
      return null;
    }

    const candidateContainers = [
      rawMessage.extendedTextMessage,
      rawMessage.imageMessage,
      rawMessage.videoMessage,
      rawMessage.documentMessage,
      rawMessage.audioMessage,
      rawMessage.pttMessage
    ];

    for (const container of candidateContainers) {
      if (!container || typeof container !== "object") {
        continue;
      }

      const contextInfo =
        "contextInfo" in container && typeof container.contextInfo === "object"
          ? (container.contextInfo as Record<string, unknown>)
          : null;
      const quotedMessage =
        contextInfo?.quotedMessage && typeof contextInfo.quotedMessage === "object"
          ? (contextInfo.quotedMessage as Record<string, unknown>)
          : null;

      if (!quotedMessage) {
        continue;
      }

      if (typeof quotedMessage.conversation === "string" && quotedMessage.conversation.trim()) {
        return quotedMessage.conversation.trim();
      }

      const quotedExtendedText =
        quotedMessage.extendedTextMessage && typeof quotedMessage.extendedTextMessage === "object"
          ? (quotedMessage.extendedTextMessage as { text?: string }).text
          : null;

      if (typeof quotedExtendedText === "string" && quotedExtendedText.trim()) {
        return quotedExtendedText.trim();
      }
    }

    return null;
  }

  private extractQuotedMessageExternalId(rawMessage?: Record<string, unknown>): string | null {
    if (!rawMessage) {
      return null;
    }

    const candidateContainers = [
      rawMessage.extendedTextMessage,
      rawMessage.imageMessage,
      rawMessage.videoMessage,
      rawMessage.documentMessage,
      rawMessage.audioMessage,
      rawMessage.pttMessage
    ];

    for (const container of candidateContainers) {
      if (!container || typeof container !== "object") {
        continue;
      }

      const contextInfo =
        "contextInfo" in container && typeof container.contextInfo === "object"
          ? (container.contextInfo as Record<string, unknown>)
          : null;
      const stanzaId =
        typeof contextInfo?.stanzaId === "string" && contextInfo.stanzaId.trim()
          ? contextInfo.stanzaId.trim()
          : null;

      if (stanzaId) {
        return stanzaId;
      }
    }

    return null;
  }

  private extractLearningConversationIdFromText(text?: string | null): string | null {
    if (!text?.trim()) {
      return null;
    }

    return text.match(/\bID:\s*([a-z0-9]+)\b/i)?.[1] ?? null;
  }

  private extractQuotedLearningConversationId(rawMessage?: Record<string, unknown>): string | null {
    const quotedText = this.extractQuotedMessageText(rawMessage);

    if (!quotedText || !/aprendizado necessario/i.test(quotedText)) {
      return null;
    }

    return quotedText.match(/\bID:\s*([a-z0-9]+)\b/i)?.[1] ?? null;
  }

  /**
   * Detecta se o admin esta respondendo a uma mensagem de confirmacao "Aprendi e respondi".
   * Retorna a pergunta original extraida do texto quotado, ou null.
   */
  private extractQuotedConfirmationQuestion(rawMessage?: Record<string, unknown>): string | null {
    const quotedText = this.extractQuotedMessageText(rawMessage);

    if (!quotedText) {
      return null;
    }

    if (!/aprendi e respondi/i.test(quotedText)) {
      return null;
    }

    // Tenta aspas retas e curvas
    const match =
      quotedText.match(/Pergunta:\s*"([^"]+)"/i)?.[1]?.trim() ??
      quotedText.match(/Pergunta:\s*\u201c([^\u201d]+)\u201d/i)?.[1]?.trim() ??
      quotedText.match(/Pergunta:\s*(.+?)(?:\n|Resposta)/i)?.[1]?.trim();

    return match ?? null;
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

    session.lastActivityAt = new Date();

    const lastMessage = session.history.at(-1);

    if (lastMessage?.role === role && lastMessage.content.trim() === trimmedContent) {
      return;
    }

    session.history.push({
      role,
      content: trimmedContent
    });

    session.lastActivityAt = new Date();

    if (session.history.length > 20) {
      session.history.splice(0, session.history.length - 20);
    }
  }

  private queueConversationTurn(
    session: ConversationSession,
    inputText: string,
    context: PendingConversationTurnContext
  ): void {
    const trimmedInput = inputText.trim();

    if (!trimmedInput) {
      return;
    }

    session.pendingInputs.push(trimmedInput);
    session.pendingContext = session.pendingContext
      ? {
          ...session.pendingContext,
          ...context,
          isFirstContact: session.pendingContext.isFirstContact || context.isFirstContact
        }
      : context;

    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
    }

    const responseDelayMs = resolveChatbotResponseDelayMs(context.chatbotConfig?.responseDelayMs);

    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = null;

      if (session.isProcessing) {
        session.flushAfterProcessing = true;
        return;
      }

      void this.processQueuedConversationTurn(session);
    }, responseDelayMs);
  }

  private async processQueuedConversationTurn(session: ConversationSession): Promise<void> {
    if (session.isProcessing || session.pendingInputs.length === 0 || !session.pendingContext) {
      return;
    }

    const combinedInput = session.pendingInputs.join("\n").trim();
    const context = session.pendingContext;
    const sessionGeneration = session.resetGeneration;

    session.pendingInputs = [];
    session.pendingContext = null;
    session.isProcessing = true;
    session.flushAfterProcessing = false;

    try {
      await this.processConversationTurn({
        ...context,
        inputText: combinedInput,
        session,
        sessionGeneration
      });
    } catch (error) {
      this.emitLog(buildWorkerKey(context.tenantId, context.instance.id), {
        context: {
          error: error instanceof Error ? error.message : "unknown"
        },
        instanceId: context.instance.id,
        level: "warn",
        message: "Falha ao processar resposta automatica do chatbot",
        timestamp: new Date().toISOString()
      });

      this.platformAlertService?.alertCriticalError(
        context.tenantId,
        context.instance.id,
        error instanceof Error ? error.message : "Erro desconhecido no chatbot"
      ).catch((err) => {
        console.error("[orchestrator] erro ao alertar erro critico:", err);
      });
    } finally {
      session.isProcessing = false;

      if (session.flushAfterProcessing && session.pendingInputs.length > 0 && !session.debounceTimer) {
        void this.processQueuedConversationTurn(session);
      }
    }
  }

  private async isConversationAiBlocked(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    conversationId: string
  ): Promise<boolean> {
    const conversation = await prisma.conversation.findUnique({
      where: {
        id: conversationId
      },
      select: {
        humanTakeover: true,
        aiDisabledPermanent: true,
        awaitingAdminResponse: true
      }
    });

    return Boolean(
      conversation?.humanTakeover || conversation?.aiDisabledPermanent || conversation?.awaitingAdminResponse
    );
  }

  private async processConversationTurn(params: PendingConversationTurnContext & {
    inputText: string;
    session: ConversationSession;
    sessionGeneration: number;
  }): Promise<void> {
    const prisma = await this.tenantPrismaRegistry.getClient(params.tenantId);
    const clientMemory = await this.clientMemoryService.findByPhone(params.tenantId, params.resolvedContactNumber);
    const platformConfig = await this.platformPrisma.platformConfig.findUnique({
      where: { id: "singleton" }
    });
    const adminPhone = this.resolveConfiguredPhone(
      params.chatbotConfig?.leadsPhoneNumber,
      platformConfig?.adminAlertPhone
    );

    if (clientMemory?.tags.includes("paused_by_human")) {
      const conversationStillBlocked = await this.isConversationAiBlocked(prisma, params.conversationId);

      if (conversationStillBlocked) {
        return;
      }

      await this.clearPausedByHumanIfReleased({
        tenantId: params.tenantId,
        phoneNumber: params.resolvedContactNumber,
        conversation: {
          id: params.conversationId,
          humanTakeover: false,
          aiDisabledPermanent: false
        },
        reason: "stale_tag"
      });
    }

    if (await this.isConversationAiBlocked(prisma, params.conversationId)) {
      return;
    }

    // isNewSession = sessão sem histórico anterior (cliente retornando após inatividade ou primeiro contato)
    const isNewSession = params.session.history.length === 0 && !params.isFirstContact;
    const { contextString } = await this.memoryAgent.getContext({
      tenantId: params.tenantId,
      phoneNumber: params.resolvedContactNumber,
      isNewSession
    });

    if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
      return;
    }

    this.appendConversationHistory(params.session, "user", params.inputText);

    const fiadoResponse = await this.fiadoAgent.process({
      message: params.inputText,
      phoneNumber: params.resolvedContactNumber,
      tenantId: params.tenantId,
      instanceId: params.instance.id,
      displayName: params.contactDisplayName,
      fiadoEnabled: params.chatbotConfig?.fiadoEnabled ?? false
    });

    if (fiadoResponse) {
      if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
        return;
      }

      await this.memoryAgent.update({
        tenantId: params.tenantId,
        phoneNumber: params.resolvedContactNumber,
        clientMessage: params.inputText
      });

      if (await this.isConversationAiBlocked(prisma, params.conversationId)) {
        return;
      }

      await this.sendConversationWithDelay({
        tenantId: params.tenantId,
        instanceId: params.instance.id,
        remoteNumber: params.resolvedContactNumber,
        targetJid: params.targetJid,
        text: fiadoResponse,
        metadata: {
          action: "fiado_agent",
          kind: "chatbot"
        },
        conversationId: params.conversationId,
        session: params.session,
        sessionGeneration: params.sessionGeneration
      });
      return;
    }

    const welcomeTemplate = params.chatbotConfig?.welcomeMessage?.trim() ?? "";
    const shouldSendWelcomeFirst =
      params.isFirstContact && params.chatbotConfig?.isEnabled === true && welcomeTemplate.length > 0;

    if (shouldSendWelcomeFirst) {
      const welcomeMessage = renderReplyTemplate(welcomeTemplate, {
        contactName: params.contactDisplayName,
        phoneNumber: params.contactPhoneNumber ?? params.remoteNumber,
        text: params.inputText
      }).trim();

      if (welcomeMessage) {
        await this.sendConversationWithDelay({
          tenantId: params.tenantId,
          instanceId: params.instance.id,
          remoteNumber: params.remoteNumber,
          targetJid: params.targetJid,
          text: welcomeMessage,
          metadata: {
            action: "welcome_message",
            kind: "chatbot"
          },
          conversationId: params.conversationId,
          session: params.session,
          sessionGeneration: params.sessionGeneration
        });
      }
    }

    if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
      return;
    }

    const chatbotResult = await this.conversationAgent.reply({
      tenantId: params.tenantId,
      instanceId: params.instance.id,
      message: params.inputText,
      history: params.session.history,
      clientContext: contextString,
      isFirstContact: shouldSendWelcomeFirst ? false : params.isFirstContact,
      contactName: params.contactDisplayName ?? null,
      phoneNumber: params.contactPhoneNumber ?? params.remoteNumber,
      remoteJid: shouldSendWelcomeFirst ? null : params.targetJid
    });

    if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
      return;
    }

    if (chatbotResult?.action === "HUMAN_HANDOFF") {
      if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
        return;
      }

      await this.clientMemoryService.upsert(params.tenantId, params.resolvedContactNumber, {
        lastContactAt: new Date(),
        tags: [...new Set<ClientMemoryTag>([...(clientMemory?.tags ?? []), "paused_by_human"])]
      });

      if (adminPhone) {
        const adminJid = adminPhone.includes("@") ? adminPhone : `${adminPhone}@s.whatsapp.net`;
        await this.sendAutomatedTextMessage(
          params.tenantId,
          params.instance.id,
          adminPhone,
          adminJid,
          `Transbordo humano solicitado pelo cliente ${params.resolvedContactNumber}. O bot foi pausado para este contato.`,
          { action: "human_handoff_alert", kind: "chatbot" }
        ).catch((err) => console.warn("[handoff] falha ao notificar admin:", err));
      }
      return;
    }

    if (chatbotResult?.action === "SCHEDULING_REQUEST" && chatbotResult.schedulingPayload) {
      const payload = chatbotResult.schedulingPayload;

      // Resolve o adminPhone: usa o configurado no modulo ou cai para o admin do aprendizadoContinuo.
      // IMPORTANTE: normaliza com normalizeWhatsAppPhoneNumber para garantir que o formato
      // seja idêntico ao resolvedContactNumber usado no consumo (evita mismatch de chave no mapa).
      const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(params.chatbotConfig?.modules ?? undefined);
      const rawAdminPhone = payload.adminPhone?.replace(/\D/g, "") ||
        this.resolveConfiguredPhone(
          aprendizadoContinuoModule?.verifiedPhone ?? null,
          ...(aprendizadoContinuoModule?.verifiedPhones ?? []),
          ...(aprendizadoContinuoModule?.additionalAdminPhones ?? []),
          params.chatbotConfig?.leadsPhoneNumber,
          platformConfig?.adminAlertPhone
        );
      // Normaliza para o mesmo formato que resolvedContactNumber usa ao consumir
      const resolvedAdminPhone = rawAdminPhone
        ? (normalizeWhatsAppPhoneNumber(`${rawAdminPhone}@s.whatsapp.net`) ?? rawAdminPhone)
        : null;

      if (resolvedAdminPhone) {
        // Monta a mensagem para o admin preenchendo o template
        const adminMessage = (payload.adminAlertTemplate || "📅 *{{nome}}* quer agendar.\nAssunto: {{assunto}}\nPreferência: {{data_preferencia}}\nTelefone: {{telefone}}\n\nQual sua disponibilidade?")
          .replace(/\{\{nome\}\}/g, payload.clientName)
          .replace(/\{\{assunto\}\}/g, payload.assunto)
          .replace(/\{\{data_preferencia\}\}/g, payload.dataPreferencia)
          .replace(/\{\{telefone\}\}/g,
            looksLikeRealPhone(params.resolvedContactNumber) ? params.resolvedContactNumber
            : looksLikeRealPhone(params.remoteNumber) ? params.remoteNumber
            : "não disponível (contato via WhatsApp)");

        // Envia mensagem ao admin via sendAutomatedTextMessage para que o echo
        // seja registrado em rememberAutomatedOutboundEcho e não seja reprocessado
        // como mensagem inbound (o que causaria um ciclo de escalação falsa).
        try {
          const adminJid = resolvedAdminPhone.includes("@")
            ? resolvedAdminPhone
            : `${resolvedAdminPhone}@s.whatsapp.net`;
          await this.sendAutomatedTextMessage(
            params.tenantId,
            params.instance.id,
            resolvedAdminPhone,
            adminJid,
            adminMessage,
            { action: "scheduling_admin_alert", kind: "chatbot" }
          );
        } catch (err) {
          console.warn("[scheduling] falha ao notificar admin:", err);
        }

        // Registra no mapa de pendentes (30 min para o admin responder)
        this.escalationService.trackPendingSchedulingRequest(
          params.instance.id,
          resolvedAdminPhone,
          params.tenantId,
          params.targetJid,
          payload.clientName,
          payload.assunto,
          payload.dataPreferencia
        );
      } else {
        console.warn("[scheduling] adminPhone nao configurado, solicitacao de agendamento ignorada");
      }

      // Envia mensagem de espera ao cliente.
      // IMPORTANTE: strip [RESUMO_LEAD] — NUNCA deve ser enviado ao cliente.
      // A IA às vezes gera o bloco de lead junto com o [AGENDAR_ADMIN:] na mesma resposta
      // (ex: quando o cliente confirma data/hora). O bloco deve ir ao admin, não ao cliente.
      const resumoLeadInScheduling = payload.clientPendingMessage
        .match(/\[RESUMO_LEAD\][\s\S]*?\[\/RESUMO_LEAD\]/)?.[0] ?? null;
      const agendamentoModuleForPendingMsg = getAgendamentoAdminModuleConfig(params.chatbotConfig?.modules ?? undefined);
      const clientMessage = (
        payload.clientPendingMessage
          .replace(/\[RESUMO_LEAD\][\s\S]*?\[\/RESUMO_LEAD\]/, "")
          .trim()
      ) || agendamentoModuleForPendingMsg?.clientPendingMessage || "Estou verificando a disponibilidade da equipe e te retorno em breve! ✅";

      await this.sendAutomatedTextMessage(
        params.tenantId,
        params.instance.id,
        params.remoteNumber,
        params.targetJid,
        clientMessage,
        { action: "scheduling_request_sent", kind: "chatbot" }
      );
      this.appendConversationHistory(params.session, "assistant", clientMessage);

      // Processa lead extraído da resposta de agendamento (se presente)
      if (resumoLeadInScheduling && !params.session.leadAlreadySent) {
        const leadsPhone = params.chatbotConfig?.leadsPhoneNumber;
        const leadsEnabled = params.chatbotConfig?.leadsEnabled ?? true;
        if (leadsPhone && leadsEnabled) {
          // Usa o número real do cliente; para @lid JIDs, usa conversationPhoneNumber como fallback
          const bestClientPhone =
            (looksLikeRealPhone(params.resolvedContactNumber) ? params.resolvedContactNumber : null) ??
            (looksLikeRealPhone(params.conversationPhoneNumber) ? params.conversationPhoneNumber : null) ??
            (looksLikeRealPhone(params.remoteNumber) ? params.remoteNumber : null) ??
            params.resolvedContactNumber;
          const normalizedLeadNumber = normalizePhoneNumber(bestClientPhone) ?? bestClientPhone;
          const normalizedResumeLead = resumoLeadInScheduling
            .replace(/\{\{\s*numero\s*\}\}/gi, normalizedLeadNumber)
            .replace(/^(Contato:\s*).*$/im, `$1${normalizedLeadNumber}`);

          const hashInput = [
            normalizedResumeLead.match(/^Nome:\s*(.+)$/im)?.[1]?.trim() ?? "",
            normalizedResumeLead.match(/^Servi[çc]o de interesse:\s*(.+)$/im)?.[1]?.trim() ?? "",
            params.resolvedContactNumber
          ].join("|");
          const hash = Buffer.from(hashInput).toString("base64").slice(0, 32);
          const dedupeKey = `leads:dedup:${params.instance.id}:${params.remoteNumber}:${hash}`;
          const jaEnviado = await this.redis.get(dedupeKey).catch(() => null);

          if (!jaEnviado) {
            await this.redis.set(dedupeKey, "1", "EX", 86400);
            const leadsJid = `${leadsPhone}@s.whatsapp.net`;
            await this.sendAutomatedTextMessage(
              params.tenantId,
              params.instance.id,
              leadsPhone,
              leadsJid,
              `🔔 Novo lead agendado:\n\n${normalizedResumeLead}`,
              { action: "lead_summary", kind: "chatbot" }
            );
            await this.markConversationLeadSent(prisma, params.conversationId, params.session);

            // Alerta de plataforma apenas quando o adminAlertPhone for diferente do leadsPhone
            const platformAdminPhone = platformConfig?.adminAlertPhone?.replace(/\D/g, "") ?? null;
            const leadsPhoneDigits = leadsPhone.replace(/\D/g, "");
            if (platformAdminPhone && platformAdminPhone !== leadsPhoneDigits) {
              await this.platformAlertService?.alertNewLead(
                params.tenantId,
                params.instance.name,
                normalizedResumeLead,
                params.resolvedContactNumber
              ).catch((err) => {
                console.error("[orchestrator] erro ao alertar novo lead (scheduling):", err);
              });
            }
          } else {
            console.log("[leads] resumo de scheduling duplicado ignorado");
          }
        }
      }

      return;
    }

    if (chatbotResult?.action === "ESCALATE_ADMIN") {
      if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
        return;
      }

      const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(params.chatbotConfig?.modules ?? undefined);
      const allowAprendizadoContinuoEscalation =
        aprendizadoContinuoModule?.isEnabled === true &&
        aprendizadoContinuoModule.verificationStatus === "VERIFIED";

      if (!allowAprendizadoContinuoEscalation) {
        const fallbackText =
          params.chatbotConfig?.fallbackMessage?.trim() ||
          "Nao consegui obter essa informacao agora. Posso te ajudar com outras duvidas.";
        await this.sendAutomatedTextMessage(
          params.tenantId,
          params.instance.id,
          params.remoteNumber,
          params.targetJid,
          fallbackText,
          { action: "escalate_admin_module_disabled", kind: "chatbot" }
        );
        this.appendConversationHistory(params.session, "assistant", fallbackText);
        return;
      }

      const pauseMessage = "Um momento, estou verificando essa informacao para voce \uD83D\uDD0D";
      await this.sendAutomatedTextMessage(
        params.tenantId,
        params.instance.id,
        params.remoteNumber,
        params.targetJid,
        pauseMessage,
        { action: "escalate_admin_pause", kind: "chatbot" }
      );
      this.appendConversationHistory(params.session, "assistant", pauseMessage);

      const adminPhone = this.resolveConfiguredPhone(
        aprendizadoContinuoModule?.verifiedPhone ?? null,
        ...(aprendizadoContinuoModule?.verifiedPhones ?? []),
        ...(aprendizadoContinuoModule?.additionalAdminPhones ?? []),
        params.chatbotConfig?.leadsPhoneNumber,
        platformConfig?.adminAlertPhone
      );
      if (!adminPhone) {
        console.warn("[escalation] adminPhone nao configurado, escalacao ignorada");
        const fallbackText = "Nao consegui obter essa informacao agora. Por favor, entre em contato com nossa equipe.";
        await this.sendAutomatedTextMessage(
          params.tenantId,
          params.instance.id,
          params.remoteNumber,
          params.targetJid,
          fallbackText,
          { action: "escalate_admin_missing_phone", kind: "chatbot" }
        );
        this.appendConversationHistory(params.session, "assistant", fallbackText);
        return;
      }

      // Formula uma pergunta contextualizada para o admin — em vez de enviar
      // a mensagem bruta do cliente ("Sim, quero fazer o site"), o bot analisa
      // o histórico e explica a dúvida real ao admin com contexto.
      const formulatedAdminQuestion = await this.chatbotService
        .formulateEscalationQuestionForAdmin(
          params.tenantId,
          params.instance.id,
          params.contactDisplayName,
          params.inputText,
          params.session.history
        )
        .catch((err) => {
          console.warn("[escalation] erro ao formular pergunta para admin, usando mensagem bruta:", err);
          return params.inputText;
        });

      console.log("[escalation] enviando pergunta ao admin", {
        instanceId: params.instance.id,
        conversationId: params.conversationId,
        adminPhone,
        formulatedAdminQuestion
      });

      const escalated = await this.escalationService.escalateToAdmin({
        tenantId: params.tenantId,
        instanceId: params.instance.id,
        conversationId: params.conversationId,
        clientJid: params.targetJid,
        clientQuestion: formulatedAdminQuestion,
        adminPhone
      });

      if (!escalated) {
        const fallbackText = "Nao consegui obter essa informacao agora. Por favor, entre em contato com nossa equipe.";
        await this.sendAutomatedTextMessage(
          params.tenantId,
          params.instance.id,
          params.remoteNumber,
          params.targetJid,
          fallbackText,
          { action: "escalate_admin_failed", kind: "chatbot" }
        );
        this.appendConversationHistory(params.session, "assistant", fallbackText);
      }
      return;
    }

    const rawResponse = chatbotResult?.responseText ?? null;

    if (!rawResponse) {
      if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
        return;
      }

      await this.memoryAgent.update({
        tenantId: params.tenantId,
        phoneNumber: params.resolvedContactNumber,
        clientMessage: params.inputText
      });
      return;
    }

    const resumoMatch = rawResponse.match(/\[RESUMO_LEAD\][\s\S]*?\[\/RESUMO_LEAD\]/);
    const resumoLead = resumoMatch ? resumoMatch[0] : null;
    const clientText = rawResponse.replace(/\[RESUMO_LEAD\][\s\S]*?\[\/RESUMO_LEAD\]/, "").trim();

    console.log("[chatbot] rawResponse:", rawResponse.slice(0, 300));
    console.log("[chatbot] resumoDetectado:", !!resumoLead);
    console.log("[chatbot] clientText:", clientText.slice(0, 300));

    if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
      return;
    }

    let leadData: LeadData | null = null;

    if (resumoLead) {
      const leadsPhone = params.chatbotConfig?.leadsPhoneNumber;
      const leadsEnabled = params.chatbotConfig?.leadsEnabled ?? true;

      const camposVerificacao = [
        {
          regex: /Nome:\s*(?!n[ãa]o informado|\(nome\))/i,
          pergunta: "Antes de confirmar, pode me dizer seu nome? 😊"
        },
        {
          regex: /Servi[çc]o de interesse:\s*(?!n[ãa]o informado)/i,
          pergunta: "Me conta o que você precisa — seria um app, sistema web ou automação? 🤔"
        },
        {
          regex: /Hor[áa]rio agendado:\s*(?!n[ãa]o informado|a confirmar)/i,
          pergunta: "Qual dia e horário ficaria melhor pra você para a reunião? 📅"
        }
      ];

      const campoFaltando = camposVerificacao.find((c) => !c.regex.test(resumoLead));
      const camposOk = !campoFaltando;

      if (!camposOk && campoFaltando) {
        console.log("[leads] RESUMO_LEAD incompleto, reforçando coleta:", campoFaltando.pergunta);
        const delayReforco = Math.floor(Math.random() * 500) + 1000;
        await new Promise((resolve) => setTimeout(resolve, delayReforco));
        await this.sendAutomatedTextMessage(
          params.tenantId,
          params.instance.id,
          params.remoteNumber,
          params.targetJid,
          campoFaltando.pergunta,
          { action: "lead_field_reinforcement", kind: "chatbot" }
        );
        this.appendConversationHistory(params.session, "assistant", campoFaltando.pergunta);
      }

      if (camposOk) {
        const nomeMatch = resumoLead.match(/Nome:\s*(.+)/i);
        const contatoMatch = resumoLead.match(/Contato:\s*(.+)/i);
        const emailMatch = resumoLead.match(/E-mail:\s*(.+)/i);
        const empresaMatch = resumoLead.match(/Empresa:\s*(.+)/i);
        const problemaMatch = resumoLead.match(/Problema:\s*(.+)/i);
        const servicoMatch = resumoLead.match(/Servi[çc]o de interesse:\s*(.+)/i);
        const horarioMatch = resumoLead.match(/Hor[áa]rio agendado:\s*(.+)/i);

        leadData = {
          rawSummary: resumoLead,
          name: nomeMatch ? nomeMatch[1].trim() : null,
          contact: contatoMatch ? contatoMatch[1].trim() : params.remoteNumber,
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
          params.resolvedContactNumber
        ].join("|");
        const hash = Buffer.from(hashInput).toString("base64").slice(0, 32);
        const dedupeKey = `leads:dedup:${params.instance.id}:${params.remoteNumber}:${hash}`;
        const jaEnviado = await this.redis.get(dedupeKey).catch(() => null);

        if (!jaEnviado) {
          await this.redis.set(dedupeKey, "1", "EX", 86400);

          // Normaliza o resumo antes de enviar: substitui {{numero}} pelo telefone real.
          // Para @lid JIDs, resolvedContactNumber pode ser dígitos do LID — usa fallbacks.
          const bestClientPhone =
            (looksLikeRealPhone(params.resolvedContactNumber) ? params.resolvedContactNumber : null) ??
            (looksLikeRealPhone(params.conversationPhoneNumber) ? params.conversationPhoneNumber : null) ??
            (looksLikeRealPhone(params.remoteNumber) ? params.remoteNumber : null) ??
            params.resolvedContactNumber;
          const normalizedLeadNumber = normalizePhoneNumber(bestClientPhone) ?? bestClientPhone;
          const normalizedResumeLead = resumoLead
            .replace(/\{\{\s*numero\s*\}\}/gi, normalizedLeadNumber)
            .replace(/^(Contato:\s*).*$/im, `$1${normalizedLeadNumber}`);

          const leadsJid = `${leadsPhone}@s.whatsapp.net`;
          await this.sendAutomatedTextMessage(
            params.tenantId,
            params.instance.id,
            leadsPhone,
            leadsJid,
            `🔔 Novo lead agendado:\n\n${normalizedResumeLead}`,
            { action: "lead_summary", kind: "chatbot" }
          );

          // Marca como enviado imediatamente após o envio direto ao leadsPhone
          await this.markConversationLeadSent(prisma, params.conversationId, params.session);

          // Alerta de plataforma: disparar SOMENTE se o adminAlertPhone da plataforma for
          // diferente do leadsPhone do tenant, para evitar duplicar a notificação para o
          // mesmo número quando o admin do tenant e o admin da plataforma são a mesma pessoa.
          const platformAdminPhone = platformConfig?.adminAlertPhone?.replace(/\D/g, "") ?? null;
          const leadsPhoneDigits = leadsPhone.replace(/\D/g, "");
          const isDifferentPhone = platformAdminPhone && platformAdminPhone !== leadsPhoneDigits;
          if (isDifferentPhone) {
            await this.platformAlertService?.alertNewLead(
              params.tenantId,
              params.instance.name,
              normalizedResumeLead,
              params.resolvedContactNumber
            ).catch((err) => {
              console.error("[orchestrator] erro ao alertar novo lead:", err);
            });
          }
        } else {
          console.log("[leads] resumo duplicado ignorado");
        }
      } else if (!leadData?.isComplete) {
        console.log("[leads] resumo incompleto, nao enviado:", resumoLead.slice(0, 100));
      }
    }

    await this.memoryAgent.update({
      tenantId: params.tenantId,
      phoneNumber: params.resolvedContactNumber,
      clientMessage: params.inputText,
      leadData
    });

    if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
      return;
    }

    if (leadData?.isComplete && (!params.chatbotConfig?.leadsPhoneNumber || params.chatbotConfig.leadsEnabled === false)) {
      this.emitLog(buildWorkerKey(params.tenantId, params.instance.id), {
        context: {
          instanceId: params.instance.id
        },
        instanceId: params.instance.id,
        level: "warn",
        message: "Resumo de lead gerado, mas leadsPhoneNumber nao configurado ou leadsEnabled=false",
        timestamp: new Date().toISOString()
      });
    }

    if (!clientText.trim()) {
      return;
    }

    if (await this.isConversationAiBlocked(prisma, params.conversationId)) {
      return;
    }

    const partes = splitBotResponse(clientText);
    for (let i = 0; i < partes.length; i++) {
      if (await this.isConversationAiBlocked(prisma, params.conversationId)) {
        return;
      }

      if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
        return;
      }

      const parte = partes[i]!;
      await this.sendAutomatedTextMessage(
        params.tenantId,
        params.instance.id,
        params.remoteNumber,
        params.targetJid,
        parte,
        { action: "conversation_agent", kind: "chatbot" }
      );
      this.appendConversationHistory(params.session, "assistant", parte);
      if (i < partes.length - 1) {
        const delayDigitacao = Math.floor(Math.random() * 1000) + 1500;
        await new Promise((resolve) => setTimeout(resolve, delayDigitacao));
      }
    }

    // Extrai e salva memória persistente do cliente (fire-and-forget)
    const memoriaModule = getMemoriaPersonalizadaModuleConfig(
      sanitizeChatbotModules(params.chatbotConfig?.modules)
    );
    if (memoriaModule?.isEnabled === true && memoriaModule.fields.length > 0) {
      void this.chatbotService.extractPersistentMemory(
        params.tenantId,
        params.instance.id,
        params.resolvedContactNumber,
        params.session.history
      ).catch((err) => {
        console.warn("[persistent-memory] erro no fire-and-forget:", err);
      });
    }

    const leadAutoExtractValue = params.chatbotConfig?.leadAutoExtract as unknown;
    const leadAutoExtractEnabled = leadAutoExtractValue === true || leadAutoExtractValue === "true";
    const responseText = clientText.replace(/\|\|\|/g, " ");
    const isClosing = /consultor|agendamento|em instantes|encaminhei|entrar.{0,20}contato/i.test(responseText ?? "");

    if (leadAutoExtractEnabled && isClosing && !params.session.leadAlreadySent) {
      await prisma.conversation.update({
        where: {
          id: params.conversationId
        },
        data: {
          awaitingLeadExtraction: true
        } as Prisma.ConversationUncheckedUpdateInput
      });

      void (async () => {
        try {
          const resolvedChatbotConfig = await this.chatbotService.getConfig(params.tenantId, params.instance.id);
          const senderRemoteJid =
            /@(s\.whatsapp\.net|c\.us)$/i.test(params.targetJid)
              ? params.targetJid
              : typeof params.contactFields?.sharedPhoneJid === "string" && params.contactFields.sharedPhoneJid.trim()
                ? params.contactFields.sharedPhoneJid.trim()
                : params.conversationPhoneNumber
                    ? toJid(params.conversationPhoneNumber)
                    : "";
          console.log("[lead:phone] source variable:", JSON.stringify(senderRemoteJid || params.targetJid));
          const senderPhone =
            String(senderRemoteJid ?? "")
              .replace(/@s\.whatsapp\.net$/i, "")
              .replace(/@c\.us$/i, "")
              .replace(/@.*$/, "")
              .replace(/\D/g, "");
          console.log("[lead:phone] passing to processLead:", JSON.stringify(senderPhone));
          await this.chatbotService.processLeadAfterConversation(
            params.conversationId,
            {
              ...resolvedChatbotConfig,
              __tenantId: params.tenantId
            },
            senderPhone
          );
        } catch (error) {
          console.error("[lead] erro na extraÃ§Ã£o:", error);
          await prisma.conversation.update({
            where: {
              id: params.conversationId
            },
            data: {
              awaitingLeadExtraction: false
            } as Prisma.ConversationUncheckedUpdateInput
          });
        }
      })();
    }
  }

  private async sendConversationWithDelay(params: {
    tenantId: string;
    instanceId: string;
    remoteNumber: string;
    targetJid: string;
    text: string;
    metadata: Record<string, unknown>;
    conversationId: string;
    session: ConversationSession;
    sessionGeneration: number;
  }): Promise<void> {
    const prisma = await this.tenantPrismaRegistry.getClient(params.tenantId);
    const responseParts = params.text
      .split("|||")
      .map((part) => part.trim())
      .filter(Boolean);

    if (responseParts.length === 0) {
      return;
    }

    for (const [index, responsePart] of responseParts.entries()) {
      if (await this.isConversationAiBlocked(prisma, params.conversationId)) {
        return;
      }

      if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
        return;
      }

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

        if (this.isSessionExecutionStale(params.session, params.sessionGeneration)) {
          return;
        }
      }
    }
  }

  /**
   * Versao publica de sendAutomatedTextMessage para uso em rotas externas.
   */
  public async sendAutomatedTextMessagePublic(
    tenantId: string,
    instanceId: string,
    remoteNumber: string,
    targetJid: string | undefined,
    text: string
  ): Promise<void> {
    await this.sendAutomatedTextMessage(tenantId, instanceId, remoteNumber, targetJid, text, { action: "admin_learning_reply", kind: "chatbot" });
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
    const automatedPayload: SendMessagePayload & { automation: Record<string, unknown> } = {
      type: "text",
      to: remoteNumber,
      targetJid,
      text,
      automation: { kind: "chatbot", ...metadata }
    };

    let rpcResult: Record<string, unknown>;
    try {
      rpcResult = await this.sendMessage(tenantId, instanceId, automatedPayload);
    } catch (err) {
      // Fila persistente: se o worker estiver indisponivel, enfileira para envio posterior
      if (
        err instanceof ApiError &&
        (err.publicCode === "WORKER_UNAVAILABLE" || err.publicCode === "INSTANCE_RPC_TIMEOUT") &&
        this.sendMessageQueue
      ) {
        const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
        const traceId = crypto.randomUUID();
        const queued = await prisma.message.create({
          data: {
            instanceId,
            remoteJid: targetJid ?? toJid(remoteNumber),
            direction: "OUTBOUND",
            type: "text",
            status: "QUEUED",
            payload: automatedPayload as unknown as Prisma.InputJsonValue,
            traceId,
            scheduledAt: null
          }
        });
        await this.sendMessageQueue.add(`chatbot-auto:${queued.id}`, {
          tenantId,
          instanceId,
          messageId: queued.id
        });
        console.warn("[chatbot] worker indisponivel, mensagem automatizada enfileirada:", queued.id);
        return;
      }
      throw err;
    }

    const externalMessageId = (rpcResult.externalMessageId as string | undefined) ?? null;
    this.rememberAutomatedOutboundEcho(instanceId, externalMessageId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const created = await prisma.message.create({
      data: {
        instanceId,
        remoteJid: (rpcResult.remoteJid as string | undefined) ?? targetJid ?? toJid(remoteNumber),
        externalMessageId,
        direction: "OUTBOUND",
        type: "text",
        status: "SENT",
        payload: automatedPayload as unknown as Prisma.InputJsonValue,
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
        externalMessageId,
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

