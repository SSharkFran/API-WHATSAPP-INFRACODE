import { Queue } from "bullmq";
import type { Redis as IORedis } from "ioredis";
import { QUEUE_NAMES } from "./queue-names.js";

/**
 * BullMQ queue for session inactivity timeout jobs (Plan 4.3).
 * Uses deduplication.extend=true so each new client message resets the timer in O(1).
 */
export const createSessionTimeoutQueue = (connection: IORedis): Queue =>
  new Queue(QUEUE_NAMES.SESSION_TIMEOUT, {
    connection: connection as never,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
