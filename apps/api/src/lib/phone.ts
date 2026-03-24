import { ApiError } from "./errors.js";

/**
 * Normaliza um número de telefone para o formato numérico aceito pelo WhatsApp.
 */
export const normalizePhoneNumber = (value: string): string => value.replace(/[^\d]/g, "");

const parseJidUser = (value: string): { user: string; server: string } | null => {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf("@");

  if (separatorIndex < 0) {
    return null;
  }

  const user = trimmed.slice(0, separatorIndex).split(":")[0]?.split("_")[0] ?? "";
  const server = trimmed.slice(separatorIndex + 1);

  if (!user || !server) {
    return null;
  }

  return { user, server };
};

export const extractPhoneNumberFromJid = (value?: string | null): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const jid = parseJidUser(value);

  if (jid) {
    if (jid.server !== "s.whatsapp.net" && jid.server !== "c.us") {
      return null;
    }

    const normalizedUser = normalizePhoneNumber(jid.user);
    return normalizedUser || null;
  }

  const normalized = normalizePhoneNumber(value);
  return normalized || null;
};

export const ensurePhoneCountryCode = (value: string, defaultCountryCode = "55"): string => {
  const normalized = normalizePhoneNumber(value);

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith(defaultCountryCode) || normalized.length >= 12) {
    return normalized;
  }

  if (normalized.length === 10 || normalized.length === 11) {
    return `${defaultCountryCode}${normalized}`;
  }

  return normalized;
};

export const normalizeWhatsAppPhoneNumber = (
  value?: string | null,
  defaultCountryCode = "55"
): string | null => {
  const extracted = extractPhoneNumberFromJid(value);

  if (!extracted) {
    return null;
  }

  const normalized = ensurePhoneCountryCode(extracted, defaultCountryCode);
  return normalized || null;
};

/**
 * Converte um número para JID WhatsApp.
 */
export const toJid = (value: string): string => `${normalizePhoneNumber(value)}@s.whatsapp.net`;

/**
 * Valida se o número possui comprimento compatível com E.164.
 */
export const assertValidPhoneNumber = (value: string): void => {
  const normalized = normalizePhoneNumber(value);

  if (normalized.length < 10 || normalized.length > 15) {
    throw new ApiError(400, "INVALID_PHONE_NUMBER", "Número de telefone inválido", {
      received: value
    });
  }
};
