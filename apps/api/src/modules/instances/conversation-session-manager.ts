import type { ChatMessage, ConversationSession as BaseConversationSession } from "../chatbot/agents/types.js";
import type { TenantPrisma } from "../../lib/database.js";
import type { ChatbotModules } from "@infracode/types";
import type { Instance } from "../../../../../prisma/generated/tenant-client/index.js";

// ---------------------------------------------------------------------------
// SessionStatus
// ---------------------------------------------------------------------------

export const SessionStatus = {
  ATIVA: "ATIVA",
  AGUARDANDO_CLIENTE: "AGUARDANDO_CLIENTE",
  CONFIRMACAO_ENVIADA: "CONFIRMACAO_ENVIADA",
  INATIVA: "INATIVA",
  ENCERRADA: "ENCERRADA",
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

// ---------------------------------------------------------------------------
// ConversationSession interface (moved from service.ts)
// ---------------------------------------------------------------------------

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

export interface ConversationSession extends BaseConversationSession {
  pendingInputs: string[];
  pendingContext: PendingConversationTurnContext | null;
  debounceTimer: NodeJS.Timeout | null;
  isProcessing: boolean;
  flushAfterProcessing: boolean;
  resetGeneration: number;
  lastActivityAt: Date;
}

// ---------------------------------------------------------------------------
// ConversationSessionManager
// ---------------------------------------------------------------------------

export interface ConversationSessionManagerOptions {
  maxSessions?: number;
}

export class ConversationSessionManager {
  private readonly sessions = new Map<string, ConversationSession>();
  private gcInterval: NodeJS.Timeout | null = null;
  private readonly maxSessions: number;

  constructor(options?: ConversationSessionManagerOptions) {
    this.maxSessions = options?.maxSessions ?? 500;
  }

  // ---------------------------------------------------------------------------
  // Key building
  // ---------------------------------------------------------------------------

  buildKey(instanceId: string, remoteJid: string): string {
    return `${instanceId}:${remoteJid}`;
  }

  // ---------------------------------------------------------------------------
  // Session access
  // ---------------------------------------------------------------------------

  get(key: string): ConversationSession | undefined {
    return this.sessions.get(key);
  }

  set(key: string, session: ConversationSession): void {
    this.sessions.set(key, session);
    this.evictIfNeeded();
  }

  // ---------------------------------------------------------------------------
  // Session clearing
  // ---------------------------------------------------------------------------

  clear(key: string): void {
    const session = this.sessions.get(key);

    if (session?.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = null;
    }

    if (session) {
      session.pendingInputs = [];
      session.pendingContext = null;
      session.flushAfterProcessing = false;
      session.history = [];
      session.leadAlreadySent = false;
      session.resetGeneration += 1;
    }

    this.sessions.delete(key);
  }

  clearAll(): void {
    for (const [, session] of this.sessions.entries()) {
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
      }
    }
    this.sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // GC lifecycle
  // ---------------------------------------------------------------------------

  startGc(): void {
    this.gcInterval = setInterval(() => {
      const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000); // 4 horas de inatividade
      let evicted = 0;
      for (const [key, session] of this.sessions.entries()) {
        if (session.lastActivityAt < cutoff && !session.isProcessing && !session.debounceTimer) {
          this.sessions.delete(key);
          evicted++;
        }
      }
      if (evicted > 0) {
        console.log(`[session-manager][gc] ${evicted} sessao(es) inativa(s) removida(s) da memoria`);
      }
    }, 30 * 60 * 1000);
  }

  stopGc(): void {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Session creation (replaces getConversationSession from service.ts)
  // ---------------------------------------------------------------------------

  async getOrCreate(
    prisma: TenantPrisma,
    sessionKey: string,
    instanceId: string,
    remoteJid: string,
    leadAlreadySent: boolean,
    loadStoredHistory = true,
    inactivityMs: number | null = null
  ): Promise<ConversationSession> {
    const existingSession = this.sessions.get(sessionKey);

    if (existingSession) {
      existingSession.leadAlreadySent = existingSession.leadAlreadySent || leadAlreadySent;

      // Reset histórico se sessão está inativa há mais tempo do que o configurado
      if (inactivityMs != null && Date.now() - existingSession.lastActivityAt.getTime() > inactivityMs) {
        console.log(
          `[sessao-inatividade] sessao reiniciada por inatividade (${Math.round((Date.now() - existingSession.lastActivityAt.getTime()) / 3600000)}h)`,
          { instanceId, remoteJid }
        );
        existingSession.history = [];
        existingSession.lastActivityAt = new Date();
      }

      return existingSession;
    }

    if (!loadStoredHistory) {
      const session: ConversationSession = {
        history: [],
        leadAlreadySent,
        pendingInputs: [],
        pendingContext: null,
        debounceTimer: null,
        isProcessing: false,
        flushAfterProcessing: false,
        resetGeneration: 0,
        lastActivityAt: new Date()
      };

      this.set(sessionKey, session);
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
        payload: true,
        createdAt: true
      }
    });

    // Verifica se a última mensagem é antiga demais — se sim, não carrega histórico
    const mostRecentRecord = records[0];
    const isInactive =
      inactivityMs != null &&
      mostRecentRecord != null &&
      Date.now() - mostRecentRecord.createdAt.getTime() > inactivityMs;

    const history: ChatMessage[] = [];

    if (!isInactive) {
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
    } else {
      console.log(
        `[sessao-inatividade] histórico ignorado por inatividade (${Math.round((Date.now() - mostRecentRecord.createdAt.getTime()) / 3600000)}h)`,
        { instanceId, remoteJid }
      );
    }

    const session: ConversationSession = {
      history: history.slice(-20),
      leadAlreadySent,
      pendingInputs: [],
      pendingContext: null,
      debounceTimer: null,
      isProcessing: false,
      flushAfterProcessing: false,
      resetGeneration: 0,
      lastActivityAt: new Date()
    };

    this.set(sessionKey, session);

    return session;
  }

  // ---------------------------------------------------------------------------
  // LRU eviction (T-04-01-01, T-04-01-02)
  // ---------------------------------------------------------------------------

  private evictIfNeeded(): void {
    if (this.sessions.size <= this.maxSessions) {
      return;
    }

    // Find the oldest idle session (not processing, no pending debounce timer)
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, session] of this.sessions.entries()) {
      if (!session.isProcessing && !session.debounceTimer) {
        const t = session.lastActivityAt.getTime();
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = key;
        }
      }
    }

    if (oldestKey !== null) {
      // T-04-01-03: always clearTimeout before evicting to prevent orphaned timers
      const session = this.sessions.get(oldestKey);
      if (session?.debounceTimer) {
        clearTimeout(session.debounceTimer);
      }
      this.sessions.delete(oldestKey);
      console.debug(`[session-manager] evicted idle session ${oldestKey}`);
    } else {
      // T-04-01-01: warn when cap full but no evictable candidate
      console.warn(
        `[session-manager] session cap (${this.maxSessions}) exceeded but no idle session available to evict`
      );
    }
  }
}
