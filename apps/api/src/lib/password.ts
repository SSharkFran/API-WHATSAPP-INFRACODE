import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const SCRYPT_KEY_LENGTH = 64;
const scryptAsync = promisify(scrypt);

/**
 * Gera um hash de senha com scrypt e salt aleatorio.
 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
};

/**
 * Valida uma senha em texto puro contra o hash persistido.
 */
export const verifyPassword = async (password: string, hashedValue: string): Promise<boolean> => {
  const [salt, expected] = hashedValue.split(":");

  if (!salt || !expected) {
    return false;
  }

  const derived = (await scryptAsync(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  const expectedBuffer = Buffer.from(expected, "hex");

  if (derived.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(derived, expectedBuffer);
};
