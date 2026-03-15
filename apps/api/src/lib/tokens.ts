import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";

export interface AccessTokenPayload {
  actorId: string;
  actorType: "PLATFORM_USER" | "TENANT_USER" | "API_KEY";
  tenantId?: string;
  tenantRole?: string;
  platformRole?: string;
  impersonatedBy?: string;
}

const buildSecret = (secret: string): Uint8Array => new TextEncoder().encode(secret);

/**
 * Assina um JWT curto para uso em sessao humana do painel.
 */
export const signAccessToken = async (
  config: AppConfig,
  payload: AccessTokenPayload
): Promise<string> =>
  new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_MINUTES}m`)
    .sign(buildSecret(config.JWT_SECRET));

/**
 * Valida e retorna o payload de um access token.
 */
export const verifyAccessToken = async (config: AppConfig, token: string): Promise<AccessTokenPayload> => {
  const { payload } = await jwtVerify(token, buildSecret(config.JWT_SECRET));

  return {
    actorId: String(payload.actorId),
    actorType: payload.actorType as AccessTokenPayload["actorType"],
    tenantId: payload.tenantId ? String(payload.tenantId) : undefined,
    tenantRole: payload.tenantRole ? String(payload.tenantRole) : undefined,
    platformRole: payload.platformRole ? String(payload.platformRole) : undefined,
    impersonatedBy: payload.impersonatedBy ? String(payload.impersonatedBy) : undefined
  };
};

/**
 * Gera um refresh token opaco e seu hash SHA-256 para persistencia.
 */
export const createRefreshToken = (): { value: string; hash: string } => {
  const value = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(value).digest("hex");

  return {
    value,
    hash
  };
};
