import { Queue } from "bullmq";
import type { Redis as IORedis } from "ioredis";
import { QUEUE_NAMES } from "./queue-names.js";

export interface FollowUpJobData {
  tenantId: string;
  instanceId: string;
  contactJid: string;
  message: string;
  followUpId: string; // ScheduledFollowUp.id for status update after send
}

export const createFollowUpQueue = (connection: IORedis): Queue<FollowUpJobData> =>
  new Queue<FollowUpJobData>(QUEUE_NAMES.FOLLOW_UP, {
    connection: connection as never,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
  });
