import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTenantId } from "../../lib/request-auth.js";
import { instanceParamsSchema } from "../instances/schemas.js";

const contactParamsSchema = instanceParamsSchema.extend({
  contactId: z.string().min(1)
});

const listContactsQuerySchema = z.object({
  search: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED", "all"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(40)
});

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(60)
});

export const registerCrmRoutes = async (app: FastifyInstance): Promise<void> => {
  /**
   * Lista contatos com informações de conversa e lead, ordenados por atividade recente.
   */
  app.get(
    "/instances/:id/crm/contacts",
    {
      config: { auth: "tenant", allowApiKey: false, requiredScopes: ["read"] },
      schema: {
        tags: ["CRM"],
        summary: "Lista contatos com informações de conversa e lead",
        params: instanceParamsSchema,
        querystring: listContactsQuerySchema
      }
    },
    async (request) => {
      const tenantId = requireTenantId(request);
      const { id: instanceId } = instanceParamsSchema.parse(request.params);
      const { search, status, page, pageSize } = listContactsQuerySchema.parse(request.query);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      const skip = (page - 1) * pageSize;

      // Busca conversas ordenadas por lastMessageAt — mais eficiente para CRM
      const convWhere: Record<string, unknown> = { instanceId };
      if (status !== "all") convWhere["status"] = status;
      if (search) {
        const term = search.replace(/\D/g, "");
        convWhere["contact"] = {
          OR: [
            { displayName: { contains: search, mode: "insensitive" } },
            ...(term ? [{ phoneNumber: { contains: term } }] : [])
          ]
        };
      }

      const conversations = await tenantPrisma.conversation.findMany({
        where: convWhere,
        orderBy: { lastMessageAt: "desc" },
        take: (pageSize + skip) * 2, // extra para deduplicar por contato
        select: {
          id: true,
          status: true,
          humanTakeover: true,
          lastMessageAt: true,
          tags: true,
          contact: {
            select: { id: true, phoneNumber: true, displayName: true, isBlacklisted: true }
          }
        }
      });

      // Deduplica por contactId (mantém conversa mais recente por contato)
      const seen = new Set<string>();
      const deduped = conversations
        .filter((c) => {
          if (seen.has(c.contact.id)) return false;
          seen.add(c.contact.id);
          return true;
        })
        .slice(skip, skip + pageSize);

      // Busca clientMemory em paralelo
      const memories = await Promise.all(
        deduped.map((c) =>
          tenantPrisma.clientMemory
            .findFirst({
              where: { phoneNumber: { contains: c.contact.phoneNumber.slice(-8) } },
              select: { name: true, serviceInterest: true, status: true, scheduledAt: true, notes: true }
            })
            .catch(() => null)
        )
      );

      const contacts = deduped.map((c, i) => ({
        conversationId: c.id,
        contactId: c.contact.id,
        phoneNumber: c.contact.phoneNumber,
        displayName: c.contact.displayName ?? memories[i]?.name ?? c.contact.phoneNumber,
        isBlacklisted: c.contact.isBlacklisted,
        conversationStatus: c.status,
        humanTakeover: c.humanTakeover,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        tags: c.tags,
        leadStatus: memories[i]?.status ?? null,
        serviceInterest: memories[i]?.serviceInterest ?? null,
        scheduledAt: memories[i]?.scheduledAt?.toISOString() ?? null,
        notes: memories[i]?.notes ?? null
      }));

      return { contacts, page, pageSize };
    }
  );

  /**
   * Retorna as mensagens de um contato específico + dados do contato.
   */
  app.get(
    "/instances/:id/crm/contacts/:contactId/messages",
    {
      config: { auth: "tenant", allowApiKey: false, requiredScopes: ["read"] },
      schema: {
        tags: ["CRM"],
        summary: "Retorna mensagens e dados de um contato",
        params: contactParamsSchema,
        querystring: messagesQuerySchema
      }
    },
    async (request, reply) => {
      const tenantId = requireTenantId(request);
      const { id: instanceId, contactId } = contactParamsSchema.parse(request.params);
      const { limit } = messagesQuerySchema.parse(request.query);
      const tenantPrisma = await app.tenantPrismaRegistry.getClient(tenantId);

      const contact = await tenantPrisma.contact.findFirst({
        where: { id: contactId, instanceId },
        select: { id: true, phoneNumber: true, displayName: true, isBlacklisted: true, notes: true }
      });

      if (!contact) {
        return reply.status(404).send({ message: "Contato não encontrado." });
      }

      const [messages, memory] = await Promise.all([
        tenantPrisma.message.findMany({
          where: { instanceId, remoteJid: { contains: contact.phoneNumber.slice(-8) } },
          orderBy: { createdAt: "asc" },
          take: limit,
          select: { id: true, direction: true, type: true, payload: true, status: true, createdAt: true }
        }),
        tenantPrisma.clientMemory
          .findFirst({
            where: { phoneNumber: { contains: contact.phoneNumber.slice(-8) } },
            select: { name: true, serviceInterest: true, status: true, scheduledAt: true, notes: true, isExistingClient: true }
          })
          .catch(() => null)
      ]);

      return {
        contact: {
          id: contact.id,
          phoneNumber: contact.phoneNumber,
          displayName: contact.displayName ?? memory?.name ?? contact.phoneNumber,
          isBlacklisted: contact.isBlacklisted,
          notes: contact.notes ?? memory?.notes ?? null,
          leadStatus: memory?.status ?? null,
          serviceInterest: memory?.serviceInterest ?? null,
          scheduledAt: memory?.scheduledAt?.toISOString() ?? null,
          isExistingClient: memory?.isExistingClient ?? false
        },
        messages: messages.map((m) => {
          const p = m.payload as Record<string, unknown> | null;
          return {
            id: m.id,
            direction: m.direction,
            type: m.type,
            text: String(p?.["text"] ?? p?.["caption"] ?? ""),
            status: m.status,
            createdAt: m.createdAt.toISOString()
          };
        })
      };
    }
  );
};
