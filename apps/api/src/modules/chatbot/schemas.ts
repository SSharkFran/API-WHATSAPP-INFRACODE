import { z } from "zod";

export const chatbotTriggerTypeSchema = z.enum(["EXACT", "CONTAINS", "REGEX", "FIRST_CONTACT"]);
export const chatbotAiModeSchema = z.enum(["RULES_ONLY", "RULES_THEN_AI", "AI_ONLY"]);
export const chatbotAiProviderSchema = z.enum(["GROQ", "OPENAI_COMPATIBLE"]);
export const chatbotFallbackProviderSchema = z.enum(["openai", "gemini", "ollama"]);
const chatbotJsonMapSchema = z.record(z.string(), z.unknown());
export const clientMemoryStatusSchema = z.enum([
  "lead_frio",
  "lead_quente",
  "cliente_ativo",
  "projeto_encerrado",
  "sem_interesse"
]);
export const clientMemoryTagSchema = z.enum([
  "follow_up",
  "cliente_antigo",
  "sem_resposta",
  "orcamento_enviado",
  "fechado",
  "paused_by_human"
]);

export const chatbotRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2).max(80),
  triggerType: chatbotTriggerTypeSchema,
  matchValue: z.string().max(240).nullable().optional(),
  responseText: z.string().min(1).max(2_000),
  isActive: z.boolean().default(true)
});

export const chatbotAiConfigSchema = z.object({
  isEnabled: z.boolean().default(false),
  mode: chatbotAiModeSchema.default("RULES_THEN_AI"),
  provider: chatbotAiProviderSchema.nullable().default(null),
  model: z.string().max(120).default(""),
  systemPrompt: z.string().max(8_000).default(""),
  temperature: z.number().min(0).max(2).default(0.4),
  maxContextMessages: z.number().int().min(1).max(30).default(12),
  isManagedByAdmin: z.boolean().default(true),
  isProviderConfigured: z.boolean().default(false),
  isProviderActive: z.boolean().default(false)
});

export const upsertChatbotAiBodySchema = z.object({
  isEnabled: z.boolean().default(false),
  mode: chatbotAiModeSchema.default("RULES_THEN_AI"),
  systemPrompt: z.string().max(8_000).default(""),
  temperature: z.number().min(0).max(2).default(0.4),
  maxContextMessages: z.number().int().min(1).max(30).default(12)
});

export const chatbotConfigSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  isEnabled: z.boolean(),
  welcomeMessage: z.string().nullable(),
  fallbackMessage: z.string().nullable(),
  humanTakeoverStartMessage: z.string().nullable().optional(),
  humanTakeoverEndMessage: z.string().nullable().optional(),
  leadsGroupJid: z.string().nullable().optional(),
  leadsGroupName: z.string().nullable().optional(),
  leadsPhoneNumber: z.string().nullable().optional(),
  leadsEnabled: z.boolean().default(true),
  fiadoEnabled: z.boolean().default(false),
  audioEnabled: z.boolean().default(false),
  visionEnabled: z.boolean().default(false),
  visionPrompt: z.string().nullable().optional(),
  responseDelayMs: z.number().int().min(0).max(60_000).default(3_000),
  leadAutoExtract: z.boolean().default(false),
  leadVehicleTable: chatbotJsonMapSchema.default({}),
  leadPriceTable: chatbotJsonMapSchema.default({}),
  leadSurchargeTable: chatbotJsonMapSchema.default({}),
  rules: z.array(chatbotRuleSchema),
  ai: chatbotAiConfigSchema,
  aiFallbackProvider: chatbotFallbackProviderSchema.nullable().optional(),
  aiFallbackApiKey: z.string().nullable().optional(),
  aiFallbackModel: z.string().nullable().optional(),
  modules: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const upsertChatbotBodySchema = z.object({
  isEnabled: z.boolean().default(false),
  welcomeMessage: z.string().max(2_000).nullable().optional(),
  fallbackMessage: z.string().max(2_000).nullable().optional(),
  humanTakeoverStartMessage: z.string().max(2_000).nullable().optional(),
  humanTakeoverEndMessage: z.string().max(2_000).nullable().optional(),
  rules: z.array(chatbotRuleSchema).max(50).default([]),
  ai: upsertChatbotAiBodySchema.optional(),
  leadsPhoneNumber: z.string().min(10).max(20).nullable().optional(),
  leadsEnabled: z.boolean().default(true),
  fiadoEnabled: z.boolean().default(false),
  audioEnabled: z.boolean().default(false),
  visionEnabled: z.boolean().default(false),
  visionPrompt: z.string().max(1_000).nullable().optional(),
  responseDelayMs: z.number().int().min(0).max(60_000).default(3_000),
  leadAutoExtract: z.boolean().default(false),
  leadVehicleTable: chatbotJsonMapSchema.optional(),
  leadPriceTable: chatbotJsonMapSchema.optional(),
  leadSurchargeTable: chatbotJsonMapSchema.optional(),
  aiFallbackProvider: chatbotFallbackProviderSchema.nullable().optional(),
  aiFallbackApiKey: z.string().max(512).nullable().optional(),
  aiFallbackModel: z.string().max(120).nullable().optional(),
  modules: z.record(z.string(), z.unknown()).optional()
});

export const upsertLeadsPhoneBodySchema = z.object({
  leadsPhoneNumber: z.string().min(10).max(20).nullable().optional(),
  leadsEnabled: z.boolean().default(true)
});

export const clientMemorySchema = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  name: z.string().nullable().optional(),
  isExistingClient: z.boolean(),
  projectDescription: z.string().nullable().optional(),
  serviceInterest: z.string().nullable().optional(),
  status: clientMemoryStatusSchema,
  tags: z.array(clientMemoryTagSchema),
  notes: z.string().nullable().optional(),
  lastContactAt: z.string(),
  scheduledAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const clientMemoryListQuerySchema = z.object({
  status: clientMemoryStatusSchema.optional(),
  tag: clientMemoryTagSchema.optional()
});

export const clientMemoryParamsSchema = z.object({
  id: z.string().min(1),
  phone: z.string().min(8).max(32)
});

export const upsertClientMemoryBodySchema = z.object({
  status: clientMemoryStatusSchema.optional(),
  tags: z.array(clientMemoryTagSchema).max(20).optional(),
  notes: z.string().max(4_000).nullable().optional()
});

export const chatbotSimulationBodySchema = z.object({
  text: z.string().max(2_000).default(""),
  isFirstContact: z.boolean().default(false),
  contactName: z.string().max(120).optional(),
  phoneNumber: z.string().min(8).max(32).default("5511999999999")
});

export const chatbotSimulationResponseSchema = z.object({
  action: z.enum(["MATCHED", "WELCOME", "FALLBACK", "AI", "HUMAN_HANDOFF", "NO_MATCH"]),
  matchedRuleId: z.string().nullable().optional(),
  matchedRuleName: z.string().nullable().optional(),
  responseText: z.string().nullable().optional()
});

export const googleCalendarModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  calendarId: z.string().min(1)
});
