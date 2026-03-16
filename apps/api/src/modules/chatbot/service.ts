import type { ChatbotAiConfig, ChatbotConfig, ChatbotRule, ChatbotSimulationResult } from "@infracode/types";
import { z } from "zod";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { ApiError } from "../../lib/errors.js";
import { normalizePhoneNumber } from "../../lib/phone.js";
import { chatbotAiConfigSchema, chatbotRuleSchema, upsertChatbotAiBodySchema } from "./schemas.js";

interface ChatbotServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
}

interface ChatbotRuntimeInput {
  text?: string | null;
  isFirstContact: boolean;
  contactName?: string | null;
  phoneNumber: string;
  remoteJid?: string | null;
}

const chatbotRulesArraySchema = z.array(chatbotRuleSchema);
const chatbotAiSettingsSchema = chatbotAiConfigSchema.omit({
  hasApiKey: true
});
const chatbotAiUpsertSchema = upsertChatbotAiBodySchema;
const defaultAiSettings = {
  isEnabled: false,
  mode: "RULES_THEN_AI",
  provider: "OPENAI_COMPATIBLE",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  systemPrompt:
    "Voce e um assistente virtual comercial no WhatsApp. Responda sempre em portugues do Brasil, com clareza, objetividade e tom profissional.",
  temperature: 0.4,
  maxContextMessages: 12
} as const;

const formatDate = (date: Date): string =>
  new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);

const formatTime = (date: Date): string =>
  new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);

const normalizeText = (value: string): string => value.normalize("NFKC").trim().toLowerCase();

const matchesRule = (rule: ChatbotRule, normalizedInput: string, isFirstContact: boolean): boolean => {
  if (!rule.isActive) {
    return false;
  }

  if (rule.triggerType === "FIRST_CONTACT") {
    return isFirstContact;
  }

  if (!normalizedInput) {
    return false;
  }

  const matchValue = normalizeText(rule.matchValue ?? "");

  if (!matchValue) {
    return false;
  }

  switch (rule.triggerType) {
    case "EXACT":
      return normalizedInput === matchValue;
    case "CONTAINS":
      return normalizedInput.includes(matchValue);
    case "REGEX":
      try {
        return new RegExp(rule.matchValue ?? "", "i").test(normalizedInput);
      } catch {
        return false;
      }
  }
};

const renderReplyTemplate = (
  template: string,
  input: {
    contactName?: string | null;
    phoneNumber: string;
    text?: string | null;
  }
): string => {
  const now = new Date();
  const variables: Record<string, string> = {
    nome: input.contactName?.trim() || "cliente",
    numero: normalizePhoneNumber(input.phoneNumber),
    data: formatDate(now),
    hora: formatTime(now),
    input: input.text?.trim() ?? ""
  };

  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => variables[key] ?? "");
};

/**
 * Gerencia o chatbot basico por instancia, com regras textuais e simulacao.
 */
export class ChatbotService {
  private readonly config: AppConfig;
  private readonly platformPrisma: PlatformPrisma;
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;

  public constructor(deps: ChatbotServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
  }

  public async getConfig(tenantId: string, instanceId: string): Promise<ChatbotConfig> {
    const { config } = await this.getContext(tenantId, instanceId);
    return config;
  }

  public async upsertConfig(
    tenantId: string,
    instanceId: string,
    input: {
      isEnabled: boolean;
      welcomeMessage?: string | null;
      fallbackMessage?: string | null;
      rules: ChatbotRule[];
      ai?: z.infer<typeof chatbotAiUpsertSchema>;
    }
  ): Promise<ChatbotConfig> {
    const { prisma } = await this.getContext(tenantId, instanceId);
    const rules = chatbotRulesArraySchema.parse(input.rules);
    const aiInput = chatbotAiUpsertSchema.parse(input.ai ?? defaultAiSettings);
    const current = (await prisma.chatbotConfig.findUnique({
      where: {
        instanceId
      }
    })) as ({ aiApiKeyEncrypted?: string | null } & Record<string, unknown>) | null;
    const encryptedApiKey =
      aiInput.apiKey && aiInput.apiKey.trim()
        ? encrypt(aiInput.apiKey.trim(), this.config.API_ENCRYPTION_KEY)
        : current?.aiApiKeyEncrypted ?? null;

    const record = await prisma.chatbotConfig.upsert({
      where: {
        instanceId
      },
      create: {
        instanceId,
        isEnabled: input.isEnabled,
        welcomeMessage: input.welcomeMessage?.trim() || null,
        fallbackMessage: input.fallbackMessage?.trim() || null,
        rules,
        aiSettings: this.buildPersistedAiSettings(aiInput),
        aiApiKeyEncrypted: encryptedApiKey
      } as Prisma.ChatbotConfigUncheckedCreateInput,
      update: {
        isEnabled: input.isEnabled,
        welcomeMessage: input.welcomeMessage?.trim() || null,
        fallbackMessage: input.fallbackMessage?.trim() || null,
        rules,
        aiSettings: this.buildPersistedAiSettings(aiInput),
        aiApiKeyEncrypted: encryptedApiKey
      } as Prisma.ChatbotConfigUncheckedUpdateInput
    });

    return this.mapConfig(record);
  }

  public async simulate(
    tenantId: string,
    instanceId: string,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult> {
    const { config, prisma } = await this.getContext(tenantId, instanceId);
    return this.evaluateConfig(prisma, config, input);
  }

  public async evaluateInbound(
    tenantId: string,
    instanceId: string,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult | null> {
    const { config, prisma } = await this.getContext(tenantId, instanceId);

    if (!config.isEnabled) {
      return null;
    }

    const result = await this.evaluateConfig(prisma, config, input);
    return result.action === "NO_MATCH" ? null : result;
  }

  private async getContext(tenantId: string, instanceId: string): Promise<{
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>;
    config: ChatbotConfig;
  }> {
    await this.tenantPrismaRegistry.ensureSchema(this.platformPrisma, tenantId);
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const instance = await prisma.instance.findUnique({
      where: {
        id: instanceId
      }
    });

    if (!instance) {
      throw new ApiError(404, "INSTANCE_NOT_FOUND", "Instancia nao encontrada");
    }

    const record = await prisma.chatbotConfig.findUnique({
      where: {
        instanceId
      }
    });

    return {
      prisma,
      config: record
        ? this.mapConfig(record)
        : {
            id: `chatbot-${instanceId}`,
            instanceId,
            isEnabled: false,
            welcomeMessage: null,
            fallbackMessage: null,
            rules: [],
            ai: {
              ...defaultAiSettings,
              hasApiKey: false
            },
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString()
          }
    };
  }

  private async evaluateConfig(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    config: ChatbotConfig,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult> {
    const normalizedInput = normalizeText(input.text ?? "");

    if (input.isFirstContact && config.welcomeMessage?.trim()) {
      return {
        action: "WELCOME",
        matchedRuleId: null,
        matchedRuleName: "Mensagem de boas-vindas",
        responseText: renderReplyTemplate(config.welcomeMessage, input)
      };
    }

    if (config.ai.mode !== "AI_ONLY") {
      for (const rule of config.rules) {
        if (!matchesRule(rule, normalizedInput, input.isFirstContact)) {
          continue;
        }

        return {
          action: "MATCHED",
          matchedRuleId: rule.id,
          matchedRuleName: rule.name,
          responseText: renderReplyTemplate(rule.responseText, input)
        };
      }
    }

    const aiResult = await this.evaluateWithAi(prisma, config, input);

    if (aiResult) {
      return aiResult;
    }

    if (normalizedInput && config.fallbackMessage?.trim()) {
      return {
        action: "FALLBACK",
        matchedRuleId: null,
        matchedRuleName: "Fallback",
        responseText: renderReplyTemplate(config.fallbackMessage, input)
      };
    }

    return {
      action: "NO_MATCH",
      matchedRuleId: null,
      matchedRuleName: null,
      responseText: null
    };
  }

  private mapConfig(record: {
    id: string;
    instanceId: string;
    isEnabled: boolean;
    welcomeMessage: string | null;
    fallbackMessage: string | null;
    rules: unknown;
    aiSettings?: unknown;
    aiApiKeyEncrypted?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ChatbotConfig {
    const aiSettings = chatbotAiSettingsSchema.parse({
      ...defaultAiSettings,
      ...(record.aiSettings && typeof record.aiSettings === "object" ? record.aiSettings : {})
    });

    return {
      id: record.id,
      instanceId: record.instanceId,
      isEnabled: record.isEnabled,
      welcomeMessage: record.welcomeMessage,
      fallbackMessage: record.fallbackMessage,
      rules: chatbotRulesArraySchema.parse(record.rules),
      ai: {
        ...aiSettings,
        hasApiKey: Boolean(record.aiApiKeyEncrypted)
      },
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }

  private buildPersistedAiSettings(input: z.infer<typeof chatbotAiUpsertSchema>): Prisma.InputJsonValue {
    const parsed = chatbotAiSettingsSchema.parse({
      ...defaultAiSettings,
      ...input
    });

    return parsed as unknown as Prisma.InputJsonValue;
  }

  private async evaluateWithAi(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    config: ChatbotConfig,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult | null> {
    if (config.ai.mode === "RULES_ONLY") {
      return null;
    }

    if (!config.ai.isEnabled) {
      return null;
    }

    if (!input.text?.trim()) {
      return null;
    }

    const record = (await prisma.chatbotConfig.findUnique({
      where: {
        instanceId: config.instanceId
      }
    })) as ({
      aiApiKeyEncrypted?: string | null;
      aiSettings?: unknown;
    } & Record<string, unknown>) | null;

    if (!record?.aiApiKeyEncrypted || !record.aiSettings) {
      return null;
    }

    const aiSettings = chatbotAiSettingsSchema.parse({
      ...defaultAiSettings,
      ...(typeof record.aiSettings === "object" && record.aiSettings ? record.aiSettings : {})
    });

    if (!aiSettings.isEnabled || !aiSettings.model.trim()) {
      return null;
    }

    try {
      const apiKey = decrypt(record.aiApiKeyEncrypted, this.config.API_ENCRYPTION_KEY);
      const messages = await this.buildAiMessages(prisma, config.instanceId, input, aiSettings.systemPrompt, aiSettings.maxContextMessages);
      const responseText = await this.requestOpenAiCompatibleCompletion(aiSettings, apiKey, messages);

      if (!responseText) {
        return null;
      }

      return {
        action: "AI",
        matchedRuleId: null,
        matchedRuleName: `${aiSettings.provider}:${aiSettings.model}`,
        responseText
      };
    } catch {
      return null;
    }
  }

  private async buildAiMessages(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    instanceId: string,
    input: ChatbotRuntimeInput,
    systemPrompt: string,
    maxContextMessages: number
  ): Promise<Array<{ role: "system" | "user" | "assistant"; content: string }>> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      {
        role: "system",
        content: [
          systemPrompt.trim() || defaultAiSettings.systemPrompt,
          `Data atual: ${formatDate(new Date())} ${formatTime(new Date())}.`,
          `Nome do contato: ${input.contactName?.trim() || "cliente"}.`,
          `Numero: ${normalizePhoneNumber(input.phoneNumber)}.`,
          "Se nao souber algo factual da empresa, admita a limitacao e ofereca transferir para humano.",
          "Evite respostas longas. Responda em 1 a 4 frases."
        ].join("\n")
      }
    ];

    if (input.remoteJid) {
      const history = await prisma.message.findMany({
        where: {
          instanceId,
          remoteJid: input.remoteJid
        },
        orderBy: {
          createdAt: "desc"
        },
        take: maxContextMessages
      });

      for (const item of [...history].reverse()) {
        const payload = item.payload as Record<string, unknown>;
        const text = typeof payload.text === "string" ? payload.text.trim() : "";

        if (!text) {
          continue;
        }

        messages.push({
          role: item.direction === "INBOUND" ? "user" : "assistant",
          content: text
        });
      }
    } else if (input.text?.trim()) {
      messages.push({
        role: "user",
        content: input.text.trim()
      });
    }

    return messages;
  }

  private async requestOpenAiCompatibleCompletion(
    aiSettings: Omit<ChatbotAiConfig, "hasApiKey">,
    apiKey: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  ): Promise<string | null> {
    const baseUrl = aiSettings.baseUrl.endsWith("/") ? aiSettings.baseUrl : `${aiSettings.baseUrl}/`;
    const response = await fetch(new URL("chat/completions", baseUrl).toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: aiSettings.model,
        messages,
        temperature: aiSettings.temperature
      })
    });

    if (!response.ok) {
      throw new Error(`IA indisponivel: ${response.status}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };

    const content = json.choices?.[0]?.message?.content;

    if (typeof content === "string") {
      return content.trim() || null;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .join("\n")
        .trim();
    }

    return null;
  }
}
