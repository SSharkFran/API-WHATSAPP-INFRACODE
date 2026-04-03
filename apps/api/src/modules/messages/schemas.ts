import { z } from "zod";

const baseMessageSchema = z.object({
  to: z.string().min(10).max(20),
  targetJid: z.string().min(3).optional(),
  replyToMessageId: z.string().optional(),
  mentionNumbers: z.array(z.string()).optional(),
  simulateTypingMs: z.number().int().min(0).max(15000).optional(),
  markAsRead: z.boolean().optional(),
  scheduledAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
  traceId: z.string().optional()
});

const mediaSchema = z.object({
  mimeType: z.string().min(1),
  fileName: z.string().optional(),
  url: z.string().url().optional(),
  base64: z.string().optional(),
  caption: z.string().optional(),
  convertToVoiceNote: z.boolean().optional()
});

export const sendMessageBodySchema = z.discriminatedUnion("type", [
  baseMessageSchema.extend({
    type: z.literal("text"),
    text: z.string().min(1)
  }),
  baseMessageSchema.extend({
    type: z.literal("image"),
    media: mediaSchema
  }),
  baseMessageSchema.extend({
    type: z.literal("video"),
    media: mediaSchema
  }),
  baseMessageSchema.extend({
    type: z.literal("audio"),
    media: mediaSchema
  }),
  baseMessageSchema.extend({
    type: z.literal("document"),
    media: mediaSchema
  }),
  baseMessageSchema.extend({
    type: z.literal("sticker"),
    media: mediaSchema,
    animated: z.boolean().optional()
  }),
  baseMessageSchema.extend({
    type: z.literal("location"),
    latitude: z.number(),
    longitude: z.number(),
    name: z.string().optional(),
    address: z.string().optional()
  }),
  baseMessageSchema.extend({
    type: z.literal("contact"),
    displayName: z.string().min(1),
    vcard: z.string().min(1)
  }),
  baseMessageSchema.extend({
    type: z.literal("poll"),
    title: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    selectableCount: z.number().int().min(1).optional()
  }),
  baseMessageSchema.extend({
    type: z.literal("reaction"),
    emoji: z.string().min(1).max(8),
    targetMessageId: z.string().min(1),
    targetJid: z.string().optional(),
    fromMe: z.boolean().optional(),
    participant: z.string().optional()
  }),
  baseMessageSchema.extend({
    type: z.literal("list"),
    title: z.string().min(1),
    description: z.string().min(1),
    buttonText: z.string().min(1),
    footerText: z.string().optional(),
    sections: z
      .array(
        z.object({
          title: z.string().min(1),
          rows: z.array(
            z.object({
              id: z.string().min(1),
              title: z.string().min(1),
              description: z.string().optional()
            })
          )
        })
      )
      .min(1)
  }),
  baseMessageSchema.extend({
    type: z.literal("buttons"),
    text: z.string().min(1),
    footerText: z.string().optional(),
    buttons: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1)
        })
      )
      .min(1)
      .max(3)
  }),
  baseMessageSchema.extend({
    type: z.literal("template"),
    templateName: z.string().min(1),
    body: z.string().min(1),
    variables: z.record(z.string()),
    footerText: z.string().optional()
  })
]);

export const bulkSendBodySchema = z.object({
  items: z.array(sendMessageBodySchema).min(1).max(500),
  minDelayMs: z.number().int().min(0).max(120000).default(2_000),
  maxDelayMs: z.number().int().min(0).max(120000).default(5_000)
});

export const listMessagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
  type: z.string().optional(),
  remoteJid: z.string().optional()
});
