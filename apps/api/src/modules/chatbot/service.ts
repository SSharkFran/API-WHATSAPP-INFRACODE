import type { ChatbotAiProvider, ChatbotConfig, ChatbotModules, ChatbotRule, ChatbotSimulationResult } from "@infracode/types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { decrypt } from "../../lib/crypto.js";
import { ApiError } from "../../lib/errors.js";
import { assertValidPhoneNumber, normalizePhoneNumber } from "../../lib/phone.js";
import { chatbotAiConfigSchema, chatbotRuleSchema, googleCalendarModuleSchema, upsertChatbotAiBodySchema } from "./schemas.js";
import { GoogleCalendarTool } from "./tools/google-calendar.tool.js";
import type { PlatformAlertService } from "../platform/alert.service.js";

interface ChatbotServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
  platformAlertService?: PlatformAlertService;
}

interface ChatbotRuntimeInput {
  text?: string | null;
  isFirstContact: boolean;
  contactName?: string | null;
  phoneNumber: string;
  remoteJid?: string | null;
  clientContext?: string | null;
}

interface ManagedAiProviderRuntime {
  provider: ChatbotAiProvider | null;
  baseUrl: string;
  model: string;
  isActive: boolean;
  isConfigured: boolean;
  apiKeyEncrypted: string | null;
}

interface OpenAiToolCall {
  id: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

type OpenAiCompatibleMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAiToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      name: string;
      content: string;
    };

interface ChatbotToolRuntime {
  definitions: Array<{
    type: "function";
    function: {
      name: "checkAvailability" | "createEvent";
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  googleCalendar: GoogleCalendarTool;
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
  private readonly platformAlertService?: PlatformAlertService;

  public constructor(deps: ChatbotServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.platformAlertService = deps.platformAlertService;
  }

  public setPlatformAlertService(service: PlatformAlertService): void {
    (this as unknown as { platformAlertService: PlatformAlertService }).platformAlertService = service;
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
      leadsPhoneNumber?: string | null;
      leadsEnabled?: boolean;
      fiadoEnabled?: boolean;
      aiFallbackProvider?: string | null;
      aiFallbackApiKey?: string | null;
      aiFallbackModel?: string | null;
      modules?: ChatbotModules;
    }
  ): Promise<ChatbotConfig> {
    const { prisma, managedAiProvider } = await this.getContext(tenantId, instanceId);
    const rules = chatbotRulesArraySchema.parse(input.rules);
    const aiInput = chatbotAiUpsertSchema.parse(input.ai ?? defaultAiSettings);
    const leadsPhoneNumberRaw = input.leadsPhoneNumber?.trim() ?? null;
    const normalizedLeadsPhoneNumber = leadsPhoneNumberRaw ? normalizePhoneNumber(leadsPhoneNumberRaw) : null;

    if (leadsPhoneNumberRaw && normalizedLeadsPhoneNumber) {
      assertValidPhoneNumber(normalizedLeadsPhoneNumber);
    }

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
        aiApiKeyEncrypted: null,
        leadsPhoneNumber: normalizedLeadsPhoneNumber,
        leadsEnabled: input.leadsEnabled ?? true,
        fiadoEnabled: input.fiadoEnabled ?? false,
        aiFallbackProvider: input.aiFallbackProvider ?? null,
        aiFallbackApiKey: input.aiFallbackApiKey?.trim() || null,
        aiFallbackModel: input.aiFallbackModel?.trim() || null,
        modules: (input.modules ?? {}) as unknown as Prisma.InputJsonValue
      } as Prisma.ChatbotConfigUncheckedCreateInput,
      update: {
        isEnabled: input.isEnabled,
        welcomeMessage: input.welcomeMessage?.trim() || null,
        fallbackMessage: input.fallbackMessage?.trim() || null,
        rules,
        aiSettings: this.buildPersistedAiSettings(aiInput),
        aiApiKeyEncrypted: null,
        leadsPhoneNumber: normalizedLeadsPhoneNumber,
        leadsEnabled: input.leadsEnabled ?? true,
        fiadoEnabled: input.fiadoEnabled ?? false,
        aiFallbackProvider: input.aiFallbackProvider ?? null,
        aiFallbackApiKey: input.aiFallbackApiKey?.trim() || null,
        aiFallbackModel: input.aiFallbackModel?.trim() || null,
        modules: (input.modules ?? {}) as unknown as Prisma.InputJsonValue
      } as Prisma.ChatbotConfigUncheckedUpdateInput
    });

    return this.mapConfig(record, managedAiProvider);
  }

  public async setLeadsPhoneNumber(
    tenantId: string,
    instanceId: string,
    phoneNumber: string
  ): Promise<ChatbotConfig> {
    const { prisma, managedAiProvider } = await this.getContext(tenantId, instanceId);
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    assertValidPhoneNumber(normalizedPhoneNumber);

    const record = await prisma.chatbotConfig.upsert({
      where: {
        instanceId
      },
      create: {
        instanceId,
        isEnabled: false,
        welcomeMessage: null,
        fallbackMessage: null,
        rules: [] as Prisma.InputJsonValue,
        aiSettings: this.buildPersistedAiSettings(defaultAiSettings),
        aiApiKeyEncrypted: null,
        leadsPhoneNumber: normalizedPhoneNumber
      } as Prisma.ChatbotConfigUncheckedCreateInput,
      update: {
        leadsPhoneNumber: normalizedPhoneNumber
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
    return this.evaluateConfig(tenantId, prisma, config, managedAiProvider, input);
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

    const result = await this.evaluateConfig(tenantId, prisma, config, managedAiProvider, input);
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
        leadsGroupJid: null,
        leadsGroupName: null,
        leadsPhoneNumber: null,
        leadsEnabled: true,
        fiadoEnabled: false,
        rules: [],
            ai: this.buildRuntimeAiConfig(defaultAiSettings, managedAiProvider),
            aiFallbackProvider: null,
            aiFallbackApiKey: null,
            aiFallbackModel: null,
            modules: {},
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString()
          }
    };
  }

  private async getManagedAiProvider(tenantId: string): Promise<ManagedAiProviderRuntime> {
    const record = await this.platformPrisma.tenantAiProvider.findUnique({
      where: {
        tenantId
      }
    });

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
    tenantId: string,
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

    const aiResult = await this.evaluateWithAi(tenantId, prisma, config, managedAiProvider, input);

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
      leadsGroupJid?: string | null;
      leadsGroupName?: string | null;
      leadsPhoneNumber?: string | null;
      leadsEnabled?: boolean | null;
      fiadoEnabled?: boolean | null;
      rules: unknown;
      aiSettings?: unknown;
      createdAt: Date;
      updatedAt: Date;
      aiFallbackProvider?: string | null;
      aiFallbackApiKey?: string | null;
      aiFallbackModel?: string | null;
      modules?: unknown;
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
      leadsGroupJid: record.leadsGroupJid ?? null,
      leadsGroupName: record.leadsGroupName ?? null,
      leadsPhoneNumber: record.leadsPhoneNumber ?? null,
      leadsEnabled: record.leadsEnabled ?? true,
      fiadoEnabled: record.fiadoEnabled ?? false,
      rules: chatbotRulesArraySchema.parse(record.rules),
      ai: this.buildRuntimeAiConfig(aiSettings, managedAiProvider),
      aiFallbackProvider: record.aiFallbackProvider ?? null,
      aiFallbackApiKey: record.aiFallbackApiKey ?? null,
      aiFallbackModel: record.aiFallbackModel ?? null,
      modules: (record.modules && typeof record.modules === "object" ? record.modules : {}) as ChatbotModules,
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
    tenantId: string,
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    config: ChatbotConfig,
    managedAiProvider: ManagedAiProviderRuntime,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult | null> {
    if (config.ai.mode === "RULES_ONLY") {
      return null;
    }

    if (!input.text?.trim()) {
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
      let toolRuntime: ChatbotToolRuntime | undefined;
      const googleCalendarConfigResult = googleCalendarModuleSchema.safeParse(config.modules?.googleCalendar);

      if (googleCalendarConfigResult.success && googleCalendarConfigResult.data.isEnabled) {
        toolRuntime = {
          googleCalendar: new GoogleCalendarTool(googleCalendarConfigResult.data),
          definitions: [
            {
              type: "function",
              function: {
                name: "checkAvailability",
                description: "Consulta horarios disponiveis no Google Calendar para uma data especifica.",
                parameters: {
                  type: "object",
                  properties: {
                    date: {
                      type: "string",
                      description: "Data no formato YYYY-MM-DD para consultar disponibilidade."
                    }
                  },
                  required: ["date"],
                  additionalProperties: false
                }
              }
            },
            {
              type: "function",
              function: {
                name: "createEvent",
                description: "Cria um evento de agendamento confirmado no Google Calendar.",
                parameters: {
                  type: "object",
                  properties: {
                    summary: {
                      type: "string",
                      description: "Titulo do evento."
                    },
                    description: {
                      type: "string",
                      description: "Descricao detalhada do agendamento."
                    },
                    startDateTime: {
                      type: "string",
                      description: "Data/hora inicial em formato ISO 8601."
                    },
                    endDateTime: {
                      type: "string",
                      description: "Data/hora final em formato ISO 8601."
                    }
                  },
                  required: ["summary", "description", "startDateTime", "endDateTime"],
                  additionalProperties: false
                }
              }
            }
          ]
        };
      }

      const responseText = await this.callAiWithFallback(
        tenantId,
        managedAiProvider,
        apiKey,
        conversation,
        config.ai.temperature,
        config,
        toolRuntime
      );

      if (!responseText) {
        return null;
      }

      const isHandoff = /\[TRANSBORDO_HUMANO\]/i.test(responseText);
      const cleanedText = responseText.replace(/\[TRANSBORDO_HUMANO\]/gi, "").trim();

      return {
        action: isHandoff ? "HUMAN_HANDOFF" : "AI",
        matchedRuleId: null,
        matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}`,
        responseText: cleanedText
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
    const normalizedPhoneNumber = normalizePhoneNumber(input.phoneNumber);
    const systemParts = [
      systemPrompt.trim() || defaultAiSettings.systemPrompt,
      `Data atual: ${formatDate(new Date())} ${formatTime(new Date())}.`,
      `Nome do perfil: ${input.contactName?.trim() || "cliente"}.`,
      `Numero exato do cliente: ${normalizedPhoneNumber}.`,
      "### REGRAS GERAIS ###",
      "1. Responda em 1 a 3 frases no maximo. Seja direto.",
      '2. O cliente dita o nome: Se ele disser "me chamo X", use X e ignore o Nome do perfil.',
      "### GATILHOS DE ATENDIMENTO E AGENDAMENTO ###",
      "Voce deve conduzir a conversa dependendo do que ja foi respondido. Siga as condicoes abaixo:",
      'CONDICAO 1 - ANTES DE AGENDAR: Se voce ja entendeu o problema do cliente, mas ainda nao tem o e-mail dele, pergunte: "Qual o melhor e-mail para contato? (Pode deixar em branco se preferir so o WhatsApp)". Nao sugira horario ainda.',
      "CONDICAO 2 - PROPOR DATA: Se voce ja tem (ou o cliente recusou dar) o e-mail, pergunte o melhor dia e horario para a reuniao.",
      'CONDICAO 3 - CONFIRMAR DATA: Quando o cliente sugerir um dia/horario, calcule a data exata e confirme (Ex: "Ficaria para o dia DD/MM/AAAA as HH:00h, certo?"). PARE A MENSAGEM AI.',
      "### GATILHO FINAL: GERACAO DO LEAD (OBRIGATORIO) ###",
      'SE (e somente se) o cliente confirmar a data/hora exata com "sim", "certo", "fechado" ou equivalente, VOCE DEVE OBRIGATORIAMENTE finalizar a conversa imprimindo o bloco abaixo preenchido:',
      "[RESUMO_LEAD]\n" +
        "Nome: {nome do cliente}\n" +
        `Contato: ${normalizedPhoneNumber}\n` +
        "E-mail: {e-mail informado ou 'nao informado'}\n" +
        "Empresa: {empresa se citada ou 'nao informado'}\n" +
        "Problema: {resumo do problema}\n" +
        "Servico de interesse: {servico}\n" +
        "Horario agendado: {data e hora confirmada}\n" +
        "[/RESUMO_LEAD]",
      'ATENCAO MAXIMA: Sem este bloco o sistema quebra. Nunca esqueca de imprimi-lo apos o "sim" do cliente.'
    ];

    const memoryFilePath = join(this.config.DATA_DIR, "instances", instanceId, "memory.md");
    try {
      const memoryContent = await readFile(memoryFilePath, "utf-8");
      if (memoryContent.trim()) {
        systemParts.push(`\n--- CONTEXTO LOCAL (memory.md) ---\n${memoryContent.trim()}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (input.clientContext?.trim()) {
      systemParts.push(input.clientContext.trim());
    }

    const system = systemParts.join("\n");

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
        take: maxContextMessages,
        select: {
          direction: true,
          payload: true
        }
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

        if (!lastMessage || lastMessage.role !== "user" || normalizeText(lastMessage.content) !== normalizedCurrentInput) {
          break;
        }

        messages.pop();
      }

      messages.push({
        role: "user",
        content: currentInput
      });
    }

    messages.unshift(
      {
        role: "user",
        content: "Quero criar um app para minha empresa, pode me ajudar?"
      },
      {
        role: "assistant",
        content:
          "Claro, pode contar! Antes de tudo, como posso te chamar?\n\n" +
          "|||Enquanto isso me conta: e para empresa ou uso pessoal?"
      }
    );

    return {
      system,
      messages
    };
  }

  private async callAiWithFallback(
    tenantId: string,
    managedAiProvider: ManagedAiProviderRuntime,
    apiKey: string,
    conversation: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    },
    temperature: number,
    config: ChatbotConfig,
    toolRuntime?: ChatbotToolRuntime
  ): Promise<string | null> {
    try {
      return await this.requestOpenAiCompatibleCompletion(
        managedAiProvider,
        apiKey,
        conversation,
        temperature,
        toolRuntime
      );
    } catch (err: unknown) {
      const fetchErr = err as { status?: number; statusCode?: number; message?: string };
      const status = fetchErr?.status ?? fetchErr?.statusCode;
      const isRateLimit = status === 429;
      const isServerError = status !== undefined && status >= 500;

      if (
        (isRateLimit || isServerError) &&
        config.aiFallbackProvider &&
        (config.aiFallbackProvider === "ollama" || config.aiFallbackApiKey)
      ) {
        console.warn(
          `[chatbot:ai] Groq falhou (${status}), tentando fallback: ${config.aiFallbackProvider}`
        );
        await this.notifyAdminFallback(tenantId, config, status ?? 0);
        return this.callFallbackProvider(
          config.aiFallbackProvider,
          config.aiFallbackApiKey ?? "",
          config.aiFallbackModel ?? undefined,
          conversation,
          temperature
        );
      }

      throw err;
    }
  }

  private async callFallbackProvider(
    provider: string,
    apiKey: string,
    model: string | undefined,
    conversation: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    },
    temperature: number
  ): Promise<string | null> {
    const messagesWithSystem = [
      { role: "system" as const, content: conversation.system },
      ...conversation.messages
    ];

    if (provider === "openai") {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model ?? "gpt-4o-mini",
          messages: messagesWithSystem,
          temperature,
          max_tokens: 500
        })
      });
      if (!response.ok) {
        throw new Error(`OpenAI fallback error ${response.status}`);
      }
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content?.trim() ?? null;
    }

    if (provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: model ?? "claude-haiku-4-5-20251001",
          max_tokens: 500,
          system: conversation.system,
          messages: conversation.messages,
          temperature
        })
      });
      if (!response.ok) {
        throw new Error(`Anthropic fallback error ${response.status}`);
      }
      const json = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const textBlock = Array.isArray(json.content)
        ? json.content.find((item) => item.type === "text" && typeof item.text === "string")
        : null;
      return textBlock?.text?.trim() ?? null;
    }

    if (provider === "gemini") {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model ?? "gemini-2.0-flash"}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: conversation.system }]
            },
            contents: conversation.messages.map((message) => ({
              role: message.role === "assistant" ? "model" : "user",
              parts: [{ text: message.content }]
            })),
            generationConfig: {
              maxOutputTokens: 1000
            }
          })
        }
      );
      if (!response.ok) {
        throw new Error(`Gemini error ${response.status}`);
      }
      const json = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
            }>;
          };
        }>;
      };
      return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
    }

    if (provider === "ollama") {
      const ollamaHost = this.config.OLLAMA_HOST ?? "http://localhost:11434";
      const response = await fetch(`${ollamaHost}/v1/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model ?? "llama3.1:8b",
          messages: [{ role: "system", content: conversation.system }, ...conversation.messages],
          temperature: temperature ?? 0.7,
          max_tokens: 1000
        })
      });
      if (!response.ok) {
        throw new Error(`Ollama error ${response.status}`);
      }
      const json = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      };
      return json.choices?.[0]?.message?.content?.trim() ?? null;
    }

    throw new Error(`Provider desconhecido: ${provider}`);
  }

  private async notifyAdminFallback(tenantId: string, config: ChatbotConfig, statusCode: number): Promise<void> {
    console.warn(
      `[chatbot:ai:fallback] tenant=${config.instanceId} notified of AI fallback (status=${statusCode})`
    );

    this.platformAlertService?.alertCriticalError(
      tenantId,
      config.instanceId,
      `Groq rate limit — usando fallback ${config.aiFallbackProvider} (status: ${statusCode})`
    ).catch((err) => {
      console.error("[chatbot:ai] erro ao alertar fallback:", err);
    });
  }

  private async requestOpenAiCompatibleCompletion(
    managedAiProvider: ManagedAiProviderRuntime,
    apiKey: string,
    conversation: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    },
    temperature: number,
    toolRuntime?: ChatbotToolRuntime,
    messageHistory?: OpenAiCompatibleMessage[],
    recursionDepth = 0
  ): Promise<string | null> {
    const provider = managedAiProvider.provider as string | null;
    const baseUrl = managedAiProvider.baseUrl.endsWith("/") ? managedAiProvider.baseUrl : `${managedAiProvider.baseUrl}/`;
    const isAnthropic = provider === "ANTHROPIC";
    const messagesWithSystem: OpenAiCompatibleMessage[] =
      messageHistory ??
      [
        {
          role: "system",
          content: conversation.system
        },
        ...conversation.messages.map((message) => ({
          role: message.role,
          content: message.content
        }))
      ];
    const openAiTools = !isAnthropic && toolRuntime?.definitions.length ? toolRuntime.definitions : undefined;
    const url = isAnthropic ? "https://api.anthropic.com/v1/messages" : new URL("chat/completions", baseUrl).toString();
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
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
              max_tokens: 500,
              temperature
            }
          : {
              model: managedAiProvider.model,
              messages: messagesWithSystem,
              temperature,
              max_tokens: 500,
              ...(openAiTools
                ? {
                    tools: openAiTools,
                    tool_choice: "auto" as const
                  }
                : {})
            }
      )
    });

    if (!response.ok) {
      const err: any = new Error(`IA indisponivel: ${response.status}`);
      err.status = response.status;
      throw err;
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
          tool_calls?: OpenAiToolCall[];
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };
    const message = json.choices?.[0]?.message;
    const content = message?.content;
    const normalizedContent =
      typeof content === "string"
        ? content.trim() || null
        : Array.isArray(content)
          ? content
              .map((item) => (typeof item.text === "string" ? item.text : ""))
              .join("\n")
              .trim() || null
          : null;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.filter((item) => typeof item?.id === "string") : [];

    if (!isAnthropic && toolRuntime?.googleCalendar && toolCalls.length > 0) {
      if (recursionDepth >= 3) {
        throw new Error("Limite de execucao de tools atingido");
      }

      const nextMessages: OpenAiCompatibleMessage[] = [
        ...messagesWithSystem,
        {
          role: "assistant",
          content: normalizedContent,
          tool_calls: toolCalls
        }
      ];

      for (const toolCall of toolCalls) {
        const functionName = toolCall.function?.name;
        const rawArguments = toolCall.function?.arguments ?? "{}";

        if (!functionName || (functionName !== "checkAvailability" && functionName !== "createEvent")) {
          nextMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: functionName ?? "unknown",
            content: JSON.stringify({
              success: false,
              error: `Ferramenta nao suportada: ${functionName ?? "desconhecida"}`
            })
          });
          continue;
        }

        let parsedArguments: Record<string, unknown> = {};

        try {
          parsedArguments = JSON.parse(rawArguments) as Record<string, unknown>;
        } catch {
          nextMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: functionName,
            content: JSON.stringify({
              success: false,
              error: "Argumentos invalidos para a ferramenta"
            })
          });
          continue;
        }

        try {
          const toolResult =
            functionName === "checkAvailability"
              ? await toolRuntime.googleCalendar.checkAvailability(
                  typeof parsedArguments.date === "string" ? parsedArguments.date : ""
                )
              : await toolRuntime.googleCalendar.createEvent(
                  typeof parsedArguments.summary === "string" ? parsedArguments.summary : "",
                  typeof parsedArguments.description === "string" ? parsedArguments.description : "",
                  typeof parsedArguments.startDateTime === "string" ? parsedArguments.startDateTime : "",
                  typeof parsedArguments.endDateTime === "string" ? parsedArguments.endDateTime : ""
                );

          nextMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: functionName,
            content: JSON.stringify(toolResult)
          });
        } catch (error) {
          nextMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: functionName,
            content: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : "Erro ao executar ferramenta"
            })
          });
        }
      }

      return this.requestOpenAiCompatibleCompletion(
        managedAiProvider,
        apiKey,
        conversation,
        temperature,
        toolRuntime,
        nextMessages,
        recursionDepth + 1
      );
    }

    return normalizedContent;
  }
}

