import type { FastifyInstance } from "fastify";
import { recordPlatformAuditLog } from "../../lib/audit.js";
import { requireTenantId } from "../../lib/request-auth.js";
import { privacyDeleteSchema, privacyExportSchema, privacyParamsSchema, privacyQuerySchema } from "./schemas.js";

/**
 * Registra rotas LGPD para exportacao e exclusao de dados.
 */
export const registerPrivacyRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get(
    "/privacy/contacts/:phoneNumber/export",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["admin"]
      },
      schema: {
        tags: ["Privacy"],
        summary: "Exporta dados pessoais de um contato por numero",
        params: privacyParamsSchema,
        querystring: privacyQuerySchema,
        response: {
          200: privacyExportSchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = privacyParamsSchema.parse(request.params);
      const query = privacyQuerySchema.parse(request.query);
      const response = await app.privacyService.exportData(tenantId, params.phoneNumber, query.instanceId);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "privacy.export",
        "DataSubject",
        response.phoneNumber,
        {
          instanceId: query.instanceId ?? null,
          totals: response.totals
        },
        app.config.JWT_SECRET
      );

      return response;
    }
  );

  app.delete(
    "/privacy/contacts/:phoneNumber",
    {
      config: {
        auth: "tenant",
        allowApiKey: true,
        requiredScopes: ["admin"]
      },
      schema: {
        tags: ["Privacy"],
        summary: "Exclui dados pessoais de um contato por numero",
        params: privacyParamsSchema,
        querystring: privacyQuerySchema,
        response: {
          200: privacyDeleteSchema
        }
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = privacyParamsSchema.parse(request.params);
      const query = privacyQuerySchema.parse(request.query);
      const response = await app.privacyService.deleteData(tenantId, params.phoneNumber, query.instanceId);

      await recordPlatformAuditLog(
        app.platformPrisma,
        request,
        "privacy.delete",
        "DataSubject",
        response.phoneNumber,
        {
          instanceId: query.instanceId ?? null,
          totals: response.totals
        },
        app.config.JWT_SECRET
      );

      return response;
    }
  );
};
