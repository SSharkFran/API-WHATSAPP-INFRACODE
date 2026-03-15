export const API_SCOPES = ["read", "write", "admin"] as const;
export const PLATFORM_ROLES = ["PLATFORM_OWNER", "PLATFORM_SUPPORT", "PLATFORM_FINANCE", "PLATFORM_VIEWER"] as const;
export const TENANT_ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;

export type ApiScope = (typeof API_SCOPES)[number];
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type TenantRole = (typeof TENANT_ROLES)[number];
export type AuthMode = "any" | "platform" | "tenant";
export type ActorType = "ANONYMOUS" | "PLATFORM_USER" | "TENANT_USER" | "API_KEY";

export interface AuthContext {
  actorId?: string;
  actorType: ActorType;
  tenantId?: string;
  tenantSlug?: string;
  platformRole?: PlatformRole;
  tenantRole?: TenantRole;
  impersonatedBy?: string;
  scopes: ApiScope[];
  sessionId?: string;
  apiKeyId?: string;
  userId?: string;
}

const tenantRoleScopes: Record<TenantRole, ApiScope[]> = {
  ADMIN: ["read", "write", "admin"],
  OPERATOR: ["read", "write"],
  VIEWER: ["read"]
};

const platformRoleScopes: Record<PlatformRole, ApiScope[]> = {
  PLATFORM_OWNER: ["read", "write", "admin"],
  PLATFORM_SUPPORT: ["read", "write", "admin"],
  PLATFORM_FINANCE: ["read", "write"],
  PLATFORM_VIEWER: ["read"]
};

/**
 * Retorna os escopos derivados do papel humano dentro do tenant.
 */
export const getScopesForTenantRole = (role: TenantRole): ApiScope[] => tenantRoleScopes[role];

/**
 * Retorna os escopos derivados do papel humano da InfraCode.
 */
export const getScopesForPlatformRole = (role: PlatformRole): ApiScope[] => platformRoleScopes[role];

/**
 * Normaliza um conjunto de escopos removendo duplicidades.
 */
export const dedupeScopes = (scopes: ApiScope[]): ApiScope[] => [...new Set(scopes)];

/**
 * Verifica se todos os escopos exigidos estao presentes.
 */
export const hasRequiredScopes = (currentScopes: ApiScope[], requiredScopes: ApiScope[]): boolean =>
  requiredScopes.every((scope) => currentScopes.includes(scope));

/**
 * Valida se um valor arbitrario representa um role de plataforma valido.
 */
export const isPlatformRole = (value: string | null | undefined): value is PlatformRole =>
  typeof value === "string" && PLATFORM_ROLES.includes(value as PlatformRole);

/**
 * Valida se um valor arbitrario representa um role de tenant valido.
 */
export const isTenantRole = (value: string | null | undefined): value is TenantRole =>
  typeof value === "string" && TENANT_ROLES.includes(value as TenantRole);
