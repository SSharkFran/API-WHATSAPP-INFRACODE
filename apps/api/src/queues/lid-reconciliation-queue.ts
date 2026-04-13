import { Queue } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { QUEUE_NAMES } from "./queue-names.js";

/**
 * Fila de reconciliação de contatos @lid.
 * Disparada no evento connection.update:open para resolver contatos com phoneNumber=null.
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
