import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { sha256 } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import {
  dedupeScopes,
  getScopesForPlatformRole,
  getScopesForTenantRole,
  hasRequiredScopes,
  isPlatformRole,
  isTenantRole,
  type AuthContext
} from "../lib/authz.js";
import { resolveTenantSlugFromHostname } from "../lib/host.js";
import { verifyAccessToken } from "../lib/tokens.js";

const readBearerToken = (value: string | undefined): string | undefined => {
  if (!value?.startsWith("Bearer ")) {
    return undefined;
  }

  return value.slice("Bearer ".length).trim();
};

/**
 * Resolve autenticacao por JWT humano ou API key tenant-scoped.
 */
export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.addHook("onRequest", async (request) => {
    const routeConfig = request.routeOptions.config;
    const tenantSlugFromHost = resolveTenantSlugFromHostname(request.hostname, app.config.ROOT_DOMAIN, app.config.ADMIN_SUBDOMAIN);
    const query = request.query as { accessToken?: string; apiKey?: string } | undefined;

    request.auth = {
      actorType: "ANONYMOUS",
      scopes: [],
      tenantSlug: tenantSlugFromHost
    };

    if (routeConfig.auth === false) {
      return;
    }

    if (!app.config.ENABLE_AUTH) {
      request.auth = {
        actorId: "development-bypass",
        actorType: tenantSlugFromHost ? "TENANT_USER" : "PLATFORM_USER",
        platformRole: tenantSlugFromHost ? undefined : "PLATFORM_OWNER",
        scopes: ["read", "write", "admin"],
        tenantId: tenantSlugFromHost
          ? (
              await app.platformPrisma.tenant.findUnique({
                where: {
                  slug: tenantSlugFromHost
                }
              })
            )?.id
          : undefined,
        tenantRole: tenantSlugFromHost ? "ADMIN" : undefined,
        tenantSlug: tenantSlugFromHost,
        userId: "development-bypass"
      };
      return;
    }

    const authorization = request.headers.authorization?.toString();
    const bearerToken = readBearerToken(authorization) ?? query?.accessToken;
    const apiKey = request.headers["x-api-key"]?.toString() ?? query?.apiKey;

    if (bearerToken) {
      request.auth = await authenticateJwt(app, bearerToken);
    } else if (apiKey && routeConfig.allowApiKey !== false) {
      request.auth = await authenticateApiKey(app, apiKey);
    } else {
      throw new ApiError(401, "UNAUTHENTICATED", "Credenciais ausentes");
    }

    if (request.auth.tenantId) {
      await app.planEnforcementService.assertTenantOperational(request.auth.tenantId);
      await enforceTenantHttpRateLimit(app, request.auth.tenantId);
    }

    if (routeConfig.auth === "platform") {
      if (!request.auth.platformRole || request.auth.tenantId) {
        throw new ApiError(403, "PLATFORM_ACCESS_DENIED", "Acesso restrito ao painel InfraCode");
      }

      if (routeConfig.platformRoles?.length && !routeConfig.platformRoles.includes(request.auth.platformRole)) {
        throw new ApiError(403, "PLATFORM_ROLE_FORBIDDEN", "Role de plataforma insuficiente");
      }
    }

    if (routeConfig.auth === "tenant") {
      if (!request.auth.tenantId) {
        throw new ApiError(403, "TENANT_CONTEXT_REQUIRED", "Contexto de tenant obrigatorio");
      }

      if (routeConfig.tenantRoles?.length) {
        const tenantRole = request.auth.tenantRole;

        if (!tenantRole || !routeConfig.tenantRoles.includes(tenantRole)) {
          throw new ApiError(403, "TENANT_ROLE_FORBIDDEN", "Role de tenant insuficiente");
        }
      }
    }

    const requiredScopes = routeConfig.requiredScopes ?? [];

    if (requiredScopes.length > 0 && !hasRequiredScopes(request.auth.scopes, requiredScopes)) {
      throw new ApiError(403, "INSUFFICIENT_SCOPE", "Escopo insuficiente para esta operacao", {
        requiredScopes
      });
    }
  });
});

const authenticateJwt = async (
  app: Parameters<FastifyPluginAsync>[0],
  token: string
): Promise<AuthContext> => {
  const payload = await verifyAccessToken(app.config, token);
  const user = await app.platformPrisma.user.findUnique({
    where: {
      id: payload.actorId
    }
  });

  if (!user || !user.isActive) {
    throw new ApiError(401, "SESSION_INVALID", "Sessao invalida");
  }

  if (payload.tenantId) {
    const tenant = await app.platformPrisma.tenant.findUnique({
      where: {
        id: payload.tenantId
      }
    });

    if (!tenant) {
      throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant nao encontrado");
    }

    if (payload.impersonatedBy) {
      return {
        actorId: user.id,
        actorType: "TENANT_USER",
        impersonatedBy: payload.impersonatedBy,
        platformRole: isPlatformRole(payload.platformRole) ? payload.platformRole : undefined,
        scopes: dedupeScopes([
          ...(isPlatformRole(payload.platformRole) ? getScopesForPlatformRole(payload.platformRole) : []),
          ...getScopesForTenantRole("ADMIN")
        ]),
        tenantId: tenant.id,
        tenantRole: "ADMIN",
        tenantSlug: tenant.slug,
        userId: user.id
      };
    }

    const membership = await app.platformPrisma.tenantMembership.findFirst({
      where: {
        tenantId: tenant.id,
        userId: user.id
      }
    });

    if (!membership || !isTenantRole(membership.role)) {
      throw new ApiError(403, "TENANT_ACCESS_DENIED", "Sessao sem acesso ao tenant");
    }

    return {
      actorId: user.id,
      actorType: "TENANT_USER",
      platformRole: isPlatformRole(user.platformRole) ? user.platformRole : undefined,
      scopes: dedupeScopes([
        ...(isPlatformRole(user.platformRole) ? getScopesForPlatformRole(user.platformRole) : []),
        ...getScopesForTenantRole(membership.role)
      ]),
      tenantId: tenant.id,
      tenantRole: membership.role,
      tenantSlug: tenant.slug,
      userId: user.id
    };
  }

  if (!isPlatformRole(user.platformRole)) {
    throw new ApiError(403, "PLATFORM_ACCESS_DENIED", "Sessao sem acesso a plataforma");
  }

  return {
    actorId: user.id,
    actorType: "PLATFORM_USER",
    platformRole: user.platformRole,
    scopes: getScopesForPlatformRole(user.platformRole),
    userId: user.id
  };
};

const authenticateApiKey = async (
  app: Parameters<FastifyPluginAsync>[0],
  apiKey: string
): Promise<AuthContext> => {
  const record = await app.platformPrisma.apiKey.findFirst({
    where: {
      keyHash: sha256(apiKey),
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
    },
    include: {
      tenant: true
    }
  });

  if (!record) {
    throw new ApiError(401, "INVALID_API_KEY", "API key invalida ou expirada");
  }

  await app.platformPrisma.apiKey.update({
    where: {
      id: record.id
    },
    data: {
      lastUsedAt: new Date()
    }
  });

  return {
    actorId: record.id,
    actorType: "API_KEY",
    apiKeyId: record.id,
    scopes: dedupeScopes(record.scopes as Array<"read" | "write" | "admin">),
    tenantId: record.tenantId,
    tenantSlug: record.tenant.slug
  };
};

const enforceTenantHttpRateLimit = async (
  app: Parameters<FastifyPluginAsync>[0],
  tenantId: string
): Promise<void> => {
  const limitPerMinute = await app.planEnforcementService.getTenantRateLimitPerMinute(tenantId);
  const now = new Date();
  const bucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
  const key = `http-rate:${tenantId}:${bucket}`;
  const current = await app.redis.incr(key);

  if (current === 1) {
    await app.redis.expire(key, 60);
  }

  if (current > limitPerMinute) {
    throw new ApiError(429, "TENANT_HTTP_RATE_LIMIT_EXCEEDED", "Tenant excedeu o limite de requisicoes por minuto", {
      current,
      limitPerMinute
    });
  }
};
