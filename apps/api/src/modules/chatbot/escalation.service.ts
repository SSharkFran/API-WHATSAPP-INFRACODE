import type { Redis as IORedis } from "ioredis";
import type { TenantPrismaRegistry } from "../../lib/database.js";
import type { PlatformAlertService } from "../platform/alert.service.js";
import type { KnowledgeService } from "./knowledge.service.js";
import type { ChatbotService } from "./service.js";
import type { WebhookService } from "../webhooks/service.js";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";

interface EscalationServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
  platformAlertService?: PlatformAlertService;
  knowledgeService: KnowledgeService;
  redis?: IORedis;
  webhookService?: WebhookService;
}

interface PendingConfirmationEntry {
  tenantId: string;
  instanceId: string;
  question: string;
  synthesizedAnswer: string;
  rawAnswer: string;
  conversationId: string | null;
  adminJid: string;
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
  private readonly redis?: IORedis;
  private readonly webhookService?: WebhookService;
  private chatbotService?: ChatbotService;
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
  private readonly escalationRetryMap = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      ctx: EscalationContext;
    }
  >();
  /** PENDING_REVIEW: rastrea janela de 5 min para correcao pos-aprendizado */
  private readonly pendingCorrectionMap = new Map<
    string,
    {
      tenantId: string;
      instanceId: string;
      knowledgeId: string;
      question: string;
      answer: string;
      timer: NodeJS.Timeout;
    }
  >();
  /** Agendamento via Admin: rastrea solicitacao de disponibilidade enviada ao admin */
  private readonly pendingSchedulingMap = new Map<
    string, // key: `${instanceId}:${adminPhone}`
    {
      tenantId: string;
      instanceId: string;
      clientJid: string;
      clientName: string;
      assunto: string;
      dataPreferencia: string;
      timer: NodeJS.Timeout;
    }
  >();
  /** Agendamento via Admin: rastrea aguardo de preferencia de horario do cliente */
  private readonly pendingSchedulingClientPreferenceMap = new Map<
    string, // key: `${instanceId}:${clientPhone}`
    {
      tenantId: string;
      instanceId: string;
      adminPhone: string;
      adminJid: string;
      clientName: string;
      assunto: string;
      adminAvailability: string;
      timer: NodeJS.Timeout;
    }
  >();

  public constructor(deps: EscalationServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.knowledgeService = deps.knowledgeService;
    this.platformAlertService = deps.platformAlertService;
    this.redis = deps.redis;
    this.webhookService = deps.webhookService;
  }

  public setPlatformAlertService(service: PlatformAlertService): void {
    (this as unknown as { platformAlertService: PlatformAlertService }).platformAlertService = service;
  }

  public setChatbotService(service: ChatbotService): void {
    this.chatbotService = service;
  }

  public resolveConversationIdByAdminAlertMessage(messageId?: string | null): string | null {
    if (!messageId) {
      return null;
    }

    return this.adminAlertMessageMap.get(messageId)?.conversationId ?? null;
  }

  /**
   * RISCO-02: versao async que faz fallback ao Redis quando o mapa em memoria
   * nao contem o ID (ex: apos reinicializacao do processo).
   */
  public async resolveConversationIdByAdminAlertMessageAsync(
    messageId?: string | null
  ): Promise<string | null> {
    const inMemory = this.resolveConversationIdByAdminAlertMessage(messageId);
    if (inMemory || !messageId || !this.redis) return inMemory;
    const redisValue = await this.redis.get(`escalation:alert:msg:${messageId}`).catch(() => null);
    return redisValue ?? null;
  }

  public resolveConversationIdByAdminAlertChat(remoteJid?: string | null): string | null {
    for (const key of this.buildAdminAlertChatKeys(remoteJid)) {
      const resolved = this.adminAlertChatMap.get(key)?.conversationId ?? null;
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }

  public linkAdminAlertChatAlias(
    aliasRemoteJid?: string | null,
    canonicalRemoteJid?: string | null
  ): string | null {
    const resolvedConversationId =
      this.resolveConversationIdByAdminAlertChat(canonicalRemoteJid) ??
      this.resolveConversationIdByAdminAlertChat(aliasRemoteJid);

    if (!resolvedConversationId) {
      return null;
    }

    this.trackAdminAlertChat(aliasRemoteJid, resolvedConversationId);
    this.trackAdminAlertChat(canonicalRemoteJid, resolvedConversationId);

    return resolvedConversationId;
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
    const normalizedAdminPhone = ctx.adminPhone.replace(/\D/g, "");

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
      // Janela de 4 horas: se admin nao responder dentro deste TTL, a escalacao pode ser marcada
      // como sem resposta via recoverExpiredEscalations() na inicializacao do servidor.
      void this.redis?.set(
        `escalation:window:${ctx.instanceId}:${ctx.conversationId}`,
        "1",
        "EX", 14400 // 4 horas em segundos
      ).catch(() => null);
      this.scheduleEscalationRetry(ctx);
      const existingAdminContact = await prisma.contact.findUnique({
        where: {
          instanceId_phoneNumber: {
            instanceId: ctx.instanceId,
            phoneNumber: normalizedAdminPhone
          }
        },
        select: {
          fields: true
        }
      });
      const existingAdminContactFields =
        existingAdminContact?.fields && typeof existingAdminContact.fields === "object"
          ? (existingAdminContact.fields as Record<string, unknown>)
          : {};

      await prisma.contact.upsert({
        where: {
          instanceId_phoneNumber: {
            instanceId: ctx.instanceId,
            phoneNumber: normalizedAdminPhone
          }
        },
        update: {
          fields: {
            ...existingAdminContactFields,
            adminAlertPhone: true,
            lastRemoteJid: result.remoteJid ?? `${normalizedAdminPhone}@s.whatsapp.net`,
            sharedPhoneJid: `${normalizedAdminPhone}@s.whatsapp.net`
          } as Prisma.InputJsonValue
        },
        create: {
          instanceId: ctx.instanceId,
          phoneNumber: normalizedAdminPhone,
          displayName: "Admin",
          fields: {
            adminAlertPhone: true,
            lastRemoteJid: result.remoteJid ?? `${normalizedAdminPhone}@s.whatsapp.net`,
            sharedPhoneJid: `${normalizedAdminPhone}@s.whatsapp.net`
          } as Prisma.InputJsonValue
        }
      });
      await prisma.message.create({
        data: {
          instanceId: ctx.instanceId,
          remoteJid: result.remoteJid ?? `${normalizedAdminPhone}@s.whatsapp.net`,
          externalMessageId: result.externalMessageId,
          direction: "OUTBOUND",
          type: "text",
          status: "SENT",
          payload: {
            text: adminMessage,
            to: normalizedAdminPhone,
            automation: {
              kind: "chatbot",
              action: "admin_learning_prompt"
            }
          },
          traceId: ctx.conversationId,
          sentAt: new Date()
        }
      });

      return true;
    } catch (err) {
      console.error("[escalation] erro ao notificar admin:", err);
      await this.rollbackEscalationState(prisma, ctx);
      return false;
    }
  }

  /**
   * Normaliza input do admin para comparacao com "sim".
   * Remove acentos, converte para lowercase, faz trim.
   */
  private normalizeConfirmation(input: string): string {
    return input
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  }

  /**
   * Processa resposta do admin, aprende e retorna dados para responder o cliente.
   *
   * Implementa gate de confirmacao em duas fases (APR-02, APR-04):
   * - Fase 1: Admin envia resposta → sistema envia eco de confirmacao, NAO escreve no KB
   * - Fase 2: Admin responde "SIM" → sistema ingere no KB atomicamente via Redis DEL
   *
   * Retorna null se nao houver conversa pausada aguardando resposta, ou se a resposta
   * estiver aguardando confirmacao (Fase 1) ou for descartada (nao-SIM na Fase 2).
   */
  public async processAdminReply(
    tenantId: string,
    instanceId: string,
    adminRawAnswer: string,
    targetConversationId?: string | null,
    adminPhone?: string | null
  ): Promise<{
    clientJid: string;
    clientQuestion: string;
    formulatedAnswer: string;
    conversationId: string;
    savedKnowledgeId: string;
  } | null> {
    // ── Fase 2: verificar se ha confirmacao pendente para este admin ──────────
    if (this.redis && adminPhone) {
      const confirmationKey = `confirmation:${instanceId}:${adminPhone}`;
      const pending = await this.redis.get(confirmationKey).catch(() => null);
      if (pending) {
        const normalized = this.normalizeConfirmation(adminRawAnswer);
        if (normalized.startsWith("sim")) {
          // Atomico: DEL retorna 1 se a chave existia — previne dupla ingestao
          const deleted = await this.redis.del(confirmationKey).catch(() => 0);
          if (deleted === 1) {
            try {
              const entry: PendingConfirmationEntry = JSON.parse(pending);
              const savedKnowledge = await this.knowledgeService.save(
                entry.tenantId,
                entry.instanceId,
                entry.question,
                entry.synthesizedAnswer,
                entry.rawAnswer,
                entry.adminJid,
                new Date(),
                entry.adminJid
              );
              void this.webhookService?.enqueueEvent({
                tenantId: entry.tenantId,
                instanceId: entry.instanceId,
                eventType: "knowledge.learned",
                payload: {
                  id: savedKnowledge.id,
                  question: savedKnowledge.question,
                  answer: savedKnowledge.answer,
                  taughtBy: savedKnowledge.taughtBy,
                  createdAt: savedKnowledge.createdAt
                }
              }).catch(() => null);
              console.log(`[escalation] confirmacao SIM recebida — conhecimento salvo id=${savedKnowledge.id}`);
              // Envia confirmacao ao admin
              void this.platformAlertService?.sendTrackedInstanceAlert(
                entry.tenantId,
                entry.instanceId,
                adminPhone,
                "Conhecimento adicionado com sucesso!"
              ).catch(() => null);
            } catch (err) {
              console.error("[escalation] erro ao salvar conhecimento apos confirmacao SIM:", err);
            }
          } else {
            console.debug("[escalation] confirmacao SIM ignorada — chave ja processada (duplo evento Baileys)");
          }
        } else {
          console.debug(`[escalation] resposta admin descartada (nao-SIM: "${adminRawAnswer}") — aguardando confirmacao`);
        }
        // Sempre retorna null neste caminho — a Fase 2 nao produz um resultado de resposta ao cliente
        return null;
      }
    }

    // ── Fase 1: sem confirmacao pendente — processar como nova resposta a escalacao ──
    // Lock distribuído via Redis para garantir processamento atômico.
    // Evita duplicatas causadas por eventos duplicados do Baileys ou processamento paralelo.
    const lockKey = `escalation:reply-lock:${instanceId}:${targetConversationId ?? "any"}`;
    if (this.redis) {
      const acquired = await this.redis.set(lockKey, "1", "EX", 10, "NX");
      if (!acquired) {
        console.warn(`[escalation] processAdminReply ignorado — lock ativo para ${lockKey}`);
        return null;
      }
    }

    try {
      return await this._processAdminReplyInternal(tenantId, instanceId, adminRawAnswer, targetConversationId, adminPhone);
    } finally {
      if (this.redis) {
        await this.redis.del(lockKey).catch(() => null);
      }
    }
  }

  private async _processAdminReplyInternal(
    tenantId: string,
    instanceId: string,
    adminRawAnswer: string,
    targetConversationId?: string | null,
    adminPhone?: string | null
  ): Promise<{
    clientJid: string;
    clientQuestion: string;
    formulatedAnswer: string;
    conversationId: string;
    savedKnowledgeId: string;
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

    // Sintetiza pergunta-nucleo e resposta reformulada via IA antes de persistir
    const synthesized = this.chatbotService
      ? await this.chatbotService.synthesizeKnowledgeEntry(tenantId, instanceId, clientQuestion, adminRawAnswer).catch(() => ({
          question: clientQuestion,
          answer: adminRawAnswer
        }))
      : { question: clientQuestion, answer: adminRawAnswer };

    // ── Gate de confirmacao (APR-02, APR-04) ─────────────────────────────────
    // Fase 1: em vez de salvar imediatamente, armazena em Redis e envia eco ao admin.
    // A ingestao so ocorre quando admin responde "SIM" (Fase 2, tratada em processAdminReply).
    if (this.redis && adminPhone) {
      const adminJid = adminPhone.includes("@") ? adminPhone : `${adminPhone}@s.whatsapp.net`;
      const pendingEntry: PendingConfirmationEntry = {
        tenantId,
        instanceId,
        question: synthesized.question,
        synthesizedAnswer: synthesized.answer,
        rawAnswer: adminRawAnswer,
        conversationId: pausedConversation.pendingClientConversationId ?? pausedConversation.id,
        adminJid
      };
      const confirmationKey = `confirmation:${instanceId}:${adminPhone}`;
      await this.redis.set(
        confirmationKey,
        JSON.stringify(pendingEntry),
        "EX",
        600
      ).catch(() => null);

      // Envia eco de confirmacao ao admin
      const echoMessage = `Entendido: ${synthesized.answer}. Devo adicionar isso ao conhecimento do sistema? Responda SIM para confirmar.`;
      void this.platformAlertService?.sendTrackedInstanceAlert(
        tenantId,
        instanceId,
        adminPhone,
        echoMessage
      ).catch(() => null);

      console.log(`[escalation] resposta do admin recebida — aguardando confirmacao SIM (confirmation:${instanceId}:${adminPhone})`);

      // Retorna null — ingestao pendente de confirmacao
      return null;
    }

    // ── Caminho legado sem Redis: ingere diretamente (sem gate) ──────────────
    const savedKnowledge = await this.knowledgeService.save(
      tenantId,
      instanceId,
      synthesized.question,
      synthesized.answer,
      adminRawAnswer, // rawAnswer preserva o texto original do admin
      "admin"
    );

    void this.webhookService?.enqueueEvent({
      tenantId,
      instanceId,
      eventType: "knowledge.learned",
      payload: {
        id: savedKnowledge.id,
        question: savedKnowledge.question,
        answer: savedKnowledge.answer,
        taughtBy: savedKnowledge.taughtBy,
        createdAt: savedKnowledge.createdAt
      }
    }).catch(() => null);

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
      formulatedAnswer: synthesized.answer, // resposta reformulada e enviada ao cliente
      conversationId: pausedConversation.pendingClientConversationId ?? pausedConversation.id,
      savedKnowledgeId: savedKnowledge.id
    };
  }

  /**
   * Processa uma correcao de aprendizado enviada pelo admin.
   * Chamado quando o admin responde a uma mensagem de confirmacao "Aprendi e respondi"
   * para corrigir uma resposta aprendida incorretamente.
   */
  public async processAdminCorrection(
    tenantId: string,
    instanceId: string,
    originalQuestion: string,
    correctedAnswer: string
  ): Promise<void> {
    // Sintetiza a resposta de correcao do admin em linguagem profissional
    const synthesized = this.chatbotService
      ? await this.chatbotService.synthesizeKnowledgeEntry(tenantId, instanceId, originalQuestion, correctedAnswer).catch(() => ({
          question: originalQuestion,
          answer: correctedAnswer
        }))
      : { question: originalQuestion, answer: correctedAnswer };

    const savedKnowledge = await this.knowledgeService.save(
      tenantId,
      instanceId,
      synthesized.question,
      synthesized.answer,
      correctedAnswer, // rawAnswer preserva o texto original do admin
      "admin_correction"
    );

    void this.webhookService?.enqueueEvent({
      tenantId,
      instanceId,
      eventType: "knowledge.learned",
      payload: {
        id: savedKnowledge.id,
        question: savedKnowledge.question,
        answer: savedKnowledge.answer,
        taughtBy: savedKnowledge.taughtBy,
        createdAt: savedKnowledge.createdAt
      }
    }).catch(() => null);

    console.log(`[escalation] correcao de conhecimento registrada para: "${originalQuestion}"`);
  }

  /**
   * PENDING_REVIEW: abre uma janela de 5 min para o admin corrigir o conhecimento recem-aprendido.
   * Chamado pelo caller apos processAdminReply retornar com sucesso.
   */
  public trackPendingKnowledgeCorrection(
    instanceId: string,
    adminPhone: string,
    knowledgeId: string,
    tenantId: string,
    question: string,
    answer: string,
    windowMs = 5 * 60 * 1000
  ): void {
    const key = `${instanceId}:${adminPhone}`;
    const existing = this.pendingCorrectionMap.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      // Limpa Redis existente para evitar TTL desatualizado
      void this.redis?.del(`knowledge:pending_correction:${instanceId}:${adminPhone}`).catch(() => null);
    }

    const timer = setTimeout(() => {
      this.pendingCorrectionMap.delete(key);
    }, windowMs);

    timer.unref?.();
    this.pendingCorrectionMap.set(key, { tenantId, instanceId, knowledgeId, question, answer, timer });
    void this.redis?.set(
      `knowledge:pending_correction:${instanceId}:${adminPhone}`,
      JSON.stringify({ tenantId, instanceId, knowledgeId, question, answer }),
      "EX", Math.ceil(windowMs / 1000)
    ).catch(() => null);
  }

  /**
   * PENDING_REVIEW: consome a janela de correcao.
   * Se o admin enviou "ok"/"confirmar" → nada a fazer (ja salvo).
   * Qualquer outro texto → salva como correcao e dispara webhook.
   * Retorna true se uma correcao pendente foi encontrada e consumida.
   */
  public async consumePendingKnowledgeCorrection(
    instanceId: string,
    adminPhone: string,
    correctionText: string
  ): Promise<boolean> {
    const key = `${instanceId}:${adminPhone}`;
    const pending = this.pendingCorrectionMap.get(key);
    if (!pending) {
      // Fallback Redis (sobrevive a restarts)
      if (this.redis) {
        const redisKey = `knowledge:pending_correction:${instanceId}:${adminPhone}`;
        const raw = await this.redis.getdel(redisKey).catch(() => null);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { tenantId: string; instanceId: string; knowledgeId: string; question: string; answer: string };
            const normalized = correctionText.trim().toLowerCase().replace(/[^a-z]/g, "");
            const isConfirmation = ["ok", "sim", "confirmar", "confirma", "certo"].includes(normalized);
            if (!isConfirmation) {
              await this.processAdminCorrection(parsed.tenantId, parsed.instanceId, parsed.question, correctionText.trim());
            }
            return true;
          } catch {
            return false;
          }
        }
      }
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingCorrectionMap.delete(key);

    const normalized = correctionText.trim().toLowerCase().replace(/[^a-z]/g, "");
    const isConfirmation = ["ok", "sim", "confirmar", "confirma", "certo"].includes(normalized);

    if (!isConfirmation) {
      await this.processAdminCorrection(pending.tenantId, pending.instanceId, pending.question, correctionText.trim());
      console.log(`[escalation] correcao aplicada pelo admin para: "${pending.question}"`);
    } else {
      console.log(`[escalation] admin confirmou conhecimento sem correcao para: "${pending.question}"`);
    }

    return true;
  }

  /**
   * Registra uma solicitacao de agendamento pendente (aguardando resposta do admin).
   * TTL de 30 minutos.
   */
  public trackPendingSchedulingRequest(
    instanceId: string,
    adminPhone: string,
    tenantId: string,
    clientJid: string,
    clientName: string,
    assunto: string,
    dataPreferencia: string,
    windowMs = 30 * 60 * 1000
  ): void {
    const key = `${instanceId}:${adminPhone}`;
    const existing = this.pendingSchedulingMap.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pendingSchedulingMap.delete(key);
      void this.redis?.del(`scheduling:pending:${key}`).catch(() => null);
    }, windowMs);
    timer.unref?.();
    this.pendingSchedulingMap.set(key, { tenantId, instanceId, clientJid, clientName, assunto, dataPreferencia, timer });
    void this.redis?.set(
      `scheduling:pending:${key}`,
      JSON.stringify({ tenantId, instanceId, clientJid, clientName, assunto, dataPreferencia }),
      "PX",
      windowMs
    ).catch(() => null);
  }

  /**
   * Gera variantes do número de telefone para lidar com o 9º dígito brasileiro.
   * Alguns telefones são configurados sem o 9º dígito mas o JID real do WhatsApp tem.
   * Ex: "558499999999" → também tenta "5584999999999" (com 9) e vice-versa.
   */
  private buildPhoneKeyVariants(phone: string): string[] {
    const digits = phone.replace(/\D/g, "");
    if (!digits) return [];

    const variants = new Set<string>([digits]);

    // Sem código de país (BR = 55)
    const withoutCC = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
    variants.add(withoutCC);

    // Adiciona/remove 9º dígito para números BR (DDD + 9 + 8 dígitos = 11 sem CC)
    if (withoutCC.length === 11 && withoutCC[2] === "9") {
      // tem 9 → variante sem 9
      const without9 = `${withoutCC.slice(0, 2)}${withoutCC.slice(3)}`;
      variants.add(without9);
      variants.add(`55${without9}`);
    } else if (withoutCC.length === 10) {
      // não tem 9 → variante com 9
      const with9 = `${withoutCC.slice(0, 2)}9${withoutCC.slice(2)}`;
      variants.add(with9);
      variants.add(`55${with9}`);
    }

    // Garante variante com código de país
    if (!digits.startsWith("55") && digits.length <= 11) {
      variants.add(`55${digits}`);
    }

    return [...variants].filter(Boolean);
  }

  /**
   * Consome (remove) uma solicitacao de agendamento pendente para este admin.
   * Verifica mapa em memoria primeiro, depois Redis como fallback.
   * Tenta múltiplas variantes do telefone para lidar com 9º dígito brasileiro.
   */
  public async consumePendingSchedulingReply(
    instanceId: string,
    adminPhone: string
  ): Promise<{ tenantId: string; instanceId: string; clientJid: string; clientName: string; assunto: string; dataPreferencia: string } | null> {
    const phoneVariants = this.buildPhoneKeyVariants(adminPhone);

    // Tenta todas as variantes no mapa em memória primeiro
    for (const variant of phoneVariants) {
      const key = `${instanceId}:${variant}`;
      const inMemory = this.pendingSchedulingMap.get(key);
      if (inMemory) {
        clearTimeout(inMemory.timer);
        this.pendingSchedulingMap.delete(key);
        void this.redis?.del(`scheduling:pending:${key}`).catch(() => null);
        return inMemory;
      }
    }

    // Fallback Redis — tenta todas as variantes
    if (this.redis) {
      for (const variant of phoneVariants) {
        const key = `${instanceId}:${variant}`;
        const raw = await this.redis.getdel(`scheduling:pending:${key}`).catch(() => null);
        if (raw) {
          try {
            return JSON.parse(raw) as { tenantId: string; instanceId: string; clientJid: string; clientName: string; assunto: string; dataPreferencia: string };
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }

  /**
   * Registra que o bot aguarda a preferencia de horario do CLIENTE
   * apos o admin ter informado disponibilidade. TTL 30 minutos.
   */
  public trackPendingSchedulingClientPreference(
    instanceId: string,
    clientPhone: string,
    tenantId: string,
    adminPhone: string,
    adminJid: string,
    clientName: string,
    assunto: string,
    adminAvailability: string,
    windowMs = 30 * 60 * 1000
  ): void {
    const key = `${instanceId}:${clientPhone}`;
    const existing = this.pendingSchedulingClientPreferenceMap.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pendingSchedulingClientPreferenceMap.delete(key);
      void this.redis?.del(`scheduling:client_pref:${key}`).catch(() => null);
    }, windowMs);
    timer.unref?.();
    this.pendingSchedulingClientPreferenceMap.set(key, { tenantId, instanceId, adminPhone, adminJid, clientName, assunto, adminAvailability, timer });
    void this.redis?.set(
      `scheduling:client_pref:${key}`,
      JSON.stringify({ tenantId, instanceId, adminPhone, adminJid, clientName, assunto, adminAvailability }),
      "PX",
      windowMs
    ).catch(() => null);
  }

  /**
   * Consome a preferencia de horario pendente do cliente.
   * Verifica mapa em memoria primeiro, depois Redis como fallback.
   * Tenta múltiplas variantes do telefone para lidar com 9º dígito brasileiro.
   */
  public async consumePendingSchedulingClientPreference(
    instanceId: string,
    clientPhone: string
  ): Promise<{ tenantId: string; instanceId: string; adminPhone: string; adminJid: string; clientName: string; assunto: string; adminAvailability: string } | null> {
    const phoneVariants = this.buildPhoneKeyVariants(clientPhone);

    for (const variant of phoneVariants) {
      const key = `${instanceId}:${variant}`;
      const inMemory = this.pendingSchedulingClientPreferenceMap.get(key);
      if (inMemory) {
        clearTimeout(inMemory.timer);
        this.pendingSchedulingClientPreferenceMap.delete(key);
        void this.redis?.del(`scheduling:client_pref:${key}`).catch(() => null);
        return inMemory;
      }
    }

    if (this.redis) {
      for (const variant of phoneVariants) {
        const key = `${instanceId}:${variant}`;
        const raw = await this.redis.getdel(`scheduling:client_pref:${key}`).catch(() => null);
        if (raw) {
          try {
            return JSON.parse(raw) as { tenantId: string; instanceId: string; adminPhone: string; adminJid: string; clientName: string; assunto: string; adminAvailability: string };
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Lista todas as conversas pausadas aguardando resposta do admin.
   */
  public async listPendingEscalations(
    tenantId: string,
    instanceId: string
  ): Promise<Array<{ conversationId: string; clientJid: string; clientQuestion: string; waitingSince: string }>> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const records = await prisma.conversation.findMany({
      where: {
        instanceId,
        awaitingAdminResponse: true,
        pendingClientJid: { not: null },
        pendingClientQuestion: { not: null }
      },
      orderBy: { updatedAt: "asc" },
      select: { id: true, pendingClientJid: true, pendingClientQuestion: true, updatedAt: true }
    });
    return records.map((r) => ({
      conversationId: r.id,
      clientJid: r.pendingClientJid ?? "",
      clientQuestion: r.pendingClientQuestion ?? "",
      waitingSince: r.updatedAt.toISOString()
    }));
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

  /**
   * Retorna o numero de conversas pausadas aguardando resposta do admin.
   */
  public async countPendingEscalations(
    tenantId: string,
    instanceId: string
  ): Promise<number> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    return prisma.conversation.count({
      where: { instanceId, awaitingAdminResponse: true }
    });
  }

  /**
   * Retorna a conversa mais antiga aguardando resposta do admin sem modifica-la.
   * Util para avisar o admin qual cliente esta em fila antes de processar a resposta.
   */
  public async peekOldestPendingEscalation(
    tenantId: string,
    instanceId: string
  ): Promise<{ conversationId: string; clientJid: string; clientQuestion: string } | null> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const conv = await prisma.conversation.findFirst({
      where: {
        instanceId,
        awaitingAdminResponse: true,
        pendingClientJid: { not: null },
        pendingClientQuestion: { not: null }
      },
      orderBy: { updatedAt: "asc" },
      select: { id: true, pendingClientJid: true, pendingClientQuestion: true }
    });
    if (!conv?.pendingClientJid || !conv.pendingClientQuestion) return null;
    return {
      conversationId: conv.id,
      clientJid: conv.pendingClientJid,
      clientQuestion: conv.pendingClientQuestion
    };
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

  public async resolveConversationIdByPersistedAdminPrompt(
    tenantId: string,
    instanceId: string,
    remoteJids: Array<string | null | undefined>,
    candidatePhones: Array<string | null | undefined>
  ): Promise<string | null> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const normalizedRemoteJids = [...new Set(
      remoteJids
        .flatMap((remoteJid) => this.buildAdminAlertChatKeys(remoteJid))
        .filter(Boolean)
    )];
    const normalizedPhones = [...new Set(
      candidatePhones
        .map((phone) => phone?.replace(/\D/g, "") ?? "")
        .filter(Boolean)
    )];
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);

    if (normalizedRemoteJids.length > 0) {
      const byRemoteJid = await prisma.message.findFirst({
        where: {
          instanceId,
          direction: "OUTBOUND",
          createdAt: { gte: cutoff },
          remoteJid: { in: normalizedRemoteJids },
          payload: {
            path: ["automation", "action"],
            equals: "admin_learning_prompt"
          },
          traceId: { not: null }
        },
        orderBy: { createdAt: "desc" },
        select: { traceId: true }
      });

      if (byRemoteJid?.traceId) {
        return byRemoteJid.traceId;
      }
    }

    for (const phone of normalizedPhones) {
      const byPhone = await prisma.message.findFirst({
        where: {
          instanceId,
          direction: "OUTBOUND",
          createdAt: { gte: cutoff },
          AND: [
            {
              payload: {
                path: ["automation", "action"],
                equals: "admin_learning_prompt"
              }
            },
            {
              payload: {
                path: ["to"],
                equals: phone
              }
            }
          ],
          traceId: { not: null }
        },
        orderBy: { createdAt: "desc" },
        select: { traceId: true }
      });

      if (byPhone?.traceId) {
        return byPhone.traceId;
      }
    }

    return null;
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

      // RISCO-02: persiste no Redis para sobreviver a reinicializacoes (TTL 2h)
      void this.redis
        ?.set(`escalation:alert:msg:${messageId}`, conversationId, "EX", Math.floor(timeoutMs / 1000))
        .catch(() => null);
    }

    this.trackAdminAlertChat(remoteJid, conversationId, timeoutMs);
  }

  private trackAdminAlertChat(
    remoteJid: string | null | undefined,
    conversationId: string,
    timeoutMs = 2 * 60 * 60 * 1000
  ): void {
    for (const key of this.buildAdminAlertChatKeys(remoteJid)) {
      const existing = this.adminAlertChatMap.get(key);
      if (existing) {
        clearTimeout(existing.timeout);
      }

      const timeout = setTimeout(() => {
        this.adminAlertChatMap.delete(key);
      }, timeoutMs);

      timeout.unref?.();

      this.adminAlertChatMap.set(key, {
        conversationId,
        timeout
      });
    }
  }

  private buildAdminAlertChatKeys(remoteJid?: string | null): string[] {
    const trimmed = remoteJid?.trim();

    if (!trimmed) {
      return [];
    }

    const keys = new Set<string>([trimmed]);
    const withoutDevice = trimmed.replace(/:\d+(?=@)/, "");
    keys.add(withoutDevice);

    const localPart = withoutDevice.split("@")[0] ?? "";
    const digits = localPart.replace(/\D/g, "");

    if (digits) {
      keys.add(digits);
      keys.add(`${digits}@s.whatsapp.net`);
      keys.add(`${digits}@c.us`);
    }

    return [...keys];
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

    const retry = this.escalationRetryMap.get(conversationId);
    if (retry) {
      clearTimeout(retry.timer);
      this.escalationRetryMap.delete(conversationId);
    }
  }

  /**
   * Recupera escalacoes cujo TTL Redis de 4 horas expirou (Pitfall 3 — restart do servidor).
   * Marca as conversas como nao respondidas se a chave escalation:window nao existir mais.
   * Deve ser chamado na inicializacao do servico apos reconexao do Redis.
   */
  public async recoverExpiredEscalations(
    tenantId: string,
    instanceId: string
  ): Promise<number> {
    if (!this.redis) return 0;
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);

    const awaitingConversations = await prisma.conversation.findMany({
      where: { instanceId, awaitingAdminResponse: true },
      select: { id: true }
    });

    if (awaitingConversations.length === 0) return 0;

    let expiredCount = 0;
    for (const conv of awaitingConversations) {
      const windowKey = `escalation:window:${instanceId}:${conv.id}`;
      const exists = await this.redis.get(windowKey).catch(() => "1"); // assume alive on error
      if (!exists) {
        // Redis key expirou — janela de 4h ultrapassada sem resposta do admin
        await prisma.conversation.update({
          where: { id: conv.id },
          data: {
            awaitingAdminResponse: false,
            pendingClientQuestion: null,
            pendingClientJid: null,
            pendingClientConversationId: null
          }
        }).catch(() => null);
        expiredCount++;
        console.log(`[escalation] escalacao expirada (4h) marcada como sem resposta: ${conv.id}`);
      }
    }

    return expiredCount;
  }

  private scheduleEscalationRetry(ctx: EscalationContext, retryDelayMs = 10 * 60 * 1000): void {
    const existing = this.escalationRetryMap.get(ctx.conversationId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.escalationRetryMap.delete(ctx.conversationId);
      void this.sendEscalationReminder(ctx);
    }, retryDelayMs);

    timer.unref?.();
    this.escalationRetryMap.set(ctx.conversationId, { timer, ctx });
  }

  private async sendEscalationReminder(ctx: EscalationContext): Promise<void> {
    try {
      const prisma = await this.tenantPrismaRegistry.getClient(ctx.tenantId);
      const stillPending = await prisma.conversation.findFirst({
        where: { id: ctx.conversationId, awaitingAdminResponse: true },
        select: { id: true }
      });

      if (!stillPending) {
        return;
      }

      if (!this.platformAlertService) {
        return;
      }

      const reminderMessage = [
        "*[LEMBRETE] Aprendizado pendente*",
        "---------------",
        `Instancia: ${ctx.instanceId}`,
        "O cliente ainda aguarda resposta. Pergunta original:",
        `"${ctx.clientQuestion}"`,
        "",
        "Responda esta mensagem para eu aprender e responder o cliente automaticamente.",
        `ID: ${ctx.conversationId}`
      ].join("\n");

      const result = await this.platformAlertService.sendTrackedInstanceAlert(
        ctx.tenantId,
        ctx.instanceId,
        ctx.adminPhone,
        reminderMessage
      );

      if (result.delivered) {
        this.trackAdminAlertRouting(result.externalMessageId, result.remoteJid, ctx.conversationId);
        console.log(`[escalation] lembrete enviado ao admin para conversa ${ctx.conversationId}`);
      }
    } catch (err) {
      console.error("[escalation] erro ao enviar lembrete ao admin:", err);
    }
  }
}
