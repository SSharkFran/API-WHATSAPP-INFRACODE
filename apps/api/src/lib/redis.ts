import { Redis as IORedis } from "ioredis";
import type { AppConfig } from "../config.js";

/**
 * Cria a conexão Redis usada para filas, cache e rate limiting.
 */
export const createRedis = (config: AppConfig): IORedis =>
  (() => {
    const redis = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: config.NODE_ENV === "test"
    });

    if (config.NODE_ENV === "test") {
      redis.on("error", () => {
        // Ignore external connection noise in isolated test runs.
      });
    }

    return redis;
  })();
