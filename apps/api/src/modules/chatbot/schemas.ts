import { z } from "zod";

export const chatbotTriggerTypeSchema = z.enum(["EXACT", "CONTAINS", "REGEX", "FIRST_CONTACT"]);
export const chatbotAiModeSchema = z.enum(["RULES_ONLY", "RULES_THEN_AI", "AI_ONLY"]);
export const chatbotAiProviderSchema = z.enum(["OPENAI_COMPATIBLE"]);

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
  provider: chatbotAiProviderSchema.default("OPENAI_COMPATIBLE"),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  model: z.string().max(120).default(""),
  systemPrompt: z.string().max(4_000).default(""),
  temperature: z.number().min(0).max(2).default(0.4),
  maxContextMessages: z.number().int().min(1).max(30).default(12),
  hasApiKey: z.boolean().default(false)
});

export const upsertChatbotAiBodySchema = z.object({
  isEnabled: z.boolean().default(false),
  mode: chatbotAiModeSchema.default("RULES_THEN_AI"),
  provider: chatbotAiProviderSchema.default("OPENAI_COMPATIBLE"),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  model: z.string().max(120).default(""),
  systemPrompt: z.string().max(4_000).default(""),
  temperature: z.number().min(0).max(2).default(0.4),
  maxContextMessages: z.number().int().min(1).max(30).default(12),
  apiKey: z.string().min(10).max(500).optional()
});

export const chatbotConfigSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  isEnabled: z.boolean(),
  welcomeMessage: z.string().nullable(),
  fallbackMessage: z.string().nullable(),
  rules: z.array(chatbotRuleSchema),
  ai: chatbotAiConfigSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const upsertChatbotBodySchema = z.object({
  isEnabled: z.boolean().default(false),
  welcomeMessage: z.string().max(2_000).nullable().optional(),
  fallbackMessage: z.string().max(2_000).nullable().optional(),
  rules: z.array(chatbotRuleSchema).max(50).default([]),
  ai: upsertChatbotAiBodySchema.optional()
});

export const chatbotSimulationBodySchema = z.object({
  text: z.string().max(2_000).default(""),
  isFirstContact: z.boolean().default(false),
  contactName: z.string().max(120).optional(),
  phoneNumber: z.string().min(8).max(32).default("5511999999999")
});

export const chatbotSimulationResponseSchema = z.object({
  action: z.enum(["MATCHED", "WELCOME", "FALLBACK", "AI", "NO_MATCH"]),
  matchedRuleId: z.string().nullable().optional(),
  matchedRuleName: z.string().nullable().optional(),
  responseText: z.string().nullable().optional()
});
