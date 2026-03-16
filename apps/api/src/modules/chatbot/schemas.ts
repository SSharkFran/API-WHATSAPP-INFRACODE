import { z } from "zod";

export const chatbotTriggerTypeSchema = z.enum(["EXACT", "CONTAINS", "REGEX", "FIRST_CONTACT"]);

export const chatbotRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2).max(80),
  triggerType: chatbotTriggerTypeSchema,
  matchValue: z.string().max(240).nullable().optional(),
  responseText: z.string().min(1).max(2_000),
  isActive: z.boolean().default(true)
});

export const chatbotConfigSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  isEnabled: z.boolean(),
  welcomeMessage: z.string().nullable(),
  fallbackMessage: z.string().nullable(),
  rules: z.array(chatbotRuleSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const upsertChatbotBodySchema = z.object({
  isEnabled: z.boolean().default(false),
  welcomeMessage: z.string().max(2_000).nullable().optional(),
  fallbackMessage: z.string().max(2_000).nullable().optional(),
  rules: z.array(chatbotRuleSchema).max(50).default([])
});

export const chatbotSimulationBodySchema = z.object({
  text: z.string().max(2_000).default(""),
  isFirstContact: z.boolean().default(false),
  contactName: z.string().max(120).optional(),
  phoneNumber: z.string().min(8).max(32).default("5511999999999")
});

export const chatbotSimulationResponseSchema = z.object({
  action: z.enum(["MATCHED", "WELCOME", "FALLBACK", "NO_MATCH"]),
  matchedRuleId: z.string().nullable().optional(),
  matchedRuleName: z.string().nullable().optional(),
  responseText: z.string().nullable().optional()
});
