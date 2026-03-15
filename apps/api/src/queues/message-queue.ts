import { Queue } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { QUEUE_NAMES } from "./queue-names.js";

/**
 * Fila de mensageria assíncrona, agendamentos e lotes.
 */
export const createSendMessageQueue = (connection: IORedis): Queue =>
  new Queue(QUEUE_NAMES.SEND_MESSAGE, {
    connection: connection as never,
    defaultJobOptions: {
      attempts: 5,
      removeOnComplete: 1000,
      removeOnFail: 1000,
      backoff: {
        type: "exponential",
        delay: 2_000
      }
    }
  });
