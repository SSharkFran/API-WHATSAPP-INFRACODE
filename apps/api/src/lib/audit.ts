import { createHmac } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { PlatformPrisma, TenantPrisma } from "./database.js";

const buildSignature = (payload: Record<string, unknown>, secret: string): string =>
  createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");

/**
 * Persiste logs de auditoria no schema platform.
 */
export const recordPlatformAuditLog = async (
  prisma: PlatformPrisma,
  request: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
  secret: string
): Promise<void> => {
  await prisma.platformAuditLog.create({
    data: {
      actorType: request.auth.actorType,
      actorId: request.auth.actorId ?? "anonymous",
      tenantId: request.auth.tenantId ?? null,
      action,
      ipAddress: request.ip,
      targetType,
      targetId,
      payload: payload as never,
      signature: buildSignature(payload, secret)
    }
  });
};

/**
 * Persiste logs de auditoria no schema do tenant atual.
 */
export const recordTenantAuditLog = async (
  prisma: TenantPrisma,
  request: FastifyRequest,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown>,
  secret: string
): Promise<void> => {
  await prisma.auditLog.create({
    data: {
      actorType: request.auth.actorType,
      actorId: request.auth.actorId ?? "anonymous",
      action,
      ipAddress: request.ip,
      targetType,
      targetId,
      payload: payload as never,
      signature: buildSignature(payload, secret)
    }
  });
};
