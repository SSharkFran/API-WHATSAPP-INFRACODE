import { z } from "zod";

const defaultDataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "./apps/api/data";
const defaultPublicApiBaseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : "http://localhost:3333";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  HOST: z.string().min(1).default("0.0.0.0"),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => {
      if (value) {
        return value === "true";
      }

      return Boolean(process.env.RAILWAY_PUBLIC_DOMAIN);
    }),
  APP_NAME: z.string().min(1).default("InfraCode WhatsApp API"),
  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  PLATFORM_DATABASE_URL: z.string().url().optional(),
  PLATFORM_DIRECT_DATABASE_URL: z.string().url().optional(),
  TENANT_DATABASE_URL: z.string().url().optional(),
  TENANT_DIRECT_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  API_ENCRYPTION_KEY: z.string().min(32, "API_ENCRYPTION_KEY deve ter no minimo 32 caracteres"),
  WEBHOOK_HMAC_SECRET: z.string().min(16),
  JWT_SECRET: z.string().min(8),
  ROOT_DOMAIN: z.string().min(3).default("infracode.local"),
  ADMIN_SUBDOMAIN: z.string().min(3).default("admin"),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(14),
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).default(72),
  PASSWORD_RESET_TTL_HOURS: z.coerce.number().int().min(1).default(2),
  TENANT_PRISMA_CACHE_MAX: z.coerce.number().int().min(1).max(512).default(64),
  TENANT_PRISMA_IDLE_TTL_MS: z.coerce.number().int().min(60_000).default(600_000),
  TENANT_PRISMA_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(10).default(2),
  ENABLE_AUTH: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  DATA_DIR: z.string().default(defaultDataDir),
  PUBLIC_API_BASE_URL: z.string().url().default(defaultPublicApiBaseUrl),
  SMTP_FROM: z.string().email().default("noreply@infracode.local"),
  GROQ_API_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  OLLAMA_HOST: z.string().optional()
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Carrega e valida as variaveis de ambiente da aplicacao.
 */
export const loadConfig = (): AppConfig => {
  const parsed = envSchema.parse(process.env);

  return {
    ...parsed,
    DIRECT_DATABASE_URL: parsed.DIRECT_DATABASE_URL ?? parsed.DATABASE_URL,
    PLATFORM_DATABASE_URL: parsed.PLATFORM_DATABASE_URL ?? parsed.DATABASE_URL,
    PLATFORM_DIRECT_DATABASE_URL: parsed.PLATFORM_DIRECT_DATABASE_URL ?? parsed.DIRECT_DATABASE_URL ?? parsed.DATABASE_URL,
    TENANT_DATABASE_URL: parsed.TENANT_DATABASE_URL ?? parsed.DATABASE_URL,
    TENANT_DIRECT_DATABASE_URL: parsed.TENANT_DIRECT_DATABASE_URL ?? parsed.DIRECT_DATABASE_URL ?? parsed.DATABASE_URL
  };
};
