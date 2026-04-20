import type { FastifyInstance } from "fastify";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import { z } from "zod";
import { requireTenantId } from "../../lib/request-auth.js";
import { instanceParamsSchema } from "../instances/schemas.js";

const contactParamsSchema = instanceParamsSchema.extend({ contactId: z.string().min(1) });
const convParamsSchema   = instanceParamsSchema.extend({ conversationId: z.string().min(1) });

const listContactsQuerySchema = z.object({
  search:   z.string().optional(),
  status:   z.enum(["OPEN", "CLOSED", "all"]).default("all"),
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(40),
  tags:     z.array(z.string().max(50)).optional()
});

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(60)
});

const patchContactSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  notes:       z.string().max(1000).nullable().optional()
});

const patchConversationSchema = z.object({
  tags:         z.array(z.string().max(50)).optional(),
  status:       z.enum(["OPEN", "CLOSED"]).optional(),
  humanTakeover: z.boolean().optional()
});

/** Remove sufixo @s.whatsapp.net / @c.us e retorna só os dígitos. */
const cleanPhone = (raw: string | null | undefined): string =>
  (raw ?? "").replace(/@[^@]*$/, "").replace(/\D/g, "");

export const registerCrmRoutes = async (app: FastifyInstance): Promise<void> => {

  // ── GET /instances/:id/crm/contacts ─────────────────────────────────────────
  app.get("/instances/:id/crm/contacts", {
    config: { auth: "tenant", allowApiKey: false, requiredScopes: ["read"] },
    schema: { tags: ["CRM"], params: instanceParamsSchema, querystring: listContactsQuerySchema }
  }, async (request) => {
    const tenantId   = requireTenantId(request);
    const { id: instanceId } = instanceParamsSchema.parse(request.params);
    const { search, status, page, pageSize, tags } = listContactsQuerySchema.parse(request.query);
    const prisma = await app.tenantPrismaRegistry.getClient(tenantId);
    const skip   = (page - 1) * pageSize;

    const convWhere: Record<string, unknown> = { instanceId };
    if (status !== "all") convWhere["status"] = status;
    if (search) {
      const digits = search.replace(/\D/g, "");
      convWhere["contact"] = {
        OR: [
          { displayName: { contains: search, mode: "insensitive" } },
          ...(digits ? [{ phoneNumber: { contains: digits } }] : [])
        ]
      };
    }
    if (tags && tags.length > 0) {
      convWhere["tags"] = { hasSome: tags };
    }

    const conversations = await prisma.conversation.findMany({
      where: convWhere,
      orderBy: { lastMessageAt: "desc" },
      take: Math.min((pageSize + skip) * 2, 500),
      select: {
        id: true, status: true, humanTakeover: true, lastMessageAt: true, tags: true,
        contact: { select: { id: true, phoneNumber: true, rawJid: true, displayName: true, isBlacklisted: true } }
      }
    });

    // Deduplica por contactId
    const seen = new Set<string>();
    const deduped = conversations
      .filter(c => { if (seen.has(c.contact.id)) return false; seen.add(c.contact.id); return true; })
      .slice(skip, skip + pageSize);

    // Build phone8 list for batch lookup — O(1) DB round trips instead of O(N)
    const phone8List = deduped
      .map(c => cleanPhone(c.contact.phoneNumber).slice(-8))
      .filter(Boolean);

    type MemoryRow = {
      phoneNumber: string | null;
      name: string | null;
      serviceInterest: string | null;
      status: string | null;
      scheduledAt: Date | null;
      notes: string | null;
    };

    const memoryRows: MemoryRow[] = phone8List.length > 0
      ? await prisma.clientMemory.findMany({
          where: { OR: phone8List.map((p: string) => ({ phoneNumber: { contains: p } })) },
          select: {
            phoneNumber: true,
            name: true,
            serviceInterest: true,
            status: true,
            scheduledAt: true,
            notes: true
          }
        })
      : [];

    // Build lookup map by last-8-digit suffix
    const memoryMap = new Map<string, MemoryRow>(
      memoryRows.map((m: MemoryRow) => [cleanPhone(m.phoneNumber ?? "").slice(-8), m])
    );

    const contacts = deduped.map((c) => {
      const cleaned = cleanPhone(c.contact.phoneNumber);
      const memory = memoryMap.get(cleaned.slice(-8)) ?? null;
      return {
        conversationId:    c.id,
        contactId:         c.contact.id,
        jid:               c.contact.rawJid ?? c.contact.phoneNumber ?? "",
        rawJid:            c.contact.rawJid ?? null,
        phoneNumber:       c.contact.phoneNumber ?? null,
        displayName:       (c.contact.displayName ?? memory?.name ?? cleaned) || null,
        isBlacklisted:     c.contact.isBlacklisted,
        conversationStatus: c.status,
        humanTakeover:     c.humanTakeover,
        lastMessageAt:     c.lastMessageAt?.toISOString() ?? null,
        tags:              c.tags,
        leadStatus:        memory?.status ?? null,
        serviceInterest:   memory?.serviceInterest ?? null,
        scheduledAt:       memory?.scheduledAt?.toISOString() ?? null,
        notes:             memory?.notes ?? null
      };
    });

    return { contacts, page, pageSize };
  });

  // ── GET /instances/:id/crm/contacts/:contactId/messages ─────────────────────
  app.get("/instances/:id/crm/contacts/:contactId/messages", {
    config: { auth: "tenant", allowApiKey: false, requiredScopes: ["read"] },
    schema: { tags: ["CRM"], params: contactParamsSchema, querystring: messagesQuerySchema }
  }, async (request, reply) => {
    const tenantId = requireTenantId(request);
    const { id: instanceId, contactId } = contactParamsSchema.parse(request.params);
    const { limit } = messagesQuerySchema.parse(request.query);
    const prisma = await app.tenantPrismaRegistry.getClient(tenantId);

    const contact = await prisma.contact.findFirst({
      where: { id: contactId, instanceId },
      select: { id: true, phoneNumber: true, rawJid: true, displayName: true, isBlacklisted: true, notes: true }
    });
    if (!contact) return reply.status(404).send({ message: "Contato não encontrado." });

    // Fallback to rawJid when phoneNumber is null (LID contacts — Plan 2.1 Pitfall 3)
    let messageWhere: Prisma.MessageWhereInput;
    if (contact.phoneNumber) {
      const phone8 = cleanPhone(contact.phoneNumber).slice(-8);
      messageWhere = { instanceId, remoteJid: { contains: phone8 } };
    } else if (contact.rawJid) {
      messageWhere = { instanceId, remoteJid: { equals: contact.rawJid } };
    } else {
      // No usable identifier — return empty messages
      messageWhere = { instanceId, id: { in: [] } };
    }

    const phone8ForMemory = cleanPhone(contact.phoneNumber).slice(-8);

    const [messages, memory, conversation] = await Promise.all([
      prisma.message.findMany({
        where: messageWhere,
        orderBy: { createdAt: "asc" },
        take: 500,
        select: { id: true, direction: true, type: true, payload: true, status: true, createdAt: true }
      }),
      prisma.clientMemory.findFirst({
        where: { phoneNumber: { contains: phone8ForMemory } },
        select: { name: true, serviceInterest: true, status: true, scheduledAt: true, notes: true, isExistingClient: true }
      }).catch(() => null),
      prisma.conversation.findFirst({
        where: { instanceId, contact: { id: contactId } },
        orderBy: { lastMessageAt: "desc" },
        select: { id: true, status: true, humanTakeover: true, tags: true, lastMessageAt: true }
      })
    ]);

    return {
      contact: {
        id:              contact.id,
        rawJid:          contact.rawJid ?? null,
        phoneNumber:     contact.phoneNumber ?? null,  // null when LID not yet resolved
        displayName:     (contact.displayName ?? memory?.name ?? cleanPhone(contact.phoneNumber)) || null,
        isBlacklisted:   contact.isBlacklisted,
        notes:           contact.notes ?? memory?.notes ?? null,
        leadStatus:      memory?.status ?? null,
        serviceInterest: memory?.serviceInterest ?? null,
        scheduledAt:     memory?.scheduledAt?.toISOString() ?? null,
        isExistingClient: memory?.isExistingClient ?? false,
        memory: memory ? {
          name:            memory.name ?? null,
          serviceInterest: memory.serviceInterest ?? null,
          status:          memory.status ?? null,
          scheduledAt:     memory.scheduledAt?.toISOString() ?? null,
          notes:           memory.notes ?? null
        } : null
      },
      conversation: conversation ? {
        id:            conversation.id,
        status:        conversation.status,
        humanTakeover: conversation.humanTakeover,
        tags:          conversation.tags,
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null
      } : null,
      messages: messages.map(m => {
        const p = m.payload as Record<string, unknown> | null;
        return {
          id:        m.id,
          direction: m.direction,
          type:      m.type,
          text:      String(p?.["text"] ?? p?.["caption"] ?? ""),
          mediaUrl:  (p?.["media"] as Record<string, unknown> | undefined)?.["url"] as string | undefined,
          fileName:  (p?.["media"] as Record<string, unknown> | undefined)?.["fileName"] as string | undefined,
          status:    m.status,
          createdAt: m.createdAt.toISOString()
        };
      })
    };
  });

  // ── PATCH /instances/:id/crm/contacts/:contactId ─────────────────────────────
  app.patch("/instances/:id/crm/contacts/:contactId", {
    config: { auth: "tenant", allowApiKey: false, requiredScopes: ["write"] },
    schema: { tags: ["CRM"], params: contactParamsSchema, body: patchContactSchema }
  }, async (request, reply) => {
    const tenantId = requireTenantId(request);
    const { id: instanceId, contactId } = contactParamsSchema.parse(request.params);
    const body = patchContactSchema.parse(request.body);
    const prisma = await app.tenantPrismaRegistry.getClient(tenantId);

    const contact = await prisma.contact.findFirst({ where: { id: contactId, instanceId } });
    if (!contact) return reply.status(404).send({ message: "Contato não encontrado." });

    const updated = await prisma.contact.update({
      where: { id: contactId },
      data: {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {})
      },
      select: { id: true, displayName: true, notes: true, phoneNumber: true }
    });

    return { ...updated, phoneNumber: cleanPhone(updated.phoneNumber) };
  });

  // ── PATCH /instances/:id/crm/conversations/:conversationId ───────────────────
  app.patch("/instances/:id/crm/conversations/:conversationId", {
    config: { auth: "tenant", allowApiKey: false, requiredScopes: ["write"] },
    schema: { tags: ["CRM"], params: convParamsSchema, body: patchConversationSchema }
  }, async (request, reply) => {
    const tenantId = requireTenantId(request);
    const { id: instanceId, conversationId } = convParamsSchema.parse(request.params);
    const body = patchConversationSchema.parse(request.body);
    const prisma = await app.tenantPrismaRegistry.getClient(tenantId);

    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, instanceId } });
    if (!conv) return reply.status(404).send({ message: "Conversa não encontrada." });

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.humanTakeover !== undefined ? { humanTakeover: body.humanTakeover, humanTakeoverAt: body.humanTakeover ? new Date() : null } : {})
      },
      select: { id: true, status: true, humanTakeover: true, tags: true }
    });

    return updated;
  });
};
