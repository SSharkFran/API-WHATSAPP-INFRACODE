import type { ChatbotAiProvider, ChatbotConfig, ChatbotModules, ChatbotRule, ChatbotSimulationResult } from "@infracode/types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { decrypt } from "../../lib/crypto.js";
import { ApiError } from "../../lib/errors.js";
import {
  assertValidPhoneNumber,
  normalizePhoneNumber,
  normalizeWhatsAppPhoneNumber,
  toJid
} from "../../lib/phone.js";
import type { ChatMessage } from "./agents/types.js";
import { chatbotAiConfigSchema, chatbotRuleSchema, googleCalendarModuleSchema, upsertChatbotAiBodySchema } from "./schemas.js";
import { GoogleCalendarTool } from "./tools/google-calendar.tool.js";
import type { PlatformAlertService } from "../platform/alert.service.js";
import type { KnowledgeService } from "./knowledge.service.js";

interface ChatbotServiceDeps {
  config: AppConfig;
  platformPrisma: PlatformPrisma;
  tenantPrismaRegistry: TenantPrismaRegistry;
  platformAlertService?: PlatformAlertService;
  knowledgeService?: KnowledgeService;
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

type LeadPorte = "Pequeno" | "Médio" | "Grande" | "G. Especial";
type LeadServiceLevel = "Essencial" | "Completa" | "Detalhada";
type LeadDirtLevel = "Leve" | "Média" | "Pesada";

interface ExtractedLeadFromConversation {
  nome: string;
  contato: string;
  veiculo: string;
  porte: LeadPorte;
  servico: LeadServiceLevel;
  horario: string | null;
  endereco: string | null;
  sujeira: LeadDirtLevel | null;
  valorEstimado: number;
}

interface ExtractedLeadAiPayload {
  nome: string | null;
  veiculo: string | null;
  porte: LeadPorte | null;
  servico: LeadServiceLevel | null;
  horario: string | null;
  endereco: string | null;
  sujeira: LeadDirtLevel | null;
}

interface LeadConversationRecord {
  id: string;
  instanceId: string;
  phoneNumber: string | null;
  leadSent: boolean;
  awaitingLeadExtraction: boolean;
  contact: {
    phoneNumber: string;
    fields: Prisma.JsonValue | null;
  } | null;
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
const normalizeManagedAiProvider = (provider?: string | null): ChatbotAiProvider | null => {
  if (provider === "GROQ" || provider === "OPENAI_COMPATIBLE") {
    return provider;
  }

  return null;
};
const normalizeFallbackProvider = (provider?: string | null): "openai" | "gemini" | "ollama" | null => {
  if (provider === "openai" || provider === "gemini" || provider === "ollama") {
    return provider;
  }

  return null;
};
const defaultAiSettings = {
  isEnabled: false,
  mode: "RULES_THEN_AI",
  systemPrompt:
    "Voce e um assistente virtual comercial no WhatsApp. Responda sempre em portugues do Brasil, com clareza, objetividade e tom profissional.",
  temperature: 0.4,
  maxContextMessages: 12
} as const;
const chatbotGlobalSystemPromptSettingKey = "chatbot.globalSystemPrompt";

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
const normalizeLeadLookup = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
const institutionalQuestionPatterns = [
  /\b(?:atende|atendem|atendimento|horario|expediente|sabado|domingo|feriado)\b/,
  /\b(?:funcionario|funcionarios|equipe|time|colaborador|colaboradores)\b/,
  /\b(?:visita|visitar|presencial|reuniao presencial|ir ate)\b/,
  /\b(?:preco|precos|valor|valores|orcamento|orcamentos|custo|custos)\b/,
  /\b(?:servidor|servidores|infraestrutura|cloud|hosting|hospedagem|banco de dados)\b/,
  /\b(?:inteligencia artificial|ia propria|modelo proprio|ia)\b/,
  /\b(?:telefone|whatsapp|email|endereco|cnpj|site|localizacao)\b/,
  /\b(?:fazem|faz|oferecem|oferece|conseguem|consegue|mexem com|trabalham com|desenvolvem|desenvolve)\b/
];
const leadExtractionAiSystemPrompt = [
  "You are a data extraction assistant. Analyze this conversation and return ONLY a valid JSON object, no markdown, no explanation, nothing else.",
  "",
  "Extract:",
  "- nome: the client's name (string or null)",
  "- veiculo: vehicle model or type mentioned (string or null)",
  "- porte: classify vehicle size as exactly one of: 'Pequeno', 'Médio', 'Grande', or 'G. Especial'",
  "  Pequeno: small hatchbacks (HB20, Onix, Polo, Kwid, Mobi, Argo)",
  "  Médio: sedans and mid-size (Civic, Corolla, Cruze, Virtus, Camaro)",
  "  Grande: pickups and large SUVs (Hilux, L200, Amarok, Ranger, SW4, Compass)",
  "  G. Especial: heavy trucks, Ram, Silverado, F-250 and larger",
  "  Default to 'Médio' if vehicle mentioned but size uncertain.",
  "  Return null only if no vehicle mentioned.",
  "- servico: exactly 'Essencial', 'Completa', or 'Detalhada' (or null)",
  "- horario: any time or date preference (string or null)",
  "- endereco: the address or location where the service should be performed (string or null)",
  "- sujeira: 'Leve', 'Média', 'Pesada', or null",
  "",
  "Return ONLY the JSON object, nothing else."
].join("\n");

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

export const renderReplyTemplate = (
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
  private readonly knowledgeService?: KnowledgeService;
  private globalSystemPromptCache: string | null | undefined;

  public constructor(deps: ChatbotServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.platformAlertService = deps.platformAlertService;
    this.knowledgeService = deps.knowledgeService;
  }

  public setPlatformAlertService(service: PlatformAlertService): void {
    (this as unknown as { platformAlertService: PlatformAlertService }).platformAlertService = service;
  }

  public invalidateGlobalSystemPromptCache(): void {
    this.globalSystemPromptCache = undefined;
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
      humanTakeoverStartMessage?: string | null;
      humanTakeoverEndMessage?: string | null;
      rules: ChatbotRule[];
      ai?: z.infer<typeof chatbotAiUpsertSchema>;
      leadsPhoneNumber?: string | null;
      leadsEnabled?: boolean;
      fiadoEnabled?: boolean;
      audioEnabled?: boolean;
      visionEnabled?: boolean;
      visionPrompt?: string | null;
      responseDelayMs?: number | null;
      leadAutoExtract?: boolean;
      leadVehicleTable?: Record<string, unknown>;
      leadPriceTable?: Record<string, unknown>;
      leadSurchargeTable?: Record<string, unknown>;
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
    const existingConfig = await prisma.chatbotConfig.findUnique({
      where: {
        instanceId
      }
    });
    const audioEnabled = input.audioEnabled ?? existingConfig?.audioEnabled ?? false;
    const visionEnabled = input.visionEnabled ?? existingConfig?.visionEnabled ?? false;
    const visionPrompt = input.visionPrompt?.trim() ?? existingConfig?.visionPrompt ?? null;
    const responseDelayMs = Math.min(60_000, Math.max(0, input.responseDelayMs ?? existingConfig?.responseDelayMs ?? 3_000));
    const leadAutoExtract = input.leadAutoExtract ?? existingConfig?.leadAutoExtract ?? false;
    const leadVehicleTable =
      input.leadVehicleTable !== undefined
        ? input.leadVehicleTable
        : ((existingConfig?.leadVehicleTable as Record<string, unknown> | null | undefined) ?? {});
    const leadPriceTable =
      input.leadPriceTable !== undefined
        ? input.leadPriceTable
        : ((existingConfig?.leadPriceTable as Record<string, unknown> | null | undefined) ?? {});
    const leadSurchargeTable =
      input.leadSurchargeTable !== undefined
        ? input.leadSurchargeTable
        : ((existingConfig?.leadSurchargeTable as Record<string, unknown> | null | undefined) ?? {});

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
        humanTakeoverStartMessage: input.humanTakeoverStartMessage?.trim() || null,
        humanTakeoverEndMessage: input.humanTakeoverEndMessage?.trim() || null,
        rules,
        aiSettings: this.buildPersistedAiSettings(aiInput),
        aiApiKeyEncrypted: null,
        leadsPhoneNumber: normalizedLeadsPhoneNumber,
        leadsEnabled: input.leadsEnabled ?? true,
        fiadoEnabled: input.fiadoEnabled ?? false,
        audioEnabled,
        visionEnabled,
        visionPrompt,
        responseDelayMs,
        leadAutoExtract,
        leadVehicleTable: leadVehicleTable as unknown as Prisma.InputJsonValue,
        leadPriceTable: leadPriceTable as unknown as Prisma.InputJsonValue,
        leadSurchargeTable: leadSurchargeTable as unknown as Prisma.InputJsonValue,
        aiFallbackProvider: input.aiFallbackProvider ?? null,
        aiFallbackApiKey: input.aiFallbackApiKey?.trim() || null,
        aiFallbackModel: input.aiFallbackModel?.trim() || null,
        modules: (input.modules ?? {}) as unknown as Prisma.InputJsonValue
      } as Prisma.ChatbotConfigUncheckedCreateInput,
      update: {
        isEnabled: input.isEnabled,
        welcomeMessage: input.welcomeMessage?.trim() || null,
        fallbackMessage: input.fallbackMessage?.trim() || null,
        humanTakeoverStartMessage: input.humanTakeoverStartMessage?.trim() || null,
        humanTakeoverEndMessage: input.humanTakeoverEndMessage?.trim() || null,
        rules,
        aiSettings: this.buildPersistedAiSettings(aiInput),
        aiApiKeyEncrypted: null,
        leadsPhoneNumber: normalizedLeadsPhoneNumber,
        leadsEnabled: input.leadsEnabled ?? true,
        fiadoEnabled: input.fiadoEnabled ?? false,
        audioEnabled,
        visionEnabled,
        visionPrompt,
        responseDelayMs,
        leadAutoExtract,
        leadVehicleTable: leadVehicleTable as unknown as Prisma.InputJsonValue,
        leadPriceTable: leadPriceTable as unknown as Prisma.InputJsonValue,
        leadSurchargeTable: leadSurchargeTable as unknown as Prisma.InputJsonValue,
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
        humanTakeoverStartMessage: null,
        humanTakeoverEndMessage: null,
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

  public async formulateAdminAnswerForClient(
    tenantId: string,
    instanceId: string,
    originalQuestion: string,
    adminRawAnswer: string
  ): Promise<string> {
    const { config, managedAiProvider } = await this.getContext(tenantId, instanceId);

    if (
      !managedAiProvider.isConfigured ||
      !managedAiProvider.isActive ||
      !managedAiProvider.provider ||
      !managedAiProvider.model.trim() ||
      !managedAiProvider.apiKeyEncrypted
    ) {
      return adminRawAnswer.trim();
    }

    try {
      const apiKey = decrypt(managedAiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);
      const response = await this.callAiWithFallback(
        tenantId,
        managedAiProvider,
        apiKey,
        {
          system: [
            "Voce e um assistente de atendimento ao cliente via WhatsApp.",
            "Sua tarefa e formular uma resposta clara, natural e profissional para o cliente,",
            "baseada na informacao bruta fornecida pelo administrador.",
            "Seja direto, cordial e use linguagem adequada para WhatsApp.",
            "Nao mencione que houve consulta ao admin. Responda como se soubesse a informacao.",
            "Maximo 3 frases."
          ].join("\n"),
          messages: [
            {
              role: "user",
              content: [
                `Pergunta original do cliente: "${originalQuestion}"`,
                `Informacao do administrador: "${adminRawAnswer}"`,
                "Formule a resposta para o cliente:"
              ].join("\n")
            }
          ]
        },
        0.3,
        config
      );

      const cleanedResponse = response
        ?.replace(/\[TRANSBORDO_HUMANO\]/gi, "")
        .replace(/\[ESCALATE_ADMIN\]/gi, "")
        .trim();

      return cleanedResponse || adminRawAnswer.trim();
    } catch (err) {
      console.error("[chatbot:admin-answer] erro ao formular resposta:", err);
      return adminRawAnswer.trim();
    }
  }

  private isInstitutionalQuestion(input: string): boolean {
    const normalizedInput = normalizeLeadLookup(input);

    if (!normalizedInput) {
      return false;
    }

    const hasCompanyAnchor =
      /\b(?:voces|vcs|empresa|infracode|time|equipe|na infracode|com voces)\b/.test(normalizedInput) ||
      /\b(?:quantos|quais|qual|tem|fazem|faz|oferecem|oferece|atendem|atende|conseguem|consegue)\b/.test(normalizedInput);

    return hasCompanyAnchor && institutionalQuestionPatterns.some((pattern) => pattern.test(normalizedInput));
  }

  private async shouldEscalateInstitutionalQuestion(params: {
    tenantId: string;
    question: string;
    groundingContext: string;
    managedAiProvider: ManagedAiProviderRuntime;
    apiKey: string;
    config: ChatbotConfig;
  }): Promise<boolean> {
    if (!params.groundingContext.trim()) {
      return true;
    }

    try {
      const response = await this.callAiWithFallback(
        params.tenantId,
        params.managedAiProvider,
        params.apiKey,
        {
          system: [
            "Voce e um fiscal de contexto para um chatbot comercial.",
            "Sua tarefa e decidir se a pergunta do cliente pode ser respondida SOMENTE com base no contexto autorizado.",
            "Se a pergunta depender de informacao sobre a propria empresa, servicos, horarios, equipe, visitas, capacidade operacional, precos, politicas internas ou qualquer dado institucional nao EXPLICITAMENTE presente no contexto, responda exatamente com [ESCALATE_ADMIN].",
            "Se o contexto trouxer suporte explicito e suficiente para responder com seguranca, responda exatamente com [ALLOW].",
            "Conhecimento geral sobre empresas de tecnologia NAO conta como contexto.",
            "Nao explique, nao invente e nao use nenhuma outra palavra."
          ].join("\n"),
          messages: [
            {
              role: "user",
              content: [
                `Pergunta do cliente: "${params.question}"`,
                "",
                "Contexto autorizado:",
                params.groundingContext,
                "",
                "Responda somente com [ALLOW] ou [ESCALATE_ADMIN]."
              ].join("\n")
            }
          ]
        },
        0,
        params.config
      );

      return !/\[ALLOW\]/i.test(response ?? "");
    } catch (err) {
      console.error("[chatbot:grounding-check] erro ao validar contexto institucional:", err);
      return true;
    }
  }

  private async getGlobalSystemPrompt(): Promise<string | null> {
    if (this.globalSystemPromptCache !== undefined) {
      return this.globalSystemPromptCache;
    }

    const setting = await this.platformPrisma.platformSetting.findUnique({
      where: {
        key: chatbotGlobalSystemPromptSettingKey
      }
    });

    const resolvedPrompt = typeof setting?.value === "string" && setting.value.trim() ? setting.value.trim() : null;
    this.globalSystemPromptCache = resolvedPrompt;
    return resolvedPrompt;
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
            humanTakeoverStartMessage: null,
            humanTakeoverEndMessage: null,
            leadsGroupJid: null,
            leadsGroupName: null,
            leadsPhoneNumber: null,
            leadsEnabled: true,
            fiadoEnabled: false,
            audioEnabled: false,
            visionEnabled: false,
            visionPrompt: null,
            responseDelayMs: 3_000,
            leadAutoExtract: false,
            leadVehicleTable: {},
            leadPriceTable: {},
            leadSurchargeTable: {},
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

    const provider = normalizeManagedAiProvider(record.provider);

    if (!provider) {
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
      provider,
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
      humanTakeoverStartMessage?: string | null;
      humanTakeoverEndMessage?: string | null;
      leadsGroupJid?: string | null;
      leadsGroupName?: string | null;
      leadsPhoneNumber?: string | null;
      leadsEnabled?: boolean | null;
      fiadoEnabled?: boolean | null;
      audioEnabled?: boolean | null;
      visionEnabled?: boolean | null;
      visionPrompt?: string | null;
      responseDelayMs?: number | null;
      leadAutoExtract?: boolean | null;
      leadVehicleTable?: unknown;
      leadPriceTable?: unknown;
      leadSurchargeTable?: unknown;
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
      humanTakeoverStartMessage: record.humanTakeoverStartMessage ?? null,
      humanTakeoverEndMessage: record.humanTakeoverEndMessage ?? null,
      leadsGroupJid: record.leadsGroupJid ?? null,
      leadsGroupName: record.leadsGroupName ?? null,
      leadsPhoneNumber: record.leadsPhoneNumber ?? null,
      leadsEnabled: record.leadsEnabled ?? true,
      fiadoEnabled: record.fiadoEnabled ?? false,
      audioEnabled: record.audioEnabled ?? false,
      visionEnabled: record.visionEnabled ?? false,
      visionPrompt: record.visionPrompt ?? null,
      responseDelayMs: record.responseDelayMs ?? 3_000,
      leadAutoExtract: record.leadAutoExtract ?? false,
      leadVehicleTable:
        record.leadVehicleTable && typeof record.leadVehicleTable === "object"
          ? (record.leadVehicleTable as Record<string, unknown>)
          : {},
      leadPriceTable:
        record.leadPriceTable && typeof record.leadPriceTable === "object"
          ? (record.leadPriceTable as Record<string, unknown>)
          : {},
      leadSurchargeTable:
        record.leadSurchargeTable && typeof record.leadSurchargeTable === "object"
          ? (record.leadSurchargeTable as Record<string, unknown>)
          : {},
      rules: chatbotRulesArraySchema.parse(record.rules),
      ai: this.buildRuntimeAiConfig(aiSettings, managedAiProvider),
      aiFallbackProvider: normalizeFallbackProvider(record.aiFallbackProvider),
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

  private async getLeadConversationForExtraction(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    conversationId: string
  ): Promise<LeadConversationRecord | null> {
    return prisma.conversation.findUnique({
      where: {
        id: conversationId
      },
      select: {
        id: true,
        instanceId: true,
        phoneNumber: true,
        leadSent: true,
        awaitingLeadExtraction: true,
        contact: {
          select: {
            phoneNumber: true,
            fields: true
          }
        }
      }
    });
  }

  private cleanLeadPhoneValue(value?: string | null): string {
    return String(value ?? "")
      .replace(/@s\.whatsapp\.net$/i, "")
      .replace(/@c\.us$/i, "")
      .replace(/@.*$/, "")
      .replace(/\D/g, "");
  }

  private resolveLeadPhoneFromConversation(
    conversation: LeadConversationRecord,
    fallbackPhone: string
  ): { cleanPhone: string; unresolvedLid: boolean } {
    const contactFields =
      conversation.contact?.fields && typeof conversation.contact.fields === "object"
        ? (conversation.contact.fields as Record<string, unknown>)
        : null;
    const lastRemoteJid =
      typeof contactFields?.lastRemoteJid === "string" && contactFields.lastRemoteJid.trim()
        ? contactFields.lastRemoteJid.trim()
        : null;
    const sharedPhoneJid =
      typeof contactFields?.sharedPhoneJid === "string" && contactFields.sharedPhoneJid.trim()
        ? contactFields.sharedPhoneJid.trim()
        : null;
    const lidDigits = lastRemoteJid?.endsWith("@lid") ? this.cleanLeadPhoneValue(lastRemoteJid) : null;

    const cleanPhone =
      this.cleanLeadPhoneValue(sharedPhoneJid) ||
      (lastRemoteJid && /@(s\.whatsapp\.net|c\.us)$/i.test(lastRemoteJid)
        ? this.cleanLeadPhoneValue(lastRemoteJid)
        : "") ||
      (conversation.phoneNumber && conversation.phoneNumber !== lidDigits
        ? this.cleanLeadPhoneValue(conversation.phoneNumber)
        : "") ||
      (conversation.contact?.phoneNumber && conversation.contact.phoneNumber !== lidDigits
        ? this.cleanLeadPhoneValue(conversation.contact.phoneNumber)
        : "") ||
      (fallbackPhone && fallbackPhone !== lidDigits ? this.cleanLeadPhoneValue(fallbackPhone) : "");

    return {
      cleanPhone,
      unresolvedLid: Boolean(lidDigits && !cleanPhone && !sharedPhoneJid)
    };
  }

  private async waitForLeadPhoneResolution(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    conversationId: string,
    fallbackPhone: string
  ): Promise<LeadConversationRecord | null> {
    let conversation = await this.getLeadConversationForExtraction(prisma, conversationId);

    for (let attempt = 0; conversation && attempt < 6; attempt += 1) {
      const phoneResolution = this.resolveLeadPhoneFromConversation(conversation, fallbackPhone);

      if (!phoneResolution.unresolvedLid) {
        return conversation;
      }

      await delay(500);
      conversation = await this.getLeadConversationForExtraction(prisma, conversationId);
    }

    return conversation;
  }

  public async processLeadAfterConversation(
    conversationId: string,
    chatbotConfig: ChatbotConfig & { __tenantId?: string },
    phoneNumber: string
  ): Promise<void> {
    const tenantId = chatbotConfig.__tenantId?.trim();
    console.log("[lead:phone] raw phoneNumber received:", JSON.stringify(phoneNumber));

    if (!tenantId) {
      return;
    }

    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    console.log("[lead] iniciando extração para conversa:", conversationId);

    try {
      const conversation = await this.waitForLeadPhoneResolution(prisma, conversationId, phoneNumber);

      if (!conversation) {
        throw new Error("Conversa nao encontrada");
      }

      if (conversation.leadSent) {
        await prisma.conversation.update({
          where: {
            id: conversationId
          },
          data: {
            awaitingLeadExtraction: false
          } as Prisma.ConversationUncheckedUpdateInput
        });
        console.log("[lead] awaitingLeadExtraction reset para conversa:", conversationId);
        return;
      }

      const contactFields =
        conversation.contact?.fields && typeof conversation.contact.fields === "object"
          ? (conversation.contact.fields as Record<string, unknown>)
          : null;
      const lastRemoteJid =
        typeof contactFields?.lastRemoteJid === "string" && contactFields.lastRemoteJid.trim()
          ? contactFields.lastRemoteJid.trim()
          : null;
      const sharedPhoneJid =
        typeof contactFields?.sharedPhoneJid === "string" && contactFields.sharedPhoneJid.trim()
          ? contactFields.sharedPhoneJid.trim()
          : null;
      const remoteJid = lastRemoteJid || toJid(conversation.contact?.phoneNumber ?? phoneNumber);
      const cleanPhone = this.resolveLeadPhoneFromConversation(conversation, phoneNumber).cleanPhone;
      console.log("[lead:phone] cleanPhone:", cleanPhone);
      const leadRemoteJids = Array.from(
        new Set(
          [lastRemoteJid, sharedPhoneJid, remoteJid, cleanPhone ? toJid(cleanPhone) : null].filter(
            (value): value is string => Boolean(value)
          )
        )
      );
      const messages = await this.loadLeadConversationMessages(
        prisma,
        conversationId,
        conversation.instanceId,
        leadRemoteJids
      );
      const extracted = await this.extractLeadWithAi(messages, cleanPhone, chatbotConfig);

      console.log("[lead] dados extraídos:", JSON.stringify(extracted));

      if (!extracted) {
        throw new Error("Falha ao extrair dados obrigatorios do lead");
      }

      const alertMessage = [
        "🔔 Novo lead detectado:",
        `Nome: ${extracted.nome}`,
        `Contato: ${extracted.contato || "a confirmar pelo consultor"}`,
        `Veículo: ${extracted.veiculo} - ${extracted.porte}`,
        `Serviço de interesse: Zelo ${extracted.servico}`,
        `Sujeira Identificada: ${extracted.sujeira ?? "não avaliada"}`,
        `Valor Estimado: R$ ${extracted.valorEstimado.toFixed(2).replace(".", ",")}`,
        `Horário agendado: ${extracted.horario ?? "a confirmar pelo consultor"}`,
        `Endereço: ${extracted.endereco ?? "a confirmar pelo consultor"}`
      ].join("\n");
      const instanceAlertPhone = chatbotConfig.leadsPhoneNumber?.trim() || null;
      const adminAlertPhone =
        (await this.platformPrisma.platformConfig.findUnique({
          where: { id: "singleton" },
          select: { adminAlertPhone: true }
        }))?.adminAlertPhone ?? null;
      const alertPhone = instanceAlertPhone ?? adminAlertPhone;

      console.log("[lead] tentando enviar para:", alertPhone);
      console.log("[lead] instanceId:", conversation.instanceId);
      console.log("[lead] mensagem:", alertMessage);

      let alertSent = false;

      try {
        alertSent = alertPhone
          ? (await this.platformAlertService?.sendAlertToPhone(alertPhone, alertMessage)) ?? false
          : false;
      } catch (error) {
        console.error(
          "[lead] erro completo ao enviar:",
          JSON.stringify(error, Object.getOwnPropertyNames(error))
        );
        throw error;
      }

      if (!alertSent) {
        throw new Error("Falha ao enviar alerta de lead");
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
      console.log("[lead] awaitingLeadExtraction reset para conversa:", conversationId);
      console.log("[lead] lead enviado para:", cleanPhone);
    } catch (error) {
      console.error("[lead] erro na extração:", error);
      await prisma.conversation.update({
        where: {
          id: conversationId
        },
        data: {
          awaitingLeadExtraction: false
        } as Prisma.ConversationUncheckedUpdateInput
      }).catch(() => undefined);
      console.log("[lead] awaitingLeadExtraction reset para conversa:", conversationId);
    }
  }

  private async extractLeadWithAi(
    messages: ChatMessage[],
    phoneNumber: string,
    chatbotConfig: ChatbotConfig & { __tenantId?: string }
  ): Promise<ExtractedLeadFromConversation | null> {
    const transcript = this.buildLeadExtractionTranscript(messages);
    const tenantId = chatbotConfig.__tenantId?.trim();

    if (!tenantId || !transcript) {
      return null;
    }

    const managedAiProvider = await this.getManagedAiProvider(tenantId);

    if (
      !managedAiProvider.isConfigured ||
      !managedAiProvider.isActive ||
      !managedAiProvider.provider ||
      !managedAiProvider.model.trim() ||
      !managedAiProvider.apiKeyEncrypted
    ) {
      return null;
    }

    const apiKey = decrypt(managedAiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);
    const rawResponse = await this.callAiWithFallback(
      tenantId,
      managedAiProvider,
      apiKey,
      {
        system: leadExtractionAiSystemPrompt,
        messages: [
          {
            role: "user",
            content: transcript
          }
        ]
      },
      0,
      chatbotConfig
    );

    if (!rawResponse) {
      return null;
    }

    const extractedLead = this.parseLeadExtractionResponse(rawResponse);

    if (!extractedLead?.nome || !extractedLead.veiculo || !extractedLead.servico) {
      return null;
    }

    const porte = extractedLead.porte ?? "Médio";

    const basePrice = this.lookupLeadTableValue(chatbotConfig.leadPriceTable, porte, extractedLead.servico);

    if (basePrice === null) {
      return null;
    }

    const surcharge =
      extractedLead.sujeira === "Média" || extractedLead.sujeira === "Pesada"
        ? this.lookupLeadTableValue(chatbotConfig.leadSurchargeTable, porte, extractedLead.sujeira) ?? 0
        : 0;

    return {
      nome: extractedLead.nome,
      contato: phoneNumber,
      veiculo: extractedLead.veiculo,
      porte,
      servico: extractedLead.servico,
      horario: extractedLead.horario,
      endereco: extractedLead.endereco,
      sujeira: extractedLead.sujeira,
      valorEstimado: Number((basePrice + surcharge).toFixed(2))
    };
  }

  private async loadLeadConversationMessages(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    conversationId: string,
    instanceId: string,
    remoteJids: string[]
  ): Promise<ChatMessage[]> {
    if (remoteJids.length === 0 && !conversationId) {
      return [];
    }

    const records = await prisma.message.findMany({
      where: {
        instanceId,
        OR: [
          {
            traceId: conversationId
          },
          {
            remoteJid: {
              in: remoteJids
            }
          }
        ]
      },
      orderBy: {
        createdAt: "asc"
      },
      select: {
        direction: true,
        payload: true
      }
    });

    const messages: ChatMessage[] = [];

    for (const record of records) {
      const payload = record.payload as Record<string, unknown> | null;
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";

      if (!text) {
        continue;
      }

      messages.push({
        role: record.direction === "INBOUND" ? "user" : "assistant",
        content: text
      });
    }

    return messages;
  }

  private buildLeadExtractionTranscript(messages: ChatMessage[]): string {
    return messages
      .map((message) => {
        const content = message.content.trim();

        if (!content) {
          return null;
        }

        return `${message.role === "user" ? "Cliente" : "Atendente"}: ${content}`;
      })
      .filter((message): message is string => Boolean(message))
      .join("\n");
  }

  private parseLeadExtractionResponse(responseText: string): ExtractedLeadAiPayload | null {
    const sanitizedResponse = responseText
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");

    try {
      const parsed = JSON.parse(sanitizedResponse) as Record<string, unknown> | null;

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }

      return {
        nome: this.parseNullableLeadString(parsed.nome),
        veiculo: this.parseNullableLeadString(parsed.veiculo),
        porte: this.normalizeLeadPorte(parsed.porte) ?? (this.parseNullableLeadString(parsed.veiculo) ? "Médio" : null),
        servico: this.normalizeLeadServiceValue(parsed.servico),
        horario: this.parseNullableLeadString(parsed.horario),
        endereco: this.parseNullableLeadString(parsed.endereco),
        sujeira: this.normalizeLeadDirtLevel(parsed.sujeira)
      };
    } catch {
      return null;
    }
  }

  private resolveLeadContactPhoneNumber(...candidates: Array<string | null | undefined>): string {
    for (const candidate of candidates) {
      const normalized = normalizeWhatsAppPhoneNumber(candidate);

      if (normalized) {
        return normalized;
      }
    }

    return normalizePhoneNumber(candidates.find((candidate): candidate is string => typeof candidate === "string") ?? "");
  }

  private parseNullableLeadString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.replace(/\s+/g, " ").trim();

    if (!trimmed) {
      return null;
    }

    const normalized = normalizeLeadLookup(trimmed);
    return normalized === "null" || normalized === "nao informado" ? null : trimmed;
  }

  private normalizeLeadServiceValue(value: unknown): LeadServiceLevel | null {
    const normalized = normalizeLeadLookup(String(value ?? ""));

    if (normalized === "essencial") {
      return "Essencial";
    }
    if (normalized === "completa") {
      return "Completa";
    }
    if (normalized === "detalhada") {
      return "Detalhada";
    }

    return null;
  }

  private normalizeLeadDirtLevel(value: unknown): LeadDirtLevel | null {
    const normalized = normalizeLeadLookup(String(value ?? ""));

    if (normalized === "leve") {
      return "Leve";
    }
    if (normalized === "media") {
      return "Média";
    }
    if (normalized === "pesada") {
      return "Pesada";
    }

    return null;
  }

  private normalizeLeadPorte(value: unknown): LeadPorte | null {
    const normalized = normalizeLeadLookup(String(value ?? ""));

    if (normalized === "pequeno") {
      return "Pequeno";
    }
    if (normalized === "medio") {
      return "Médio";
    }
    if (normalized === "grande") {
      return "Grande";
    }
    if (normalized === "g especial" || normalized === "gespecial") {
      return "G. Especial";
    }

    return null;
  }

  private lookupLeadTableValue(table: unknown, rowKey: string, columnKey: string): number | null {
    if (!table || typeof table !== "object") {
      return null;
    }

    const normalizedRowKey = normalizeLeadLookup(rowKey);
    const rowEntry = Object.entries(table as Record<string, unknown>).find(
      ([key]) => normalizeLeadLookup(key) === normalizedRowKey
    );

    if (!rowEntry || !rowEntry[1] || typeof rowEntry[1] !== "object") {
      return null;
    }

    const normalizedColumnKey = normalizeLeadLookup(columnKey);
    const columnEntry = Object.entries(rowEntry[1] as Record<string, unknown>).find(
      ([key]) => normalizeLeadLookup(key) === normalizedColumnKey
    );

    if (!columnEntry) {
      return null;
    }

    return this.parseLeadMoneyValue(columnEntry[1]);
  }

  private parseLeadMoneyValue(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value !== "string") {
      return null;
    }

    const sanitized = value.replace(/[^\d,.-]/g, "").trim();

    if (!sanitized) {
      return null;
    }

    const normalized =
      sanitized.includes(",") && sanitized.includes(".")
        ? sanitized.replace(/\./g, "").replace(",", ".")
        : sanitized.includes(",")
          ? sanitized.replace(",", ".")
          : sanitized;

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
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
        tenantId,
        config.instanceId,
        input,
        config.ai.systemPrompt,
        config.ai.maxContextMessages
      );

      if (
        input.text?.trim() &&
        this.isInstitutionalQuestion(input.text) &&
        await this.shouldEscalateInstitutionalQuestion({
          tenantId,
          question: input.text,
          groundingContext: conversation.groundingContext,
          managedAiProvider,
          apiKey,
          config
        })
      ) {
        return {
          action: "ESCALATE_ADMIN",
          matchedRuleId: null,
          matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}`,
          responseText: ""
        };
      }

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
      const isEscalation = /\[ESCALATE_ADMIN\]/i.test(responseText);

      if (isEscalation) {
        return {
          action: "ESCALATE_ADMIN",
          matchedRuleId: null,
          matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}`,
          responseText: ""
        };
      }

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
    tenantId: string,
    instanceId: string,
    input: ChatbotRuntimeInput,
    systemPrompt: string,
    maxContextMessages: number
  ): Promise<{
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    groundingContext: string;
  }> {
    const normalizedPhoneNumber = normalizePhoneNumber(input.phoneNumber);
    const baseSystemPrompt = systemPrompt.trim() || defaultAiSettings.systemPrompt;
    const globalSystemPrompt = await this.getGlobalSystemPrompt();
    const systemParts = [
      ...(globalSystemPrompt ? [`### PROMPT GLOBAL DA PLATAFORMA ###\n${globalSystemPrompt}`] : []),
      baseSystemPrompt,
      `Data atual: ${formatDate(new Date())} ${formatTime(new Date())}.`,
      `Numero exato do cliente: ${normalizedPhoneNumber}.`,
      "### REGRAS GERAIS ###",
      "1. Responda em 1 a 3 frases no maximo. Seja direto.",
      '2. O cliente dita o nome: Se ele disser "me chamo X", use X.',
      "6. Nunca invente informacoes, precos, datas ou dados que nao estao no contexto.",
      "7. Se o cliente parecer frustrado ou impaciente, reconheca antes de responder.",
      "8. Quando o cliente se despedir (tchau, ate logo, obrigado etc), responda de forma calorosa e encerre a conversa.",
      "9. Nunca diga que voce e uma IA a menos que o cliente pergunte diretamente.",
      "10. Se o cliente perguntar seu nome, use o nome definido no prompt da instancia.",
      "11. Perguntas sobre a propria empresa, servicos oferecidos, horarios, equipe, visitas presenciais, quantidade de funcionarios, capacidade tecnica ou politicas internas so podem ser respondidas se a informacao estiver EXPLICITAMENTE no contexto autorizado.",
      "12. Se a pergunta institucional nao estiver explicitamente documentada no prompt da instancia, no memory.md ou no conhecimento aprendido, responda com [ESCALATE_ADMIN].",
      "13. Nunca use suposicoes sobre o que empresas de tecnologia normalmente fazem."
    ];
    const groundingSources = [
      ...(globalSystemPrompt ? [globalSystemPrompt] : []),
      baseSystemPrompt
    ];

    const memoryFilePath = join(this.config.DATA_DIR, "tenants", tenantId, "instances", instanceId, "memory.md");
    try {
      const memoryContent = await readFile(memoryFilePath, "utf-8");
      if (memoryContent.trim()) {
        systemParts.push(`\n--- CONTEXTO LOCAL (memory.md) ---\n${memoryContent.trim()}`);
        groundingSources.push(memoryContent.trim());
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (input.clientContext?.trim()) {
      systemParts.push(input.clientContext.trim());
      groundingSources.push(input.clientContext.trim());
    }

    if (this.knowledgeService) {
      const knowledgeBlock = await this.knowledgeService.buildContextBlock(tenantId, instanceId);
      if (knowledgeBlock) {
        systemParts.push(knowledgeBlock);
        groundingSources.push(knowledgeBlock);
      }
    }

    systemParts.push([
      "### REGRA DE ESCALACAO ###",
      "Se voce nao tem certeza sobre a resposta ou a informacao nao esta no seu contexto:",
      "1. NAO invente ou adivinhe respostas",
      "2. NAO responda de forma vaga como 'nao sei' ou 'entre em contato conosco'",
      "3. Responda EXATAMENTE com o token: [ESCALATE_ADMIN]",
      "4. Use [ESCALATE_ADMIN] somente quando genuinamente nao souber - para perguntas gerais, responda normalmente.",
      "Exemplos de quando escalar: preco especifico de um produto, informacao interna da empresa, dado que nao foi fornecido.",
      "Exemplos de quando NAO escalar: saudacoes, perguntas genericas, informacoes que estao no contexto."
    ].join("\n"));

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

    return {
      system,
      messages,
      groundingContext: groundingSources.join("\n\n").trim()
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
    const primaryProviderLabel = managedAiProvider.provider ?? "provider principal";

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
          `[chatbot:ai] ${primaryProviderLabel} falhou (${status}), tentando fallback: ${config.aiFallbackProvider}`
        );
        await this.notifyAdminFallback(tenantId, config, primaryProviderLabel, status ?? 0);
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

  private async notifyAdminFallback(
    tenantId: string,
    config: ChatbotConfig,
    providerName: string,
    statusCode: number
  ): Promise<void> {
    console.warn(
      `[chatbot:ai:fallback] tenant=${config.instanceId} notified of AI fallback (status=${statusCode})`
    );

    this.platformAlertService?.alertCriticalError(
      tenantId,
      config.instanceId,
      `Falha do provider principal ${providerName} - usando fallback ${config.aiFallbackProvider} (status: ${statusCode})`
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
    const baseUrl = managedAiProvider.baseUrl.endsWith("/") ? managedAiProvider.baseUrl : `${managedAiProvider.baseUrl}/`;
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
    const openAiTools = toolRuntime?.definitions.length ? toolRuntime.definitions : undefined;
    const url = new URL("chat/completions", baseUrl).toString();
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
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
      })
    });

    if (!response.ok) {
      const err: any = new Error(`IA indisponivel: ${response.status}`);
      err.status = response.status;
      throw err;
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

    if (toolRuntime?.googleCalendar && toolCalls.length > 0) {
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

