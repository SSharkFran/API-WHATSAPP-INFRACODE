import { z } from "zod";

export const upsertWebhookBodySchema = z.object({
  url: z.string().url(),
  secret: z.string().min(8),
  headers: z.record(z.string()).default({}),
  subscribedEvents: z.array(z.string().min(1)).min(1),
  isActive: z.boolean().default(true)
});

export const listWebhookDeliveriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});
