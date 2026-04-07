import type { ClientMemory, ChatbotModules } from "@infracode/types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Sub-agent types
// ---------------------------------------------------------------------------

/** Função de chamada de IA injetada pelo service — encapsula provider, chave e fallback */
export type AiCaller = (
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  opts?: {
    temperature?: number;
    /** Sobrescreve o modelo configurado. Útil para usar um modelo leve no router. */
    model?: string;
  }
) => Promise<string | null>;

/** Intenções detectadas pelo IntentRouter */
export type ChatIntent = "GENERAL" | "FAQ" | "ESCALATE" | "SCHEDULE" | "HANDOFF";

export interface RouterResult {
  intent: ChatIntent;
  confidence: number;
}

/** Blocos de contexto pré-montados pelo service e reusados por cada sub-agent */
export interface ContextBlocks {
  globalSystemPrompt: string;
  baseSystemPrompt: string;
  memoryMd: string;
  clientContext: string;
  knowledge: string;
  persistentMemory: string;
  phoneNumber: string;
  currentDateLine: string;
}

/** Contexto compartilhado passado para todos os sub-agents */
export interface AgentContext {
  tenantId: string;
  instanceId: string;
  isFirstContact: boolean;
  /** Histórico completo já montado (inclui a mensagem atual do cliente ao final) */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  blocks: ContextBlocks;
  modules: ChatbotModules | undefined;
  allowAdminEscalation: boolean;
  callAi: AiCaller;
}

export interface ConversationSession {
  history: ChatMessage[];
  leadAlreadySent: boolean;
}

export interface LeadData {
  rawSummary: string;
  name: string | null;
  contact: string;
  email: string | null;
  companyName: string | null;
  problemDescription: string | null;
  serviceInterest: string | null;
  scheduledText: string | null;
  scheduledAt: Date | null;
  isComplete: boolean;
}

export interface MemoryContextResult {
  memory: ClientMemory | null;
  contextString: string;
}
