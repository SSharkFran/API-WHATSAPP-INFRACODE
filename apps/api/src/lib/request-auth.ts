import type { FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";

/**
 * Garante que a rota foi autenticada com contexto valido de tenant.
 */
export const requireTenantId = (request: FastifyRequest): string => {
  if (!request.auth.tenantId) {
    throw new ApiError(403, "TENANT_CONTEXT_REQUIRED", "Contexto de tenant obrigatorio");
  }

  return request.auth.tenantId;
};
