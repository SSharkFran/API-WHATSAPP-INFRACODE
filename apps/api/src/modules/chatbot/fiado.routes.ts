import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenantId } from "../../lib/request-auth.js";
import { instanceParamsSchema } from "../instances/schemas.js";

const fiadoPhoneParamsSchema = z.object({ id: z.string().min(1), phoneNumber: z.string().min(10) });

export const registerFiadoRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get(
    "/instances/:id/fiado",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["read"] },
      schema: { tags: ["Fiado"], summary: "Lista contas de fiado em aberto", params: instanceParamsSchema }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = instanceParamsSchema.parse(request.params);
      return app.fiadoService.listTabs(tenantId, params.id);
    }
  );

  app.get(
    "/instances/:id/fiado/:phoneNumber",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["read"] },
      schema: { tags: ["Fiado"], summary: "Detalhe de uma conta de fiado", params: fiadoPhoneParamsSchema }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const params = fiadoPhoneParamsSchema.parse(request.params);
      return app.fiadoService.getTab(tenantId, params.id, params.phoneNumber);
    }
  );

  app.delete(
    "/instances/:id/fiado/:phoneNumber",
    {
      config: { auth: "tenant", allowApiKey: true, requiredScopes: ["write"] },
      schema: { tags: ["Fiado"], summary: "Limpa uma conta de fiado (marca como pago)", params: fiadoPhoneParamsSchema }
    },
    async (request, reply) => {
      const tenantId = requireTenantId(request);
      const params = fiadoPhoneParamsSchema.parse(request.params);
      await app.fiadoService.clearTab(tenantId, params.id, params.phoneNumber);
      reply.code(204);
      return null;
    }
  );
};
