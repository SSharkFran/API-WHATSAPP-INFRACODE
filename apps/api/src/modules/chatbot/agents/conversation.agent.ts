import type { ChatbotSimulationResult } from "@infracode/types";
import type { ChatbotService } from "../service.js";
import type { ChatMessage } from "./types.js";

interface ConversationAgentDeps {
  chatbotService: ChatbotService;
}

export class ConversationAgent {
  private readonly chatbotService: ChatbotService;

  public constructor(deps: ConversationAgentDeps) {
    this.chatbotService = deps.chatbotService;
  }

  public async reply(params: {
    tenantId: string;
    instanceId: string;
    message: string;
    history?: ChatMessage[];
    clientContext: string;
    systemPrompt?: string;
    currentDate?: string;
    isFirstContact: boolean;
    contactName?: string | null;
    phoneNumber: string;
    remoteJid?: string | null;
  }): Promise<ChatbotSimulationResult | null> {
    return this.chatbotService.evaluateInbound(params.tenantId, params.instanceId, {
      text: params.message,
      isFirstContact: params.isFirstContact,
      contactName: params.contactName ?? undefined,
      phoneNumber: params.phoneNumber,
      remoteJid: params.remoteJid,
      clientContext: params.clientContext
    });
  }
}
