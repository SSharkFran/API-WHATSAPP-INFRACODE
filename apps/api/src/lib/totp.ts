import * as OTPAuth from "otpauth";

/**
 * Gera uma chave TOTP nova para um usuario.
 */
export const createTotpSecret = (email: string, issuer = "InfraCode") => {
  const secret = new OTPAuth.Secret();
  const totp = new OTPAuth.TOTP({
    issuer,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret
  });

  return {
    base32: secret.base32,
    uri: totp.toString()
  };
};

/**
 * Valida um codigo TOTP.
 */
export const verifyTotpCode = (secret: string, token: string, issuer = "InfraCode"): boolean => {
  const totp = new OTPAuth.TOTP({
    issuer,
    label: "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret)
  });

  return totp.validate({ token, window: 1 }) !== null;
};
