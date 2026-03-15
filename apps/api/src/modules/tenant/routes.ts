import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordPlatformAuditLog } from "../../lib/audit.js";
import {
  createTenantApiKeyBodySchema,
  inviteTenantUserBodySchema,
  onboardingResponseSchema,
  tenantApiKeyCreateResponseSchema,
  tenantApiKeyParamsSchema,
  tenantApiKeySchema,
  tenantDashboardSchema,
  tenantSettingsBodySchema,
  tenantUserSchema
} from "./schemas.js";

/**
 * Registra rotas administrativas do painel do cliente.
 */
export const registerTenantRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/tenant/dashboard", { config: { auth: "tenant", tenantRoles: ["ADMIN", "OPERATOR", "VIEWER"] }, schema: { tags: ["Tenant"], summary: "Retorna metricas principais do dashboard do cliente", response: { 200: tenantDashboardSchema } } }, async (request) => app.tenantManagementService.getDashboard(request.auth.tenantId ?? ""));

  app.get("/tenant/users", { config: { auth: "tenant", tenantRoles: ["ADMIN", "VIEWER"] }, schema: { tags: ["Tenant"], summary: "Lista usuarios internos do tenant", response: { 200: z.array(tenantUserSchema) } } }, async (request) => app.tenantManagementService.listUsers(request.auth.tenantId ?? ""));

  app.post("/tenant/users", { config: { auth: "tenant", tenantRoles: ["ADMIN"] }, schema: { tags: ["Tenant"], summary: "Cria convite para um novo usuario interno", body: inviteTenantUserBodySchema } }, async (request) => {
    const body = inviteTenantUserBodySchema.parse(request.body);
    const response = await app.tenantManagementService.inviteUser(request.auth.tenantId ?? "", request.auth.userId ?? "", body);
    await recordPlatformAuditLog(app.platformPrisma, request, "tenant.user.invite", "Invitation", response.id, { email: response.email, role: response.role }, app.config.JWT_SECRET);
    return response;
  });

  app.get("/tenant/api-keys", { config: { auth: "tenant", tenantRoles: ["ADMIN", "VIEWER"] }, schema: { tags: ["Tenant"], summary: "Lista API keys do tenant", response: { 200: z.array(tenantApiKeySchema) } } }, async (request) => app.tenantManagementService.listApiKeys(request.auth.tenantId ?? ""));

  app.post("/tenant/api-keys", { config: { auth: "tenant", tenantRoles: ["ADMIN"] }, schema: { tags: ["Tenant"], summary: "Cria API key para integracoes externas do tenant", body: createTenantApiKeyBodySchema, response: { 200: tenantApiKeyCreateResponseSchema } } }, async (request) => {
    const body = createTenantApiKeyBodySchema.parse(request.body);
    const response = await app.tenantManagementService.createApiKey(request.auth.tenantId ?? "", body);
    await recordPlatformAuditLog(app.platformPrisma, request, "tenant.api-key.create", "ApiKey", response.id, { name: response.name, scopes: response.scopes }, app.config.JWT_SECRET);
    return response;
  });

  app.delete("/tenant/api-keys/:id", { config: { auth: "tenant", tenantRoles: ["ADMIN"] }, schema: { tags: ["Tenant"], summary: "Revoga uma API key do tenant", params: tenantApiKeyParamsSchema } }, async (request, reply) => {
    const params = tenantApiKeyParamsSchema.parse(request.params);
    await app.tenantManagementService.revokeApiKey(request.auth.tenantId ?? "", params.id);
    await recordPlatformAuditLog(app.platformPrisma, request, "tenant.api-key.revoke", "ApiKey", params.id, {}, app.config.JWT_SECRET);
    reply.code(204);
    return null;
  });

  app.get("/tenant/onboarding", { config: { auth: "tenant", tenantRoles: ["ADMIN", "OPERATOR", "VIEWER"] }, schema: { tags: ["Tenant"], summary: "Retorna o estado atual do onboarding guiado do cliente", response: { 200: onboardingResponseSchema } } }, async (request) => app.tenantManagementService.getOnboarding(request.auth.tenantId ?? ""));

  app.post("/tenant/onboarding/sync", { config: { auth: "tenant", tenantRoles: ["ADMIN", "OPERATOR"] }, schema: { tags: ["Tenant"], summary: "Forca reavaliacao do onboarding a partir do estado real do tenant", response: { 200: onboardingResponseSchema } } }, async (request) => app.tenantManagementService.getOnboarding(request.auth.tenantId ?? ""));

  app.get("/tenant/settings", { config: { auth: "tenant", tenantRoles: ["ADMIN", "VIEWER"] }, schema: { tags: ["Tenant"], summary: "Lista configuracoes gerais do tenant" } }, async (request) => app.tenantManagementService.getSettings(request.auth.tenantId ?? ""));

  app.put("/tenant/settings", { config: { auth: "tenant", tenantRoles: ["ADMIN"] }, schema: { tags: ["Tenant"], summary: "Atualiza configuracoes gerais do tenant", body: tenantSettingsBodySchema } }, async (request) => {
    const body = tenantSettingsBodySchema.parse(request.body);
    const response = await app.tenantManagementService.updateSettings(request.auth.tenantId ?? "", body);
    await recordPlatformAuditLog(app.platformPrisma, request, "tenant.settings.update", "Tenant", request.auth.tenantId ?? "", body, app.config.JWT_SECRET);
    return response;
  });
};
