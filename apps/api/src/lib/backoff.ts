const ATTEMPTS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * Retorna o delay de reconexão com backoff exponencial limitado a cinco tentativas.
 */
export const resolveReconnectDelay = (attempt: number): number => ATTEMPTS[Math.min(Math.max(attempt, 0), ATTEMPTS.length - 1)];
