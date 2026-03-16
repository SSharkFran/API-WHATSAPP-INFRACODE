import type { ChatbotAiProvider, ChatbotConfig, ChatbotRule, ChatbotSimulationResult } from "@infracode/types";
import { z } from "zod";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { decrypt } from "../../lib/crypto.js";
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

interface ManagedAiProviderRuntime {
  provider: ChatbotAiProvider | null;
  baseUrl: string;
  model: string;
  isActive: boolean;
  isConfigured: boolean;
  apiKeyEncrypted: string | null;
}

const chatbotRulesArraySchema = z.array(chatbotRuleSchema);
const chatbotAiSettingsSchema = chatbotAiConfigSchema.pick({
  isEnabled: true,
  mode: true,
  systemPrompt: true,
  temperature: true,
  maxContextMessages: true
});
const chatbotAiUpsertSchema = upsertChatbotAiBodySchema;
const defaultAiSettings = {
  isEnabled: false,
  mode: "RULES_THEN_AI",
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
 * Gerencia o chatbot basico por instancia, com regras textuais e IA gerenciada pela InfraCode.
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
    const { prisma, managedAiProvider } = await this.getContext(tenantId, instanceId);
    const rules = chatbotRulesArraySchema.parse(input.rules);
    const aiInput = chatbotAiUpsertSchema.parse(input.ai ?? defaultAiSettings);

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
        aiApiKeyEncrypted: null
      } as Prisma.ChatbotConfigUncheckedCreateInput,
      update: {
        isEnabled: input.isEnabled,
        welcomeMessage: input.welcomeMessage?.trim() || null,
        fallbackMessage: input.fallbackMessage?.trim() || null,
        rules,
        aiSettings: this.buildPersistedAiSettings(aiInput),
        aiApiKeyEncrypted: null
      } as Prisma.ChatbotConfigUncheckedUpdateInput
    });

    return this.mapConfig(record, managedAiProvider);
  }

  public async simulate(
    tenantId: string,
    instanceId: string,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult> {
    const { config, managedAiProvider, prisma } = await this.getContext(tenantId, instanceId);
    return this.evaluateConfig(prisma, config, managedAiProvider, input);
  }

  public async evaluateInbound(
    tenantId: string,
    instanceId: string,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult | null> {
    const { config, managedAiProvider, prisma } = await this.getContext(tenantId, instanceId);

    if (!config.isEnabled) {
      return null;
    }

    const result = await this.evaluateConfig(prisma, config, managedAiProvider, input);
    return result.action === "NO_MATCH" ? null : result;
  }

  private async getContext(tenantId: string, instanceId: string): Promise<{
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>;
    config: ChatbotConfig;
    managedAiProvider: ManagedAiProviderRuntime;
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

    const [record, managedAiProvider] = await Promise.all([
      prisma.chatbotConfig.findUnique({
        where: {
          instanceId
        }
      }),
      this.getManagedAiProvider(tenantId)
    ]);

    return {
      prisma,
      managedAiProvider,
      config: record
        ? this.mapConfig(record, managedAiProvider)
        : {
            id: `chatbot-${instanceId}`,
            instanceId,
            isEnabled: false,
            welcomeMessage: null,
            fallbackMessage: null,
            rules: [],
            ai: this.buildRuntimeAiConfig(defaultAiSettings, managedAiProvider),
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString()
          }
    };
  }

  private async getManagedAiProvider(tenantId: string): Promise<ManagedAiProviderRuntime> {
    const record = (await (this.platformPrisma as any).tenantAiProvider.findUnique({
      where: {
        tenantId
      }
    })) as
      | {
          provider: ChatbotAiProvider;
          baseUrl: string;
          model: string;
          isActive: boolean;
          apiKeyEncrypted: string;
        }
      | null;

    if (!record) {
      return {
        provider: null,
        baseUrl: "",
        model: "",
        isActive: false,
        isConfigured: false,
        apiKeyEncrypted: null
      };
    }

    return {
      provider: record.provider as ChatbotAiProvider,
      baseUrl: record.baseUrl,
      model: record.model,
      isActive: record.isActive,
      isConfigured: Boolean(record.apiKeyEncrypted && record.model.trim()),
      apiKeyEncrypted: record.apiKeyEncrypted
    };
  }

  private async evaluateConfig(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    config: ChatbotConfig,
    managedAiProvider: ManagedAiProviderRuntime,
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

    const aiResult = await this.evaluateWithAi(prisma, config, managedAiProvider, input);

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

  private mapConfig(
    record: {
      id: string;
      instanceId: string;
      isEnabled: boolean;
      welcomeMessage: string | null;
      fallbackMessage: string | null;
      rules: unknown;
      aiSettings?: unknown;
      createdAt: Date;
      updatedAt: Date;
    },
    managedAiProvider: ManagedAiProviderRuntime
  ): ChatbotConfig {
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
      ai: this.buildRuntimeAiConfig(aiSettings, managedAiProvider),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }

  private buildRuntimeAiConfig(
    aiSettings: z.infer<typeof chatbotAiSettingsSchema>,
    managedAiProvider: ManagedAiProviderRuntime
  ): ChatbotConfig["ai"] {
    return {
      ...aiSettings,
      provider: managedAiProvider.provider,
      model: managedAiProvider.model,
      isManagedByAdmin: true,
      isProviderConfigured: managedAiProvider.isConfigured,
      isProviderActive: managedAiProvider.isActive
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
    managedAiProvider: ManagedAiProviderRuntime,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult | null> {
    if (config.ai.mode === "RULES_ONLY") {
      return null;
    }

    if (!config.ai.isEnabled || !input.text?.trim()) {
      return null;
    }

    if (
      !managedAiProvider.isConfigured ||
      !managedAiProvider.isActive ||
      !managedAiProvider.provider ||
      !managedAiProvider.model.trim() ||
      !managedAiProvider.apiKeyEncrypted
    ) {
      return null;
    }

    try {
      const apiKey = decrypt(managedAiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);
      const conversation = await this.buildAiConversation(
        prisma,
        config.instanceId,
        input,
        config.ai.systemPrompt,
        config.ai.maxContextMessages
      );
      const responseText = await this.requestOpenAiCompatibleCompletion(
        managedAiProvider,
        apiKey,
        conversation,
        config.ai.temperature
      );

      if (!responseText) {
        return null;
      }

      return {
        action: "AI",
        matchedRuleId: null,
        matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}`,
        responseText
      };
    } catch (err) {
      console.error("[chatbot:ai] erro:", err);
      return null;
    }
  }

  private async buildAiConversation(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    instanceId: string,
    input: ChatbotRuntimeInput,
    systemPrompt: string,
    maxContextMessages: number
  ): Promise<{
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }> {
    const system = [
      systemPrompt.trim() || defaultAiSettings.systemPrompt,
      `Data atual: ${formatDate(new Date())} ${formatTime(new Date())}.`,
      `Nome do contato: ${input.contactName?.trim() || "cliente"}.`,
      `Numero: ${normalizePhoneNumber(input.phoneNumber)}.`,
      "Se nao souber algo factual da empresa, admita a limitacao e ofereca transferir para humano.",
      "Evite respostas longas. Responda em 1 a 4 frases."
    ].join("\n");

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

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
    }

    const currentInput = input.text?.trim();

    if (currentInput) {
      const normalizedCurrentInput = normalizeText(currentInput);

      while (messages.length > 0) {
        const lastMessage = messages.at(-1);

        if (
          !lastMessage ||
          lastMessage.role !== "user" ||
          normalizeText(lastMessage.content) !== normalizedCurrentInput
        ) {
          break;
        }

        messages.pop();
      }

      messages.push({
        role: "user",
        content: currentInput
      });
    }

    return {
      system,
      messages
    };
  }

  private async requestOpenAiCompatibleCompletion(
    managedAiProvider: ManagedAiProviderRuntime,
    apiKey: string,
    conversation: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    },
    temperature: number
  ): Promise<string | null> {
    const provider = managedAiProvider.provider as string | null;
    const baseUrl = managedAiProvider.baseUrl.endsWith("/") ? managedAiProvider.baseUrl : `${managedAiProvider.baseUrl}/`;
    const isAnthropic = provider === "ANTHROPIC";
    const response = await fetch(new URL(isAnthropic ? "v1/messages" : "chat/completions", baseUrl).toString(), {
      method: "POST",
      headers: isAnthropic
        ? {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          }
        : {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
      body: JSON.stringify(
        isAnthropic
          ? {
              model: managedAiProvider.model,
              system: conversation.system,
              messages: conversation.messages,
              max_tokens: 300,
              temperature
            }
          : {
              model: managedAiProvider.model,
              system: conversation.system,
              messages: conversation.messages,
              temperature,
              max_tokens: 300
            }
      )
    });

    if (!response.ok) {
      throw new Error(`IA indisponivel: ${response.status}`);
    }

    if (isAnthropic) {
      const json = (await response.json()) as {
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      };
      const firstTextBlock = Array.isArray(json.content)
        ? json.content.find((item) => item.type === "text" && typeof item.text === "string")
        : null;

      if (firstTextBlock?.text) {
        return firstTextBlock.text.trim() || null;
      }

      return null;
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
