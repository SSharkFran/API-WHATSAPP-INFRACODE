import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_LENGTH = 12;

/**
 * Gera o hash SHA-256 em hexadecimal para armazenamento de segredos.
 */
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Criptografa dados com AES-256-GCM para armazenamento em repouso.
 */
export const encrypt = (plaintext: string, key: string): string => {
  const normalizedKey = createHash("sha256").update(key).digest();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", normalizedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
};

/**
 * Descriptografa um payload persistido com AES-256-GCM.
 */
export const decrypt = (ciphertext: string, key: string): string => {
  const normalizedKey = createHash("sha256").update(key).digest();
  const [ivBase64, tagBase64, encryptedBase64] = ciphertext.split(".");

  if (!ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error("Payload criptografado inválido");
  }

  const decipher = createDecipheriv("aes-256-gcm", normalizedKey, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));

  return Buffer.concat([decipher.update(Buffer.from(encryptedBase64, "base64")), decipher.final()]).toString("utf8");
};
