import type { ChatbotAiProvider, ChatbotConfig, ChatbotModules, ChatbotRule, ChatbotSimulationResult, ChatbotTraceStep } from "@infracode/types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import type { AppConfig } from "../../config.js";
import type { PlatformPrisma, TenantPrismaRegistry } from "../../lib/database.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { ApiError } from "../../lib/errors.js";
import {
  assertValidPhoneNumber,
  ensurePhoneCountryCode,
  normalizePhoneNumber,
  normalizeWhatsAppPhoneNumber,
  toJid
} from "../../lib/phone.js";
import { GroqKeyRotator } from "../../lib/groq-key-rotator.js";
import type { AgentContext, AiCaller, ChatMessage, ContextBlocks } from "./agents/types.js";
import { OrchestratorAgent } from "./agents/orchestrator.agent.js";
import {
  getAgendamentoAdminModuleConfig,
  getAntiSpamModuleConfig,
  getAprendizadoContinuoModuleConfig,
  getHorarioAtendimentoModuleConfig,
  getMemoriaPersonalizadaModuleConfig,
  isPhoneAllowedByListaBranca,
  isPhoneBlockedByBlacklist,
  isWithinHorarioAtendimento,
  matchesPauseWord,
  sanitizeChatbotModules
} from "./module-runtime.js";
import type { PersistentMemoryService } from "./persistent-memory.service.js";
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
  persistentMemoryService?: PersistentMemoryService;
}

interface ChatbotRuntimeInput {
  text?: string | null;
  isFirstContact: boolean;
  contactName?: string | null;
  phoneNumber: string;
  remoteJid?: string | null;
  clientContext?: string | null;
  trace?: boolean;
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
    phoneNumber: string | null;
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
const defaultAiErrorFallbackMessage =
  "Tive uma instabilidade para responder agora. Pode me chamar novamente em instantes?";
const defaultNoEscalationFallbackMessage =
  "Nao tenho essa informacao agora, mas posso ajudar com outras duvidas.";
const chatbotGlobalSystemPromptSettingKey = "chatbot.globalSystemPrompt";
const aprendizadoContinuoVerificationTtlMs = 10 * 60 * 1000;

const generateAprendizadoContinuoVerificationCode = (): string =>
  String(Math.floor(100000 + Math.random() * 900000));

const formatDate = (date: Date): string => {
  const dayOfWeek = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(date);
  const dateStr = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
  return `${dayOfWeek}, ${dateStr}`;
};

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
    default:
      return false;
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
  private readonly persistentMemoryService?: PersistentMemoryService;
  private readonly groqKeyRotator: GroqKeyRotator;
  private readonly orchestratorAgent: OrchestratorAgent;
  private globalSystemPromptCache: { value: string | null; expiresAt: number } | undefined;

  public constructor(deps: ChatbotServiceDeps) {
    this.config = deps.config;
    this.platformPrisma = deps.platformPrisma;
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.platformAlertService = deps.platformAlertService;
    this.knowledgeService = deps.knowledgeService;
    this.persistentMemoryService = deps.persistentMemoryService;
    this.orchestratorAgent = new OrchestratorAgent();

    const extraKeys = (deps.config.GROQ_EXTRA_API_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    this.groqKeyRotator = new GroqKeyRotator([deps.config.GROQ_API_KEY, ...extraKeys]);
    console.log(`[groq-rotator] inicializado com ${this.groqKeyRotator.size} chave(s)`);
  }

  public setPlatformAlertService(service: PlatformAlertService): void {
    (this as unknown as { platformAlertService: PlatformAlertService }).platformAlertService = service;
  }

  public invalidateGlobalSystemPromptCache(): void {
    this.globalSystemPromptCache = undefined; // força re-fetch na próxima chamada
  }

  /** Retorna a proxima chave GROQ disponivel do pool rotativo. */
  public getNextGroqApiKey(): string | null {
    return this.groqKeyRotator.availableKeys()[0] ?? null;
  }

  /** Reporta sucesso/falha de uma chamada GROQ para o rotador de chaves. */
  public reportGroqKeyResult(key: string, status: "success" | number): void {
    if (status === "success") {
      this.groqKeyRotator.reportSuccess(key);
    } else {
      this.groqKeyRotator.reportFailure(key, status);
    }
  }

  public async extractPersistentMemory(
    tenantId: string,
    instanceId: string,
    phoneNumber: string,
    recentMessages: Array<{ role: "user" | "assistant"; content: string }>
  ): Promise<void> {
    if (!this.persistentMemoryService) return;

    const { config, managedAiProvider } = await this.getContext(tenantId, instanceId);
    const memoriaModule = getMemoriaPersonalizadaModuleConfig(config.modules);
    if (!memoriaModule?.isEnabled || memoriaModule.fields.length === 0) return;
    if (!managedAiProvider.isConfigured || !managedAiProvider.apiKeyEncrypted) return;

    const apiKey = decrypt(managedAiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);
    await this.persistentMemoryService.extractAndSave(
      tenantId,
      instanceId,
      phoneNumber,
      recentMessages,
      memoriaModule.fields,
      { baseUrl: managedAiProvider.baseUrl, apiKey, model: managedAiProvider.model }
    );
  }

  /**
   * Sintetiza todo o conhecimento aprendido em um documento markdown organizado.
   * Chamado em fire-and-forget apos cada novo aprendizado do admin.
   */
  public async triggerKnowledgeSynthesis(
    tenantId: string,
    instanceId: string
  ): Promise<void> {
    const { managedAiProvider } = await this.getContext(tenantId, instanceId);
    if (!managedAiProvider.isConfigured || !managedAiProvider.apiKeyEncrypted) return;

    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);

    const [records, config] = await Promise.all([
      prisma.tenantKnowledge.findMany({
        where: { instanceId },
        orderBy: { createdAt: "asc" },
        select: { question: true, answer: true, createdAt: true }
      }),
      prisma.chatbotConfig.findUnique({
        where: { instanceId },
        select: { knowledgeSynthesis: true }
      })
    ]);

    if (records.length === 0) return;

    const apiKey = decrypt(managedAiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);

    const factsList = records.map((r, i) =>
      `${i + 1}. P: "${r.question}" → R: "${r.answer}"`
    ).join("\n");

    const currentDoc = config?.knowledgeSynthesis?.trim()
      ? `\n\nDOCUMENTO ATUAL (atualize e melhore, nao descarte informacoes validas):\n${config.knowledgeSynthesis.trim()}`
      : "";

    const prompt = [
      "Voce e um organizador de base de conhecimento corporativo.",
      "Abaixo estao fatos aprendidos sobre uma empresa atraves de conversas com o administrador.",
      "Produza um documento markdown limpo, organizado por secoes logicas (ex: ## Empresa, ## Servicos, ## Precos, ## Contato, ## Politicas).",
      "Regras:",
      "- Elimine duplicatas e informacoes contraditórias (prefira a mais recente)",
      "- Seja conciso e factual — nao invente nada",
      "- Preserve TODAS as informacoes validas",
      "- Use linguagem profissional em portugues do Brasil",
      "- Retorne APENAS o markdown, sem explicacoes antes ou depois",
      "",
      `FATOS APRENDIDOS:\n${factsList}`,
      currentDoc
    ].join("\n");

    const response = await fetch(`${managedAiProvider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: managedAiProvider.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "Voce e um organizador de conhecimento corporativo. Responda apenas com o documento markdown solicitado." },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) {
      console.warn(`[knowledge-synthesis] erro na IA: ${response.status}`);
      return;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const synthesis = data.choices?.[0]?.message?.content?.trim();

    if (!synthesis) {
      console.warn("[knowledge-synthesis] resposta vazia da IA");
      return;
    }

    await prisma.chatbotConfig.update({
      where: { instanceId },
      data: {
        knowledgeSynthesis: synthesis,
        knowledgeSynthesisUpdatedAt: new Date()
      }
    });

    console.log(`[knowledge-synthesis] documento atualizado para instancia ${instanceId} (${records.length} fatos)`);
  }

  /**
   * Sintetiza uma entrada de conhecimento antes de salva-la:
   * - Extrai a pergunta-nucleo da mensagem bruta do cliente (ex: transcricao de audio longa)
   * - Reformula a resposta crua do admin em linguagem clara e profissional
   * Retorna fallback para os valores brutos em caso de erro ou IA nao configurada.
   */
  public async synthesizeKnowledgeEntry(
    tenantId: string,
    instanceId: string,
    rawQuestion: string,
    rawAnswer: string
  ): Promise<{ question: string; answer: string }> {
    const fallback = { question: rawQuestion.trim(), answer: rawAnswer.trim() };

    try {
      const { managedAiProvider } = await this.getContext(tenantId, instanceId);
      if (!managedAiProvider.isConfigured || !managedAiProvider.apiKeyEncrypted) return fallback;

      const apiKey = decrypt(managedAiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);

      const prompt = [
        "Voce recebe a mensagem bruta de um cliente (pode ser transcricao de audio, texto longo, informal) e a resposta crua do atendente/admin.",
        "Sua tarefa:",
        "1. Extraia a PERGUNTA PRINCIPAL do cliente em uma frase curta e direta (max 120 caracteres). Ignore saudacoes, contexto extra, partes irrelevantes.",
        "2. Reformule a RESPOSTA do admin em linguagem profissional, clara e completa — preservando TODAS as informacoes, mas eliminando erros de digitacao, gírias e informalidades excessivas.",
        "",
        `MENSAGEM DO CLIENTE:\n${rawQuestion.trim()}`,
        "",
        `RESPOSTA DO ADMIN:\n${rawAnswer.trim()}`,
        "",
        'Retorne EXCLUSIVAMENTE um JSON valido no formato: {"question":"...","answer":"..."}'
      ].join("\n");

      const response = await fetch(`${managedAiProvider.baseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: managedAiProvider.model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "Voce e um assistente que extrai e reformula pares pergunta-resposta para uma base de conhecimento corporativa. Responda APENAS com JSON valido."
            },
            { role: "user", content: prompt }
          ]
        })
      });

      if (!response.ok) {
        console.warn(`[knowledge-entry-synthesis] IA retornou ${response.status}, usando valores brutos`);
        return fallback;
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) return fallback;

      const parsed = JSON.parse(content) as { question?: string; answer?: string };
      const question = parsed.question?.trim();
      const answer = parsed.answer?.trim();

      if (!question || !answer) return fallback;

      console.log(`[knowledge-entry-synthesis] pergunta sintetizada: "${question.slice(0, 80)}..."`);
      return { question, answer };
    } catch (err) {
      console.warn(`[knowledge-entry-synthesis] erro ao sintetizar, usando valores brutos:`, err);
      return fallback;
    }
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
      servicesAndPrices?: string | null;
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
    const normalizedLeadsPhoneNumber = leadsPhoneNumberRaw
      ? ensurePhoneCountryCode(leadsPhoneNumberRaw)
      : null;
    const existingConfig = await prisma.chatbotConfig.findUnique({
      where: {
        instanceId
      }
    });
    const audioEnabled = input.audioEnabled ?? existingConfig?.audioEnabled ?? false;
    const visionEnabled = input.visionEnabled ?? existingConfig?.visionEnabled ?? false;
    const visionPrompt = input.visionPrompt?.trim() ?? existingConfig?.visionPrompt ?? null;
    const responseDelayMs = Math.min(60_000, Math.max(0, input.responseDelayMs ?? existingConfig?.responseDelayMs ?? 10_000));
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
    const servicesAndPrices =
      input.servicesAndPrices !== undefined
        ? (input.servicesAndPrices?.trim() || null)
        : (existingConfig?.servicesAndPrices as string | null | undefined) ?? null;
    const preparedModules = this.prepareModulesForPersist(
      input.modules,
      existingConfig?.modules,
      normalizedLeadsPhoneNumber
    );

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
        servicesAndPrices,
        aiFallbackProvider: input.aiFallbackProvider ?? null,
        aiFallbackApiKey: input.aiFallbackApiKey?.trim()
          ? encrypt(input.aiFallbackApiKey.trim(), this.config.API_ENCRYPTION_KEY)
          : null,
        aiFallbackModel: input.aiFallbackModel?.trim() || null,
        modules: preparedModules.modules as unknown as Prisma.InputJsonValue
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
        servicesAndPrices,
        aiFallbackProvider: input.aiFallbackProvider ?? null,
        aiFallbackApiKey: input.aiFallbackApiKey?.trim()
          ? encrypt(input.aiFallbackApiKey.trim(), this.config.API_ENCRYPTION_KEY)
          : undefined,
        aiFallbackModel: input.aiFallbackModel?.trim() || null,
        modules: preparedModules.modules as unknown as Prisma.InputJsonValue
      } as Prisma.ChatbotConfigUncheckedUpdateInput
    });

    const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(preparedModules.modules);

    if (aprendizadoContinuoModule?.isEnabled !== true) {
      await prisma.conversation.updateMany({
        where: {
          instanceId,
          awaitingAdminResponse: true
        },
        data: {
          awaitingAdminResponse: false,
          pendingClientQuestion: null,
          pendingClientJid: null,
          pendingClientConversationId: null
        }
      });
    }

    if (preparedModules.verificationChallenge) {
      const currentInstance = await prisma.instance.findUnique({
        where: {
          id: instanceId
        },
        select: {
          status: true
        }
      });

      if (currentInstance?.status !== "CONNECTED") {
        console.warn("[aprendizado-continuo] instancia desconectada; desafio de verificacao segue pendente no painel", {
          instanceId,
          status: currentInstance?.status ?? "UNKNOWN"
        });
        return this.mapConfig(record, managedAiProvider);
      }

      const trackedVerification = await this.sendAprendizadoContinuoVerificationChallenge({
        tenantId,
        instanceId,
        adminPhone: preparedModules.verificationChallenge.adminPhone,
        code: preparedModules.verificationChallenge.code
      });

      if (trackedVerification) {
        const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(preparedModules.modules);

        if (aprendizadoContinuoModule) {
          const modulesWithTrackedChallenge = sanitizeChatbotModules({
            ...preparedModules.modules,
            aprendizadoContinuo: {
              ...aprendizadoContinuoModule,
              challengeMessageId: trackedVerification.externalMessageId,
              challengeRemoteJid: trackedVerification.remoteJid
            }
          });

          const updatedRecord = await prisma.chatbotConfig.update({
            where: {
              instanceId
            },
            data: {
              modules: modulesWithTrackedChallenge as unknown as Prisma.InputJsonValue
            }
          });

          return this.mapConfig(updatedRecord, managedAiProvider);
        }
      }
    }

    return this.mapConfig(record, managedAiProvider);
  }

  public async setLeadsPhoneNumber(
    tenantId: string,
    instanceId: string,
    phoneNumber: string
  ): Promise<ChatbotConfig> {
    const { prisma, managedAiProvider } = await this.getContext(tenantId, instanceId);
    const normalizedPhoneNumber = ensurePhoneCountryCode(phoneNumber);
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

  public simulateModules(
    modules: ChatbotModules,
    input: { phone: string; text: string; currentTime?: Date }
  ): { steps: ChatbotTraceStep[]; blocked: boolean; blockedReason?: string } {
    const steps: ChatbotTraceStep[] = [];
    const sanitized = sanitizeChatbotModules(modules as unknown);

    // Blacklist
    const blacklisted = isPhoneBlockedByBlacklist(sanitized, input.phone);
    steps.push({
      step: "blacklist",
      result: blacklisted ? "match" : "skip",
      detail: blacklisted ? `numero ${input.phone} bloqueado` : "numero nao bloqueado"
    });
    if (blacklisted) return { steps, blocked: true, blockedReason: "blacklist" };

    // Lista branca
    const allowed = isPhoneAllowedByListaBranca(sanitized, input.phone);
    steps.push({
      step: "lista_branca",
      result: !allowed ? "match" : "skip",
      detail: !allowed ? `numero ${input.phone} nao esta na lista` : "numero permitido"
    });
    if (!allowed) return { steps, blocked: true, blockedReason: "lista_branca" };

    // Horario de atendimento
    const horarioModule = getHorarioAtendimentoModuleConfig(sanitized);
    if (horarioModule?.isEnabled) {
      const within = isWithinHorarioAtendimento(horarioModule, input.currentTime);
      steps.push({
        step: "horario_atendimento",
        result: within ? "pass" : "match",
        detail: within ? "dentro do horario" : "fora do horario — mensagem bloqueada"
      });
      if (!within) return { steps, blocked: true, blockedReason: "fora_horario" };
    } else {
      steps.push({ step: "horario_atendimento", result: "skip", detail: "modulo desativado" });
    }

    // Palavra de pausa
    if (input.text) {
      const pauseResult = matchesPauseWord(sanitized, input.text);
      steps.push({
        step: "palavra_pausa",
        result: pauseResult.matched ? "match" : "skip",
        detail: pauseResult.matched ? "palavra detectada — bot pausado" : "nenhuma palavra de pausa"
      });
      if (pauseResult.matched) return { steps, blocked: true, blockedReason: "palavra_pausa" };
    }

    // Anti-spam (sem Redis na simulacao — apenas informa se esta habilitado)
    const antiSpamModule = getAntiSpamModuleConfig(sanitized);
    steps.push({
      step: "anti_spam",
      result: antiSpamModule?.isEnabled ? "pass" : "skip",
      detail: antiSpamModule?.isEnabled
        ? `max ${antiSpamModule.maxMensagens} msgs / ${antiSpamModule.intervaloMinutos} min (nao verificado em simulacao)`
        : "modulo desativado"
    });

    return { steps, blocked: false };
  }

  public async evaluateInbound(
    tenantId: string,
    instanceId: string,
    input: ChatbotRuntimeInput
  ): Promise<ChatbotSimulationResult | null> {
    const { config, managedAiProvider, prisma } = await this.getContext(tenantId, instanceId);

    if (!config.isEnabled) {
      console.warn("[chatbot] mensagem ignorada porque o chatbot principal esta desativado", {
        instanceId,
        tenantId,
        textPreview: input.text?.slice(0, 120) ?? ""
      });
      return null;
    }

    const result = await this.evaluateConfig(tenantId, prisma, config, managedAiProvider, input);

    if (result.action === "NO_MATCH") {
      console.warn("[chatbot] mensagem sem resposta apos avaliacao", {
        instanceId,
        tenantId,
        textPreview: input.text?.slice(0, 120) ?? ""
      });
    }

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
            "Voce e um assistente de atendimento via WhatsApp respondendo ao cliente.",
            "A conversa ja esta em andamento. Voce deve CONTINUAR a conversa de forma natural.",
            "",
            "REGRAS OBRIGATORIAS:",
            "- NUNCA comece com 'Ola' nem repita o nome do cliente — isso soa robotico no meio de uma conversa",
            "- NUNCA use frases como 'estou feliz em', 'fico feliz', 'terei prazer', 'fico a disposicao'",
            "- Use tom casual e direto, como se fosse uma mensagem de WhatsApp de verdade",
            "- Transmita a informacao de forma fluida e natural, sem anunciar que houve uma consulta",
            "- Maximo 2 frases. Se for disponibilidade de agenda, inclua os horarios de forma clara",
            "- Pode usar 1 emoji no maximo, se fizer sentido"
          ].join("\n"),
          messages: [
            {
              role: "user",
              content: [
                `Contexto: ${originalQuestion}`,
                `Informacao recebida: ${adminRawAnswer}`,
                "Escreva a mensagem para o cliente (sem aspas, sem introducao, direto ao ponto):"
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

  /**
   * Formula uma pergunta clara e contextualizada para o admin quando ocorre escalação.
   * Em vez de enviar a mensagem bruta do cliente ("Sim, quero fazer o site"),
   * sintetiza a DÚVIDA REAL com base no histórico da conversa:
   * Ex: "O cliente Gleidson quer saber se vocês oferecem desenvolvimento de sites.
   *     Se sim, qual seria o processo e os valores?"
   * Retorna o rawMessage original como fallback se a IA falhar.
   */
  public async formulateEscalationQuestionForAdmin(
    tenantId: string,
    instanceId: string,
    clientName: string | null,
    rawMessage: string,
    history: Array<{ role: "user" | "assistant"; content: string }>
  ): Promise<string> {
    const fallback = rawMessage.trim();

    try {
      const { config, managedAiProvider } = await this.getContext(tenantId, instanceId);

      if (
        !managedAiProvider.isConfigured ||
        !managedAiProvider.isActive ||
        !managedAiProvider.apiKeyEncrypted
      ) {
        return fallback;
      }

      const apiKey = decrypt(managedAiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);

      // Monta o resumo das últimas mensagens para dar contexto ao modelo
      const recentHistory = history.slice(-8).map((m) =>
        `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content.slice(0, 200)}`
      ).join("\n");

      const clientLabel = clientName ? `cliente "${clientName}"` : "o cliente";

      const response = await this.callAiWithFallback(
        tenantId,
        managedAiProvider,
        apiKey,
        {
          system: [
            "Você é um assistente que ajuda a formular perguntas para o administrador de uma empresa.",
            "O chatbot não conseguiu responder o cliente e precisa perguntar ao admin.",
            "Sua tarefa: analisar o histórico da conversa e formular UMA pergunta clara e direta para o admin.",
            "A pergunta deve explicar o contexto e o que o admin precisa informar para resolver a dúvida do cliente.",
            "Seja conciso (máximo 2 frases). Não use aspas na resposta. Escreva em português."
          ].join("\n"),
          messages: [
            {
              role: "user",
              content: [
                `Histórico recente da conversa com ${clientLabel}:`,
                recentHistory,
                "",
                `Última mensagem do cliente: "${rawMessage}"`,
                "",
                "Formule uma pergunta clara para o admin explicando o que o cliente precisa saber:"
              ].join("\n")
            }
          ]
        },
        0.2,
        config
      );

      const cleaned = response
        ?.replace(/\[TRANSBORDO_HUMANO\]/gi, "")
        .replace(/\[ESCALATE_ADMIN\]/gi, "")
        .trim();

      return cleaned || fallback;
    } catch (err) {
      console.warn("[chatbot:escalation-question] erro ao formular pergunta, usando fallback:", err);
      return fallback;
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
            "Voce e um fiscal de contexto rigoroso para um chatbot comercial.",
            "Sua tarefa e decidir se a pergunta do cliente pode ser respondida SOMENTE com base no contexto autorizado.",
            "Regras de decisao:",
            "1. O contexto deve mencionar o TOPICO EXATO da pergunta de forma explicita. Inferencias e relacionamentos implicitos NAO contam.",
            "2. Exemplo: contexto menciona 'JavaScript' NAO autoriza responder sobre React, Vue, Angular ou outras bibliotecas especificas.",
            "3. Exemplo: contexto menciona 'atendemos clientes' NAO autoriza responder sobre horarios, precos ou politicas especificas.",
            "4. Conhecimento geral do modelo de linguagem sobre empresas de tecnologia NAO conta como contexto.",
            "5. Se houver qualquer duvida sobre se o contexto cobre o topico, escolha [ESCALATE_ADMIN].",
            "Se o contexto trouxer suporte EXPLICITO e DIRETO para a pergunta especifica, responda com [ALLOW].",
            "Caso contrario, responda com [ESCALATE_ADMIN].",
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
    const now = Date.now();
    if (this.globalSystemPromptCache !== undefined && now < this.globalSystemPromptCache.expiresAt) {
      return this.globalSystemPromptCache.value;
    }

    const setting = await this.platformPrisma.platformSetting.findUnique({
      where: { key: chatbotGlobalSystemPromptSettingKey }
    });

    const resolvedPrompt = typeof setting?.value === "string" && setting.value.trim() ? setting.value.trim() : null;
    this.globalSystemPromptCache = { value: resolvedPrompt, expiresAt: now + 5 * 60 * 1000 };
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
            responseDelayMs: 10_000,
            leadAutoExtract: false,
            leadVehicleTable: {},
            leadPriceTable: {},
            leadSurchargeTable: {},
            servicesAndPrices: null,
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
    const traceEnabled = input.trace === true;
    const traceSteps: ChatbotTraceStep[] = [];

    const withTrace = (result: ChatbotSimulationResult): ChatbotSimulationResult =>
      traceEnabled ? { ...result, trace: traceSteps } : result;

    if (input.isFirstContact && config.welcomeMessage?.trim()) {
      traceSteps.push({ step: "welcome_message", result: "match", detail: "isFirstContact=true e welcomeMessage configurado" });
      return withTrace({
        action: "WELCOME",
        matchedRuleId: null,
        matchedRuleName: "Mensagem de boas-vindas",
        responseText: renderReplyTemplate(config.welcomeMessage, input)
      });
    }

    traceSteps.push({ step: "welcome_message", result: "skip", detail: `isFirstContact=${input.isFirstContact}` });

    if (config.ai.mode !== "AI_ONLY") {
      traceSteps.push({ step: "rules_evaluation", result: "pass", detail: `modo=${config.ai.mode}, avaliando ${config.rules.length} regras` });
      for (const rule of config.rules) {
        if (!matchesRule(rule, normalizedInput, input.isFirstContact)) {
          traceSteps.push({ step: `rule:${rule.name}`, result: "no_match", detail: `tipo=${rule.triggerType} valor="${rule.matchValue}"` });
          continue;
        }

        traceSteps.push({ step: `rule:${rule.name}`, result: "match", detail: `tipo=${rule.triggerType} valor="${rule.matchValue}"` });
        return withTrace({
          action: "MATCHED",
          matchedRuleId: rule.id,
          matchedRuleName: rule.name,
          responseText: renderReplyTemplate(rule.responseText, input)
        });
      }
    } else {
      traceSteps.push({ step: "rules_evaluation", result: "skip", detail: "modo=AI_ONLY" });
    }

    traceSteps.push({ step: "ai_evaluation", result: "pass", detail: `provider=${managedAiProvider.provider ?? "none"} modelo=${managedAiProvider.model}` });
    const aiResult = await this.evaluateWithAi(tenantId, prisma, config, managedAiProvider, input);

    if (aiResult) {
      traceSteps.push({ step: "ai_response", result: "match", detail: `action=${aiResult.action}` });
      return withTrace(aiResult);
    }

    traceSteps.push({ step: "ai_response", result: "no_match" });

    const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(config.modules);

    if (
      normalizedInput &&
      aprendizadoContinuoModule?.isEnabled === true &&
      aprendizadoContinuoModule.verificationStatus === "VERIFIED" &&
      this.isInstitutionalQuestion(input.text ?? "")
    ) {
      traceSteps.push({ step: "escalate_admin", result: "match", detail: "pergunta institucional sem resposta da IA" });
      return withTrace({
        action: "ESCALATE_ADMIN",
        matchedRuleId: null,
        matchedRuleName: "Fallback:institutional_question_without_ai_result",
        responseText: ""
      });
    }

    traceSteps.push({ step: "escalate_admin", result: "skip" });

    if (normalizedInput && config.fallbackMessage?.trim()) {
      traceSteps.push({ step: "fallback", result: "match", detail: "fallbackMessage configurado" });
      return withTrace({
        action: "FALLBACK",
        matchedRuleId: null,
        matchedRuleName: "Fallback",
        responseText: renderReplyTemplate(config.fallbackMessage, input)
      });
    }

    if (normalizedInput && aprendizadoContinuoModule?.isEnabled !== true) {
      traceSteps.push({ step: "fallback", result: "match", detail: "aprendizadoContinuo desativado" });
      return withTrace({
        action: "FALLBACK",
        matchedRuleId: null,
        matchedRuleName: "Fallback:aprendizado_continuo_disabled",
        responseText: defaultNoEscalationFallbackMessage
      });
    }

    if (normalizedInput) {
      traceSteps.push({ step: "fallback", result: "match", detail: "sem resposta correspondente" });
      return withTrace({
        action: "FALLBACK",
        matchedRuleId: null,
        matchedRuleName: "Fallback:no_match_without_response",
        responseText: defaultNoEscalationFallbackMessage
      });
    }

    traceSteps.push({ step: "no_match", result: "match", detail: "input vazio apos normalizacao" });
    return withTrace({
      action: "NO_MATCH",
      matchedRuleId: null,
      matchedRuleName: null,
      responseText: null
    });
  }

  private static maskKey(key: string | null): string | null {
    if (!key) return null;
    return key.length > 8 ? `${key.slice(0, 4)}...****` : '****';
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
      servicesAndPrices?: string | null;
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
    const sanitizedModules = sanitizeChatbotModules(record.modules);

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
      leadsPhoneNumber: record.leadsPhoneNumber
        ? (normalizeWhatsAppPhoneNumber(record.leadsPhoneNumber) ?? normalizePhoneNumber(record.leadsPhoneNumber))
        : null,
      leadsEnabled: record.leadsEnabled ?? true,
      fiadoEnabled: record.fiadoEnabled ?? false,
      audioEnabled: record.audioEnabled ?? false,
      visionEnabled: record.visionEnabled ?? false,
      visionPrompt: record.visionPrompt ?? null,
      responseDelayMs: record.responseDelayMs ?? 10_000,
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
      servicesAndPrices: record.servicesAndPrices ?? null,
      rules: chatbotRulesArraySchema.parse(record.rules),
      ai: this.buildRuntimeAiConfig(aiSettings, managedAiProvider),
      aiFallbackProvider: normalizeFallbackProvider(record.aiFallbackProvider),
      aiFallbackApiKey: record.aiFallbackApiKey
        ? decrypt(record.aiFallbackApiKey, this.config.API_ENCRYPTION_KEY)
        : null,
      aiFallbackModel: record.aiFallbackModel ?? null,
      modules: sanitizedModules,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }

  private prepareModulesForPersist(
    nextModules: ChatbotModules | undefined,
    existingModules: unknown,
    configuredAdminPhone: string | null
  ): {
    modules: ChatbotModules;
    verificationChallenge: {
      adminPhone: string;
      code: string;
    } | null;
  } {
    const sanitizedExistingModules = sanitizeChatbotModules(existingModules);
    const sanitizedModules = sanitizeChatbotModules(nextModules ?? sanitizedExistingModules);
    const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(sanitizedModules);

    if (!aprendizadoContinuoModule) {
      return {
        modules: sanitizedModules,
        verificationChallenge: null
      };
    }

    if (!aprendizadoContinuoModule.isEnabled) {
      return {
        modules: sanitizeChatbotModules({
          ...sanitizedModules,
          aprendizadoContinuo: {
            ...aprendizadoContinuoModule,
            isEnabled: false
          }
        }),
        verificationChallenge: null
      };
    }

    const normalizedConfiguredAdminPhone = configuredAdminPhone
      ? ensurePhoneCountryCode(configuredAdminPhone)
      : null;
    const isVerifiedForCurrentPhone = Boolean(
      normalizedConfiguredAdminPhone &&
      aprendizadoContinuoModule.verificationStatus === "VERIFIED" &&
      [aprendizadoContinuoModule.verifiedPhone, ...aprendizadoContinuoModule.verifiedPhones]
        .map((phone) => normalizePhoneNumber(phone ?? ""))
        .includes(normalizePhoneNumber(normalizedConfiguredAdminPhone))
    );

    if (!normalizedConfiguredAdminPhone) {
      return {
        modules: sanitizeChatbotModules({
          ...sanitizedModules,
          aprendizadoContinuo: {
            ...aprendizadoContinuoModule,
            isEnabled: true,
            verificationStatus: "UNVERIFIED",
            configuredAdminPhone: null,
            verifiedPhone: null,
            pendingCode: null,
            pendingCodeExpiresAt: null,
            lastVerificationRequestedAt: null,
            verifiedAt: null,
            challengeMessageId: null,
            challengeRemoteJid: null,
            verifiedPhones: [],
            verifiedRemoteJids: [],
            verifiedSenderJids: []
          }
        }),
        verificationChallenge: null
      };
    }

    if (isVerifiedForCurrentPhone) {
      return {
        modules: sanitizeChatbotModules({
          ...sanitizedModules,
          aprendizadoContinuo: {
            ...aprendizadoContinuoModule,
            isEnabled: true,
            configuredAdminPhone: normalizedConfiguredAdminPhone
          }
        }),
        verificationChallenge: null
      };
    }

    const currentPendingStillValid = Boolean(
      aprendizadoContinuoModule.verificationStatus === "PENDING" &&
      aprendizadoContinuoModule.configuredAdminPhone &&
      normalizePhoneNumber(aprendizadoContinuoModule.configuredAdminPhone) ===
        normalizePhoneNumber(normalizedConfiguredAdminPhone) &&
      aprendizadoContinuoModule.pendingCode &&
      aprendizadoContinuoModule.pendingCodeExpiresAt &&
      new Date(aprendizadoContinuoModule.pendingCodeExpiresAt).getTime() > Date.now()
    );
    const pendingCode = currentPendingStillValid && aprendizadoContinuoModule.pendingCode
      ? aprendizadoContinuoModule.pendingCode
      : generateAprendizadoContinuoVerificationCode();
    const requestedAt = new Date();

    return {
      modules: sanitizeChatbotModules({
        ...sanitizedModules,
        aprendizadoContinuo: {
          ...aprendizadoContinuoModule,
          isEnabled: true,
          verificationStatus: "PENDING",
          configuredAdminPhone: normalizedConfiguredAdminPhone,
          verifiedPhone: null,
          pendingCode,
          pendingCodeExpiresAt: new Date(requestedAt.getTime() + aprendizadoContinuoVerificationTtlMs).toISOString(),
          lastVerificationRequestedAt: requestedAt.toISOString(),
          verifiedAt: null,
          challengeMessageId: null,
          challengeRemoteJid: null,
          verifiedPhones: [],
          verifiedRemoteJids: [],
          verifiedSenderJids: []
        }
      }),
      verificationChallenge: {
        adminPhone: normalizedConfiguredAdminPhone,
        code: pendingCode
      }
    };
  }

  private async sendAprendizadoContinuoVerificationChallenge(params: {
    tenantId: string;
    instanceId: string;
    adminPhone: string;
    code: string;
  }): Promise<{
    externalMessageId: string | null;
    remoteJid: string | null;
  } | null> {
    if (!this.platformAlertService) {
      console.warn("[aprendizado-continuo] platformAlertService indisponivel para verificacao do admin");
      return null;
    }

    const message = [
      "*Confirmacao do admin*",
      "---------------",
      `Instancia: ${params.instanceId}`,
      "",
      "Abra o painel do tenant e use o codigo exibido la para confirmar este chat como admin da instancia.",
      "Responda exatamente com o codigo que esta no painel.",
      "Se nao foi voce, ignore esta mensagem."
    ].join("\n");

    const result = await this.platformAlertService.sendTrackedInstanceAlert(
      params.tenantId,
      params.instanceId,
      params.adminPhone,
      message
    );

    if (!result.delivered) {
      console.warn("[aprendizado-continuo] falha ao entregar desafio de verificacao do admin");
      return null;
    }

    return {
      externalMessageId: result.externalMessageId,
      remoteJid: result.remoteJid
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
          ? (await this.platformAlertService?.sendInstanceAlert(
              tenantId,
              conversation.instanceId,
              alertPhone,
              alertMessage
            )) ?? false
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

    const aprendizadoContinuoModule = getAprendizadoContinuoModuleConfig(config.modules);
    const hasAdminPhone = !!(
      aprendizadoContinuoModule?.verifiedPhone?.trim() ||
      (aprendizadoContinuoModule?.verifiedPhones ?? []).some(Boolean) ||
      (aprendizadoContinuoModule?.additionalAdminPhones ?? []).some(Boolean) ||
      config.leadsPhoneNumber?.trim()
    );
    const allowAdminEscalation =
      aprendizadoContinuoModule?.isEnabled === true &&
      aprendizadoContinuoModule.verificationStatus === "VERIFIED" &&
      hasAdminPhone;

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
        config.ai.maxContextMessages,
        allowAdminEscalation,
        config.modules,
        config.servicesAndPrices
      );

      if (
        allowAdminEscalation &&
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

      // ─── Google Calendar tool runtime (para compatibilidade) ────────────────
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

      // ─── Orquestrador de sub-agents ──────────────────────────────────────────
      // Quando Google Calendar NÃO está ativo, usa o OrchestratorAgent (2 etapas:
      // classificação de intenção + agent especializado).
      // Quando Google Calendar está ativo, mantém o fluxo direto (toolRuntime necessário).
      const googleCalendarActive = googleCalendarConfigResult.data?.isEnabled === true;

      let responseText: string | null;

      if (!googleCalendarActive) {
        // Monta callAi encapsulando o provider configurado.
        // Se o agent passar opts.model, cria um provider virtual com aquele modelo
        // (útil para o IntentRouter rodar no modelo leve enquanto os agents usam o 70B).
        const callAi: AiCaller = (system, messages, opts) => {
          const providerToUse: ManagedAiProviderRuntime =
            opts?.model && opts.model !== managedAiProvider.model
              ? { ...managedAiProvider, model: opts.model }
              : managedAiProvider;

          return this.callAiWithFallback(
            tenantId,
            providerToUse,
            apiKey,
            { system, messages },
            opts?.temperature ?? config.ai.temperature,
            config
          );
        };

        const agentCtx: AgentContext = {
          tenantId,
          instanceId: config.instanceId,
          isFirstContact: input.isFirstContact,
          history: conversation.messages,
          blocks: conversation.blocks,
          modules: config.modules ?? undefined,
          allowAdminEscalation,
          callAi
        };

        responseText = await this.orchestratorAgent.process(agentCtx);
      } else {
        // Fluxo direto com toolRuntime (Google Calendar)
        responseText = await this.callAiWithFallback(
          tenantId,
          managedAiProvider,
          apiKey,
          conversation,
          config.ai.temperature,
          config,
          toolRuntime
        );
      }

      if (!responseText) {
        return null;
      }

      // Agendamento via Admin: detecta [AGENDAR_ADMIN:{...}] antes de outros marcadores
      const agendamentoAdminModuleConfig = getAgendamentoAdminModuleConfig(config.modules ?? undefined);
      const schedulingMatch = /\[AGENDAR_ADMIN:(\{[^[\]]*\})\]/i.exec(responseText);

      if (schedulingMatch && agendamentoAdminModuleConfig?.isEnabled && !googleCalendarActive) {
        const cleanedResponse = responseText.replace(/\[AGENDAR_ADMIN:\{[^[\]]*\}\]/gi, "").trim();
        try {
          const payload = JSON.parse(schedulingMatch[1]) as { assunto?: string; dataPreferencia?: string; clientName?: string };
          const assunto = (payload.assunto ?? "").trim();
          const dataPreferencia = (payload.dataPreferencia ?? "").trim();
          if (assunto && dataPreferencia) {
            return {
              action: "SCHEDULING_REQUEST",
              matchedRuleId: null,
              matchedRuleName: `${managedAiProvider.provider}:scheduling_request`,
              responseText: cleanedResponse || agendamentoAdminModuleConfig.clientPendingMessage,
              schedulingPayload: {
                assunto,
                dataPreferencia,
                clientName: (payload.clientName ?? input.contactName ?? "Cliente").trim(),
                clientPendingMessage: cleanedResponse || agendamentoAdminModuleConfig.clientPendingMessage,
                adminAlertTemplate: agendamentoAdminModuleConfig.adminAlertTemplate,
                adminPhone: agendamentoAdminModuleConfig.adminPhone ?? null
              }
            };
          }
        } catch {
          // JSON parse falhou, trata como resposta normal
        }
      }

      const isHandoff = /\[TRANSBORDO_HUMANO\]/i.test(responseText);
      const cleanedText = responseText.replace(/\[TRANSBORDO_HUMANO\]/gi, "").trim();
      const isEscalation = /\[ESCALATE_ADMIN\]/i.test(responseText);

      // Deteccao de fallback: IA disse "vou verificar/confirmar/checar" sem emitir o marcador correto.
      // Trata como escalacao implicita para evitar que a conversa trave sem acao.
      const implicitCheckPhrases = /\b(vou verificar|vou confirmar|vou checar|deixa eu verificar|deixa eu confirmar|vou consultar|vou perguntar|aguarde que vou|vou ver com|vou falar com)\b/i;
      const hasNoMarker = !isEscalation && !isHandoff && !schedulingMatch;
      const isImplicitEscalation = hasNoMarker && allowAdminEscalation && implicitCheckPhrases.test(responseText);
      const isImplicitScheduling = hasNoMarker && !isImplicitEscalation &&
        agendamentoAdminModuleConfig?.isEnabled && !googleCalendarActive &&
        /\b(vou verificar a disponibilidade|vou checar a agenda|vou confirmar a disponibilidade|vou ver a agenda)\b/i.test(responseText);

      if (isEscalation) {
        if (!allowAdminEscalation) {
          return {
            action: "AI",
            matchedRuleId: null,
            matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}:fallback_without_escalation`,
            responseText: cleanedText || config.fallbackMessage?.trim() || defaultNoEscalationFallbackMessage
          };
        }

        return {
          action: "ESCALATE_ADMIN",
          matchedRuleId: null,
          matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}`,
          responseText: ""
        };
      }

      // Escalacao implicita: IA disse "vou verificar" sem emitir [ESCALATE_ADMIN]
      if (isImplicitEscalation) {
        console.warn(`[chatbot:ai] escalacao implicita detectada — IA disse "vou verificar" sem marcador. Convertendo para ESCALATE_ADMIN.`);
        return {
          action: "ESCALATE_ADMIN",
          matchedRuleId: null,
          matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}:implicit_escalation`,
          responseText: ""
        };
      }

      // Agendamento implicito: IA disse "vou verificar disponibilidade" sem emitir [AGENDAR_ADMIN]
      if (isImplicitScheduling) {
        console.warn(`[chatbot:ai] agendamento implicito detectado — IA disse "vou verificar disponibilidade" sem marcador. Convertendo para ESCALATE_ADMIN.`);
        return {
          action: "ESCALATE_ADMIN",
          matchedRuleId: null,
          matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}:implicit_scheduling`,
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
      return {
        action: "AI",
        matchedRuleId: null,
        matchedRuleName: `${managedAiProvider.provider}:${managedAiProvider.model}:error_fallback`,
        responseText: renderReplyTemplate(
          config.fallbackMessage?.trim() || defaultAiErrorFallbackMessage,
          input
        )
      };
    }
  }

  private async buildAiConversation(
    prisma: Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>,
    tenantId: string,
    instanceId: string,
    input: ChatbotRuntimeInput,
    systemPrompt: string,
    maxContextMessages: number,
    allowAdminEscalation: boolean,
    modules?: ChatbotModules,
    servicesAndPrices?: string | null
  ): Promise<{
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    groundingContext: string;
    blocks: ContextBlocks;
  }> {
    const normalizedPhoneNumber = normalizePhoneNumber(input.phoneNumber);
    const baseSystemPrompt = systemPrompt.trim() || defaultAiSettings.systemPrompt;
    const globalSystemPrompt = await this.getGlobalSystemPrompt();
    // Blocos individuais para os sub-agents
    let memoryMdBlock = "";
    let clientContextBlock = "";
    let knowledgeBlockContent = "";
    let persistentMemoryBlockContent = "";
    const systemParts = [
      ...(globalSystemPrompt ? [`### PROMPT GLOBAL DA PLATAFORMA ###\n${globalSystemPrompt}`] : []),
      baseSystemPrompt,
      `Data atual: ${formatDate(new Date())} ${formatTime(new Date())}.`,
      `Numero exato do cliente: ${normalizedPhoneNumber}.`,
      "### REGRAS GERAIS ###",
      "1. BREVIDADE OBRIGATORIA: Cada mensagem deve ter no maximo 2-3 frases curtas. Nunca escreva paragrafos longos. Se precisar de mais de uma mensagem, separe com '|||' (ex: 'Ola!|||Como posso te ajudar?'). PROIBIDO: listas com bullets/numeros, textos explicativos longos, resumos formatados.",
      '2. Use o nome do cliente somente se ele aparecer na MEMORIA DO CLIENTE (bloco abaixo). Se ele disser o nome durante a conversa, use o que ele disser. Nunca use placeholders como {nome} ou [nome]. Se nao souber o nome, nao use nome nenhum.',
      "3. NUNCA invente blocos de formatacao como 'Resumo do agendamento:', 'Dados coletados:', 'Aqui esta o resumo:' etc. Confirme informacoes de forma natural e conversacional.",
      "4. Cumprimentos como 'oi', 'ola', 'bom dia', 'boa tarde', 'boa noite' sao SEMPRE abertura de conversa — nunca encerramento. Responda com entusiasmo e pergunte como pode ajudar.",
      "5. Nunca invente informacoes, precos, datas ou dados que nao estao no contexto.",
      "6. Se o cliente parecer frustrado ou impaciente, reconheca antes de responder.",
      "7. Quando o cliente se despedir explicitamente (tchau, ate logo, ate mais, falou etc), responda de forma calorosa e diga que fica a disposicao. Se o cliente disser apenas 'obrigado' ou 'valeu', responda brevemente e deixe claro que continua disponivel.",
      "8. Nunca diga que voce e uma IA a menos que o cliente pergunte diretamente.",
      "9. Se o cliente perguntar seu nome, use o nome definido no prompt da instancia.",
      "10. Perguntas sobre a propria empresa, servicos oferecidos, horarios, equipe, visitas presenciais, quantidade de funcionarios, capacidade tecnica ou politicas internas so podem ser respondidas se a informacao estiver EXPLICITAMENTE no contexto autorizado.",
      allowAdminEscalation
        ? "11. Se a pergunta institucional nao estiver explicitamente documentada no prompt da instancia, no memory.md ou no conhecimento aprendido, responda com [ESCALATE_ADMIN]."
        : "11. Se faltar contexto institucional, diga de forma breve e honesta que nao tem essa informacao agora, sem inventar e sem usar [ESCALATE_ADMIN]. NUNCA diga 'vou verificar', 'vou confirmar', 'aguarde que vou checar' ou qualquer variacao — voce nao consegue consultar ninguem. Responda diretamente o que sabe ou admita que nao tem a informacao.",
      "12. Nunca use suposicoes sobre o que empresas de tecnologia normalmente fazem.",
      "13. AGENDAMENTOS: Gerar reuniao/contato e sua principal missao. Regras OBRIGATORIAS:",
      "    a) Se o nome do cliente ja esta na MEMORIA DO CLIENTE, NAO pergunte o nome novamente. Va direto para o interesse.",
      "    b) Colete nome (se nao tiver na memoria) e objetivo em NO MAXIMO 2 perguntas. Cada pergunta = 1 mensagem curta.",
      "    c) Com nome + objetivo: PROPONHA A REUNIAO IMEDIATAMENTE. Nao pergunte mais nada antes.",
      "    d) Nunca aprofunde tecnicalidades, orcamentos ou escopo antes da reuniao — isso e papel da reuniao.",
      "    e) Fluxo ideal: saudacao -> (perguntar nome se necessario) -> perguntar interesse -> propor reuniao.",
      "    e) Nunca confirme data/horario fixo sem verificar disponibilidade real."
    ];
    const groundingSources = [
      ...(globalSystemPrompt ? [globalSystemPrompt] : []),
      baseSystemPrompt
    ];

    const memoryFilePath = join(this.config.DATA_DIR, "tenants", tenantId, "instances", instanceId, "memory.md");
    try {
      const memoryContent = await readFile(memoryFilePath, "utf-8");
      if (memoryContent.trim()) {
        memoryMdBlock = memoryContent.trim();
        systemParts.push(`\n--- CONTEXTO LOCAL (memory.md) ---\n${memoryContent.trim()}`);
        groundingSources.push(memoryContent.trim());
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (input.clientContext?.trim()) {
      clientContextBlock = input.clientContext.trim();
      systemParts.push(input.clientContext.trim());
      groundingSources.push(input.clientContext.trim());
    }

    if (this.knowledgeService) {
      const knowledgeBlock = await this.knowledgeService.buildContextBlock(tenantId, instanceId);
      if (knowledgeBlock) {
        knowledgeBlockContent = knowledgeBlock;
        systemParts.push(knowledgeBlock);
        groundingSources.push(knowledgeBlock);
      }
    }

    // Bloco de serviços e preços — documento de referência separado do prompt comportamental.
    // A IA deve consultar este bloco como tabela de consulta, não como instrução de atendimento.
    let servicesAndPricesBlock = "";
    if (servicesAndPrices?.trim()) {
      servicesAndPricesBlock = [
        "### TABELA DE SERVICOS E PRECOS (DOCUMENTO DE REFERENCIA) ###",
        "ATENCAO: Use EXATAMENTE os valores abaixo. Ao identificar a categoria do cliente, consulte a linha correspondente e use o preco EXATO — nao misture categorias.",
        servicesAndPrices.trim()
      ].join("\n");
      systemParts.push(servicesAndPricesBlock);
      groundingSources.push(servicesAndPricesBlock);
    }

    const memoriaModule = getMemoriaPersonalizadaModuleConfig(modules);
    if (memoriaModule?.isEnabled && memoriaModule.fields.length > 0 && this.persistentMemoryService) {
      const memData = await this.persistentMemoryService.getData(tenantId, instanceId, normalizedPhoneNumber);
      const memBlock = this.persistentMemoryService.buildContextBlock(memData, memoriaModule.fields);
      if (memBlock) {
        persistentMemoryBlockContent = memBlock;
        systemParts.push(memBlock);
      }
    }

    if (allowAdminEscalation) {
      systemParts.push([
        "### REGRA DE ESCALACAO ###",
        "Se voce nao tem certeza sobre a resposta ou a informacao nao esta no seu contexto:",
        "1. NAO invente ou adivinhe respostas",
        "2. NAO responda de forma vaga como 'nao sei' ou 'entre em contato conosco'",
        "3. Responda EXATAMENTE com o token: [ESCALATE_ADMIN] — sem texto adicional.",
        "4. NUNCA escreva 'vou verificar', 'vou confirmar', 'vou checar', 'aguarde que consulto' ou similares SEM incluir [ESCALATE_ADMIN] na mesma mensagem. Se voce quer verificar algo, use [ESCALATE_ADMIN] — o sistema cuida do resto.",
        "5. Use [ESCALATE_ADMIN] somente quando genuinamente nao souber - para perguntas gerais, responda normalmente.",
        "Exemplos de quando escalar: preco especifico de um produto, informacao interna da empresa, dado que nao foi fornecido.",
        "Exemplos de quando NAO escalar: saudacoes, perguntas genericas, informacoes que estao no contexto."
      ].join("\n"));
    } else {
      systemParts.push([
        "### REGRA QUANDO FALTAR CONTEXTO ###",
        "Se a informacao nao estiver clara no contexto, responda de forma breve e honesta.",
        "Nao invente, nao use [ESCALATE_ADMIN] e nao transfira para o admin.",
        "Ofereca ajuda apenas com o que estiver realmente disponivel no contexto."
      ].join("\n"));
    }

    // Trunca partes opcionais do system prompt se estimativa de tokens ultrapassar limite
    // Estimativa: chars / 4 ≈ tokens (regra geral para PT-BR)
    const MAX_SYSTEM_TOKENS = 6000;
    const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
    const truncatableIndexes = [2, 3]; // índices de memória local e clientContext — os mais variáveis
    let systemJoined = systemParts.join("\n");
    if (estimateTokens(systemJoined) > MAX_SYSTEM_TOKENS) {
      for (const idx of truncatableIndexes) {
        if (systemParts[idx] && estimateTokens(systemJoined) > MAX_SYSTEM_TOKENS) {
          const original = systemParts[idx]!;
          const maxChars = Math.max(200, original.length - (estimateTokens(systemJoined) - MAX_SYSTEM_TOKENS) * 4);
          systemParts[idx] = original.slice(0, maxChars) + "\n[...truncado por limite de contexto]";
          systemJoined = systemParts.join("\n");
        }
      }
    }
    const system = systemJoined;

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

    const blocks: ContextBlocks = {
      globalSystemPrompt: globalSystemPrompt ?? "",
      baseSystemPrompt,
      memoryMd: memoryMdBlock,
      clientContext: clientContextBlock,
      knowledge: knowledgeBlockContent,
      servicesAndPrices: servicesAndPricesBlock,
      persistentMemory: persistentMemoryBlockContent,
      phoneNumber: normalizedPhoneNumber,
      currentDateLine: `Data atual: ${formatDate(new Date())} ${formatTime(new Date())}.`
    };

    return {
      system,
      messages,
      groundingContext: groundingSources.join("\n\n").trim(),
      blocks
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
    const isGroqProvider = primaryProviderLabel === "GROQ" || primaryProviderLabel === "OPENAI_COMPATIBLE";

    try {
      const result = await this.requestOpenAiCompatibleCompletion(
        managedAiProvider,
        apiKey,
        conversation,
        temperature,
        toolRuntime
      );
      if (isGroqProvider) {
        this.groqKeyRotator.reportSuccess(apiKey);
      }
      return result;
    } catch (err: unknown) {
      const fetchErr = err as { status?: number; statusCode?: number; message?: string };
      const status = fetchErr?.status ?? fetchErr?.statusCode;
      const isRateLimit = status === 429;
      const isServerError = status !== undefined && status >= 500;

      if (isGroqProvider && isRateLimit) {
        this.groqKeyRotator.reportFailure(apiKey, status ?? 429);

        const alternativeKeys = this.groqKeyRotator.availableKeys().filter((k) => k !== apiKey);
        for (const altKey of alternativeKeys) {
          console.warn(`[chatbot:ai] ${primaryProviderLabel} 429, tentando chave alternativa GROQ ...${altKey.slice(-6)}`);
          try {
            const result = await this.requestOpenAiCompatibleCompletion(
              managedAiProvider,
              altKey,
              conversation,
              temperature,
              toolRuntime
            );
            this.groqKeyRotator.reportSuccess(altKey);
            return result;
          } catch (altErr: unknown) {
            const altStatus = (altErr as { status?: number })?.status;
            this.groqKeyRotator.reportFailure(altKey, altStatus ?? 500);
            console.warn(`[chatbot:ai] chave alternativa ...${altKey.slice(-6)} falhou (${altStatus})`);
          }
        }

        console.warn(`[chatbot:ai] todas as chaves GROQ indisponiveis, tentando fallback externo`);
      }

      if (
        (isRateLimit || isServerError) &&
        config.aiFallbackProvider &&
        (config.aiFallbackProvider === "ollama" || config.aiFallbackApiKey)
      ) {
        console.warn(
          `[chatbot:ai] ${primaryProviderLabel} falhou (${status}), tentando fallback: ${config.aiFallbackProvider}`
        );
        await this.notifyAdminFallback(tenantId, config, primaryProviderLabel, status ?? 0);
        try {
          return await this.callFallbackProvider(
            config.aiFallbackProvider,
            config.aiFallbackApiKey ?? "",
            config.aiFallbackModel ?? undefined,
            conversation,
            temperature
          );
        } catch (fallbackErr) {
          console.error(
            `[chatbot:ai] fallback ${config.aiFallbackProvider} falhou apos erro do provider principal:`,
            fallbackErr
          );
          throw fallbackErr;
        }
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
      const geminiModel = model?.trim() || "gemini-1.5-flash";
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
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
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {
          // ignore
        }
        console.error(`[chatbot:ai:gemini] erro ${response.status} para modelo "${geminiModel}":`, errorBody.slice(0, 300));
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

