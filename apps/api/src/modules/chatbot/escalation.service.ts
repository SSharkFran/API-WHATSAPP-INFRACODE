import type { TenantPrismaRegistry } from "../../lib/database.js";
import type { PlatformAlertService } from "../platform/alert.service.js";
import type { KnowledgeService } from "./knowledge.service.js";

interface EscalationServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
  platformAlertService?: PlatformAlertService;
  knowledgeService: KnowledgeService;
}

interface EscalationContext {
  tenantId: string;
  instanceId: string;
  conversationId: string;
  clientJid: string;
  clientQuestion: string;
  adminPhone: string;
}

export class EscalationService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;
  private readonly knowledgeService: KnowledgeService;
  private readonly platformAlertService?: PlatformAlertService;
  private readonly adminAlertMessageMap = new Map<
    string,
    {
      conversationId: string;
      timeout: NodeJS.Timeout;
    }
  >();
  private readonly adminAlertChatMap = new Map<
    string,
    {
      conversationId: string;
      timeout: NodeJS.Timeout;
    }
  >();

  public constructor(deps: EscalationServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.knowledgeService = deps.knowledgeService;
    this.platformAlertService = deps.platformAlertService;
  }

  public setPlatformAlertService(service: PlatformAlertService): void {
    (this as unknown as { platformAlertService: PlatformAlertService }).platformAlertService = service;
  }

  public resolveConversationIdByAdminAlertMessage(messageId?: string | null): string | null {
    if (!messageId) {
      return null;
    }

    return this.adminAlertMessageMap.get(messageId)?.conversationId ?? null;
  }

  public resolveConversationIdByAdminAlertChat(remoteJid?: string | null): string | null {
    if (!remoteJid?.trim()) {
      return null;
    }

    return this.adminAlertChatMap.get(remoteJid.trim())?.conversationId ?? null;
  }

  /**
   * Pausa a conversa do cliente e envia a pergunta para o admin aprender.
   */
  public async escalateToAdmin(ctx: EscalationContext): Promise<boolean> {
    const prisma = await this.tenantPrismaRegistry.getClient(ctx.tenantId);

    const recentEscalation = await prisma.conversation.findFirst({
      where: {
        instanceId: ctx.instanceId,
        id: ctx.conversationId,
        awaitingAdminResponse: true,
        updatedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) }
      },
      select: { id: true }
    });

    if (recentEscalation) {
      console.log("[escalation] anti-flood: a conversa ja foi escalada recentemente");
      return false;
    }

    await prisma.conversation.updateMany({
      where: {
        instanceId: ctx.instanceId,
        id: ctx.conversationId
      },
      data: {
        awaitingAdminResponse: true,
        pendingClientQuestion: ctx.clientQuestion,
        pendingClientJid: ctx.clientJid,
        pendingClientConversationId: ctx.conversationId
      }
    });

    const adminMessage = [
      "*Aprendizado necessario*",
      "---------------",
      `Instancia: ${ctx.instanceId}`,
      "Cliente perguntou:",
      `"${ctx.clientQuestion}"`,
      "",
      "Responda esta mensagem para eu aprender e responder o cliente automaticamente.",
      `ID: ${ctx.conversationId}`
    ].join("\n");

    try {
      if (!this.platformAlertService) {
        console.warn("[escalation] platformAlertService indisponivel");
        await this.rollbackEscalationState(prisma, ctx);
        return false;
      }

      const result = await this.platformAlertService.sendTrackedInstanceAlert(
        ctx.tenantId,
        ctx.instanceId,
        ctx.adminPhone,
        adminMessage
      );

      if (!result.delivered) {
        console.warn("[escalation] falha ao entregar pergunta ao admin");
        await this.rollbackEscalationState(prisma, ctx);
        return false;
      }

      this.trackAdminAlertRouting(result.externalMessageId, result.remoteJid, ctx.conversationId);

      return true;
    } catch (err) {
      console.error("[escalation] erro ao notificar admin:", err);
      await this.rollbackEscalationState(prisma, ctx);
      return false;
    }
  }

  /**
   * Processa resposta do admin, aprende e retorna dados para responder o cliente.
   * Retorna null se nao houver conversa pausada aguardando resposta.
   */
  public async processAdminReply(
    tenantId: string,
    instanceId: string,
    adminRawAnswer: string,
    targetConversationId?: string | null
  ): Promise<{
    clientJid: string;
    clientQuestion: string;
    formulatedAnswer: string;
    conversationId: string;
  } | null> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);

    const pausedConversation = await prisma.conversation.findFirst({
      where: {
        instanceId,
        ...(targetConversationId?.trim()
          ? {
              id: targetConversationId.trim()
            }
          : {}),
        awaitingAdminResponse: true,
        pendingClientJid: { not: null },
        pendingClientQuestion: { not: null }
      },
      orderBy: { updatedAt: "asc" },
      select: {
        id: true,
        pendingClientConversationId: true,
        pendingClientJid: true,
        pendingClientQuestion: true
      }
    });

    if (!pausedConversation?.pendingClientJid || !pausedConversation.pendingClientQuestion) {
      return null;
    }

    const clientQuestion = pausedConversation.pendingClientQuestion;
    const clientJid = pausedConversation.pendingClientJid;

    await this.knowledgeService.save(
      tenantId,
      instanceId,
      clientQuestion,
      adminRawAnswer,
      adminRawAnswer,
      "admin"
    );

    await prisma.conversation.update({
      where: { id: pausedConversation.id },
      data: {
        awaitingAdminResponse: false,
        pendingClientQuestion: null,
        pendingClientJid: null,
        pendingClientConversationId: null
      }
    });
    this.clearTrackedAdminAlertForConversation(pausedConversation.id);

    console.log(
      `[escalation] admin respondeu para conversa ${pausedConversation.id}, cliente: ${clientJid}`
    );

    return {
      clientJid,
      clientQuestion,
      formulatedAnswer: adminRawAnswer,
      conversationId: pausedConversation.pendingClientConversationId ?? pausedConversation.id
    };
  }

  /**
   * Verifica se uma instancia tem conversas aguardando resposta do admin.
   */
  public async hasPendingEscalations(
    tenantId: string,
    instanceId: string
  ): Promise<boolean> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const count = await prisma.conversation.count({
      where: { instanceId, awaitingAdminResponse: true }
    });
    return count > 0;
  }

  public async releaseTimedOutEscalations(
    tenantId: string,
    instanceId: string,
    timeoutMinutes = 30
  ): Promise<number> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

    const result = await prisma.conversation.updateMany({
      where: {
        instanceId,
        awaitingAdminResponse: true,
        updatedAt: { lt: cutoff }
      },
      data: {
        awaitingAdminResponse: false,
        pendingClientQuestion: null,
        pendingClientJid: null,
        pendingClientConversationId: null
      }
    });

    if (result.count > 0) {
      console.log(`[escalation] ${result.count} escalacoes expiradas liberadas`);
    }

    return result.count;
  }

  private async rollbackEscalationState(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    ctx: EscalationContext
  ): Promise<void> {
    await prisma.conversation.updateMany({
      where: {
        instanceId: ctx.instanceId,
        id: ctx.conversationId
      },
      data: {
        awaitingAdminResponse: false,
        pendingClientQuestion: null,
        pendingClientJid: null,
        pendingClientConversationId: null
      }
    });
    this.clearTrackedAdminAlertForConversation(ctx.conversationId);
  }

  private trackAdminAlertRouting(
    messageId: string | null,
    remoteJid: string | null,
    conversationId: string
  ): void {
    const timeoutMs = 2 * 60 * 60 * 1000;

    if (messageId) {
      const existing = this.adminAlertMessageMap.get(messageId);
      if (existing) {
        clearTimeout(existing.timeout);
      }

      const timeout = setTimeout(() => {
        this.adminAlertMessageMap.delete(messageId);
      }, timeoutMs);

      timeout.unref?.();

      this.adminAlertMessageMap.set(messageId, {
        conversationId,
        timeout
      });
    }

    if (remoteJid?.trim()) {
      const normalizedRemoteJid = remoteJid.trim();
      const existing = this.adminAlertChatMap.get(normalizedRemoteJid);
      if (existing) {
        clearTimeout(existing.timeout);
      }

      const timeout = setTimeout(() => {
        this.adminAlertChatMap.delete(normalizedRemoteJid);
      }, timeoutMs);

      timeout.unref?.();

      this.adminAlertChatMap.set(normalizedRemoteJid, {
        conversationId,
        timeout
      });
    }
  }

  private clearTrackedAdminAlertForConversation(conversationId: string): void {
    for (const [messageId, entry] of this.adminAlertMessageMap.entries()) {
      if (entry.conversationId === conversationId) {
        clearTimeout(entry.timeout);
        this.adminAlertMessageMap.delete(messageId);
      }
    }

    for (const [remoteJid, entry] of this.adminAlertChatMap.entries()) {
      if (entry.conversationId === conversationId) {
        clearTimeout(entry.timeout);
        this.adminAlertChatMap.delete(remoteJid);
      }
    }
  }
}
