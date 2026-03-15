import pino from "pino";
import type { AppConfig } from "../config.js";

/**
 * Cria o logger estruturado padrão da plataforma.
 */
export const createLogger = (config: AppConfig) =>
  pino({
    level: config.NODE_ENV === "production" ? "info" : "debug",
    redact: ["req.headers.authorization", "req.headers['x-api-key']", "payload.secret", "payload.apiKey"]
  });
