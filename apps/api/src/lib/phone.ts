import { ApiError } from "./errors.js";

/**
 * Normaliza um número de telefone para o formato numérico aceito pelo WhatsApp.
 */
export const normalizePhoneNumber = (value: string): string => value.replace(/[^\d]/g, "");

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
