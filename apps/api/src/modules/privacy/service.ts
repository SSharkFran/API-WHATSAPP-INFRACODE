import type { TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import { normalizePhoneNumber, toJid } from "../../lib/phone.js";

interface PrivacyServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
}

/**
 * Implementa exportacao e exclusao de dados pessoais para LGPD.
 */
export class PrivacyService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;

  public constructor(deps: PrivacyServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
  }

  /**
   * Exporta contatos, conversas e mensagens de um titular por numero.
   */
  public async exportData(tenantId: string, phoneNumber: string, instanceId?: string) {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const contacts = await prisma.contact.findMany({
      where: {
        phoneNumber: normalizedPhone,
        ...(instanceId ? { instanceId } : {})
      }
    });
    const contactIds = contacts.map((contact) => contact.id);
    const remoteJid = toJid(normalizedPhone);

    const [conversations, messages] = await Promise.all([
      prisma.conversation.findMany({
        where: {
          ...(contactIds.length > 0 ? { contactId: { in: contactIds } } : { id: "__none__" }),
          ...(instanceId ? { instanceId } : {})
        }
      }),
      prisma.message.findMany({
        where: {
          remoteJid,
          ...(instanceId ? { instanceId } : {})
        },
        orderBy: {
          createdAt: "desc"
        }
      })
    ]);

    if (contacts.length === 0 && conversations.length === 0 && messages.length === 0) {
      throw new ApiError(404, "DATA_SUBJECT_NOT_FOUND", "Nenhum dado encontrado para o numero informado");
    }

    return {
      exportedAt: new Date().toISOString(),
      phoneNumber: normalizedPhone,
      totals: {
        contacts: contacts.length,
        conversations: conversations.length,
        messages: messages.length
      },
      data: {
        contacts: contacts.map((contact) => ({
          id: contact.id,
          instanceId: contact.instanceId,
          displayName: contact.displayName,
          fields: contact.fields,
          notes: contact.notes,
          isBlacklisted: contact.isBlacklisted,
          createdAt: contact.createdAt.toISOString(),
          updatedAt: contact.updatedAt.toISOString()
        })),
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          instanceId: conversation.instanceId,
          status: conversation.status,
          tags: conversation.tags,
          slaDeadlineAt: conversation.slaDeadlineAt?.toISOString() ?? null,
          lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString()
        })),
        messages: messages.map((message) => ({
          id: message.id,
          instanceId: message.instanceId,
          direction: message.direction,
          type: message.type,
          status: message.status,
          payload: message.payload,
          traceId: message.traceId,
          createdAt: message.createdAt.toISOString(),
          updatedAt: message.updatedAt.toISOString()
        }))
      }
    };
  }

  /**
   * Exclui os dados de um titular por numero e retorna os totais removidos.
   */
  public async deleteData(tenantId: string, phoneNumber: string, instanceId?: string) {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const remoteJid = toJid(normalizedPhone);
    const contacts = await prisma.contact.findMany({
      where: {
        phoneNumber: normalizedPhone,
        ...(instanceId ? { instanceId } : {})
      }
    });
    const contactIds = contacts.map((contact) => contact.id);

    const [messageCount, conversationCount] = await Promise.all([
      prisma.message.count({
        where: {
          remoteJid,
          ...(instanceId ? { instanceId } : {})
        }
      }),
      prisma.conversation.count({
        where: {
          ...(contactIds.length > 0 ? { contactId: { in: contactIds } } : { id: "__none__" }),
          ...(instanceId ? { instanceId } : {})
        }
      })
    ]);

    await prisma.$transaction(async (tx) => {
      if (contactIds.length > 0) {
        await tx.conversation.deleteMany({
          where: {
            contactId: {
              in: contactIds
            },
            ...(instanceId ? { instanceId } : {})
          }
        });
      }

      await tx.message.deleteMany({
        where: {
          remoteJid,
          ...(instanceId ? { instanceId } : {})
        }
      });

      if (contactIds.length > 0) {
        await tx.contact.deleteMany({
          where: {
            id: {
              in: contactIds
            },
            ...(instanceId ? { instanceId } : {})
          }
        });
      }
    });

    return {
      deletedAt: new Date().toISOString(),
      phoneNumber: normalizedPhone,
      totals: {
        contacts: contacts.length,
        conversations: conversationCount,
        messages: messageCount
      }
    };
  }
}
