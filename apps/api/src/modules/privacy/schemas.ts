import { z } from "zod";

export const privacyParamsSchema = z.object({
  phoneNumber: z.string().min(10).max(20)
});

export const privacyQuerySchema = z.object({
  instanceId: z.string().optional()
});

export const privacyExportSchema = z.object({
  exportedAt: z.string(),
  phoneNumber: z.string(),
  totals: z.object({
    contacts: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative()
  }),
  data: z.object({
    contacts: z.array(z.record(z.unknown())),
    conversations: z.array(z.record(z.unknown())),
    messages: z.array(z.record(z.unknown()))
  })
});

export const privacyDeleteSchema = z.object({
  deletedAt: z.string(),
  phoneNumber: z.string(),
  totals: z.object({
    contacts: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative()
  })
});
