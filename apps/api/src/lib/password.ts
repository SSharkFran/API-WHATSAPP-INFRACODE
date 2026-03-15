import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;

/**
 * Gera um hash de senha com scrypt e salt aleatorio.
 */
export const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `${salt}:${derived}`;
};

/**
 * Valida uma senha em texto puro contra o hash persistido.
 */
export const verifyPassword = (password: string, hashedValue: string): boolean => {
  const [salt, expected] = hashedValue.split(":");

  if (!salt || !expected) {
    return false;
  }

  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const expectedBuffer = Buffer.from(expected, "hex");

  if (derived.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(derived, expectedBuffer);
};
