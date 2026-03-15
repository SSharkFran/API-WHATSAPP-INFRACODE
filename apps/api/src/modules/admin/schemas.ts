import { z } from "zod";

export const tenantCreateBodySchema = z.object({
  name: z.string().min(3).max(120),
  slug: z.string().min(3).max(64).regex(/^[a-z0-9-]+$/),
  billingEmail: z.string().email().optional(),
  planId: z.string().min(1),
  firstAdminEmail: z.string().email(),
  firstAdminRole: z.enum(["ADMIN", "OPERATOR", "VIEWER"]).default("ADMIN"),
  nextDueAt: z.string().datetime().optional()
});

export const tenantUpdateBodySchema = z.object({
  name: z.string().min(3).max(120).optional(),
  billingEmail: z.string().email().nullable().optional(),
  planId: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "CANCELED"]).optional(),
  instanceLimit: z.number().int().min(1).optional(),
  messagesPerMonth: z.number().int().min(1).optional(),
  usersLimit: z.number().int().min(1).optional(),
  rateLimitPerMinute: z.number().int().min(1).optional()
});

export const tenantParamsSchema = z.object({
  id: z.string().min(1)
});

export const planBodySchema = z.object({
  code: z.string().min(2).max(32).regex(/^[A-Z0-9_]+$/),
  name: z.string().min(3).max(120),
  description: z.string().max(500).optional(),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3).default("BRL"),
  instanceLimit: z.number().int().min(1),
  messagesPerMonth: z.number().int().min(1),
  usersLimit: z.number().int().min(1),
  rateLimitPerMinute: z.number().int().min(1)
});

export const planParamsSchema = z.object({
  id: z.string().min(1)
});

export const platformSettingSchema = z.object({
  key: z.string().min(1),
  value: z.unknown()
});

export const impersonationBodySchema = z.object({
  reason: z.string().min(5).max(240)
});

export const tenantSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  schemaName: z.string(),
  status: z.string(),
  billingEmail: z.string().nullable(),
  onboardingStep: z.string(),
  onboardingCompletedAt: z.string().nullable(),
  storageBytes: z.number(),
  messagesThisMonth: z.number().int(),
  instanceLimit: z.number().int(),
  messagesPerMonth: z.number().int(),
  usersLimit: z.number().int(),
  rateLimitPerMinute: z.number().int(),
  plan: z
    .object({
      id: z.string(),
      code: z.string(),
      name: z.string()
    })
    .nullable(),
  activeInstances: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const billingSubscriptionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  planName: z.string(),
  status: z.string(),
  currentPeriodStart: z.string(),
  currentPeriodEnd: z.string().nullable(),
  nextDueAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  canceledAt: z.string().nullable()
});

export const healthResponseSchema = z.object({
  tenantsTotal: z.number().int(),
  tenantsActive: z.number().int(),
  tenantsSuspended: z.number().int(),
  instancesActive: z.number().int(),
  redisStatus: z.string(),
  databaseStatus: z.enum(["ready", "degraded"])
});

export const impersonationResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int().positive()
});
