import { z } from "zod";

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantSlug: z.string().min(3).max(64).regex(/^[a-z0-9-]+$/).optional(),
  totpCode: z.string().min(6).max(12).optional(),
  backupCode: z.string().min(6).max(32).optional()
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(16)
});

export const logoutBodySchema = refreshBodySchema;

export const authTokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int().positive()
});

export const acceptInvitationBodySchema = z.object({
  token: z.string().min(16),
  name: z.string().min(3).max(120),
  password: z.string().min(8)
});

export const forgotPasswordBodySchema = z.object({
  email: z.string().email()
});

export const resetPasswordBodySchema = z.object({
  token: z.string().min(16),
  password: z.string().min(8)
});

export const totpVerifyBodySchema = z.object({
  code: z.string().min(6).max(12)
});

export const meResponseSchema = z.object({
  actorId: z.string().nullable(),
  actorType: z.enum(["ANONYMOUS", "PLATFORM_USER", "TENANT_USER", "API_KEY"]),
  tenantId: z.string().nullable(),
  tenantSlug: z.string().nullable(),
  platformRole: z.string().nullable(),
  tenantRole: z.string().nullable(),
  impersonatedBy: z.string().nullable(),
  scopes: z.array(z.enum(["read", "write", "admin"])),
  user: z
    .object({
      id: z.string(),
      email: z.string().email(),
      name: z.string(),
      twoFactorEnabled: z.boolean()
    })
    .nullable(),
  tenant: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      status: z.string()
    })
    .nullable()
});

export const invitationAcceptResponseSchema = authTokenResponseSchema.extend({
  tenantId: z.string(),
  tenantSlug: z.string()
});

export const forgotPasswordResponseSchema = z.object({
  accepted: z.literal(true)
});

export const totpSetupResponseSchema = z.object({
  secret: z.string(),
  uri: z.string()
});

export const totpVerifyResponseSchema = z.object({
  enabled: z.boolean(),
  backupCodes: z.array(z.string()).optional()
});
