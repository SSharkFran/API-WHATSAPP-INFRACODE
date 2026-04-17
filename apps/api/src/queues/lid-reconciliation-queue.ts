import { Queue } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { QUEUE_NAMES } from "./queue-names.js";

/**
 * Fila para reconciliacao de contatos @lid com numero de telefone real.
 * Disparada a cada evento connection.update:open (CONNECTED).
 * BullMQ jobId dedup garante que reconexoes rapidas nao empilham jobs duplicados.
 */
export const createLidReconciliationQueue = (connection: IORedis): Queue =>
  new Queue(QUEUE_NAMES.LID_RECONCILIATION, {
    connection: connection as never,
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: 10,
      removeOnFail: 100,
      backoff: { type: "exponential", delay: 5_000 }
    }
  });
