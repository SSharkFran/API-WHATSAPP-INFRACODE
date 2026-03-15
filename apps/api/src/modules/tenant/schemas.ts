import { z } from "zod";

export const tenantSettingsBodySchema = z.object({
  billingEmail: z.string().email().nullable().optional(),
  name: z.string().min(3).max(120).optional()
});

export const inviteTenantUserBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(["ADMIN", "OPERATOR", "VIEWER"])
});

export const tenantUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
  isActive: z.boolean(),
  twoFactorEnabled: z.boolean(),
  lastLoginAt: z.string().nullable()
});

export const tenantApiKeyScopeSchema = z.enum(["read", "write", "admin"]);

export const createTenantApiKeyBodySchema = z.object({
  name: z.string().min(3).max(80),
  scopes: z.array(tenantApiKeyScopeSchema).min(1),
  expiresAt: z.string().datetime().optional()
});

export const tenantApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(tenantApiKeyScopeSchema),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string()
});

export const tenantApiKeyCreateResponseSchema = tenantApiKeySchema.extend({
  apiKey: z.string()
});

export const tenantApiKeyParamsSchema = z.object({
  id: z.string().min(1)
});

export const onboardingStepSchema = z.object({
  code: z.string(),
  label: z.string(),
  completed: z.boolean()
});

export const onboardingResponseSchema = z.object({
  tenantId: z.string(),
  tenantSlug: z.string(),
  currentStep: z.string(),
  completedAt: z.string().nullable(),
  steps: z.array(onboardingStepSchema)
});

export const tenantDashboardSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  activeInstances: z.number().int(),
  totalInstances: z.number().int(),
  connectedInstances: z.number().int(),
  queuedMessages: z.number().int(),
  messagesThisMonth: z.number().int(),
  messagesPerMonth: z.number().int(),
  usersUsed: z.number().int(),
  usersLimit: z.number().int()
});
