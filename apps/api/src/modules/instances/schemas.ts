import { z } from "zod";

export const instanceStatusSchema = z.enum([
  "INITIALIZING",
  "QR_PENDING",
  "CONNECTED",
  "DISCONNECTED",
  "BANNED",
  "PAUSED"
]);

export const instanceParamsSchema = z.object({
  id: z.string().min(1)
});

export const createInstanceBodySchema = z.object({
  name: z.string().min(3).max(80),
  proxyUrl: z.string().url().optional(),
  autoStart: z.boolean().default(true)
});

export const instanceUsageSchema = z.object({
  instanceId: z.string(),
  messagesSent: z.number().int().nonnegative(),
  messagesReceived: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  uptimeSeconds: z.number().int().nonnegative(),
  riskScore: z.number().int().nonnegative()
});

export const instanceSummarySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  phoneNumber: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  status: instanceStatusSchema,
  lastActivityAt: z.string().nullable().optional(),
  connectedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  usage: instanceUsageSchema
});

export const instanceHealthSchema = z.object({
  instanceId: z.string(),
  status: instanceStatusSchema,
  workerOnline: z.boolean(),
  redisConnected: z.boolean(),
  databaseConnected: z.boolean(),
  qrExpiresIn: z.number().int().nonnegative().optional(),
  lastActivityAt: z.string().nullable().optional(),
  reconnectAttempts: z.number().int().nonnegative(),
  uptimeSeconds: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative()
});
