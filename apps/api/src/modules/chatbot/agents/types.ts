import type { ClientMemory } from "@infracode/types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
