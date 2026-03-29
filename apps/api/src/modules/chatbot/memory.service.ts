import type { ClientMemory, ClientMemoryStatus, ClientMemoryTag } from "@infracode/types";
import type { TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";
import { normalizePhoneNumber } from "../../lib/phone.js";

interface ClientMemoryServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
}

interface UpsertClientMemoryInput {
  name?: string | null;
  isExistingClient?: boolean;
  projectDescription?: string | null;
  serviceInterest?: string | null;
  status?: ClientMemoryStatus;
  tags?: ClientMemoryTag[];
  notes?: string | null;
  lastContactAt?: Date;
  scheduledAt?: Date | null;
}

interface ListClientMemoryFilters {
  status?: ClientMemoryStatus;
  tag?: ClientMemoryTag;
}

export class ClientMemoryService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;

  public constructor(deps: ClientMemoryServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
  }

  public async findByPhone(tenantId: string, phoneNumber: string): Promise<ClientMemory | null> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const record = await prisma.clientMemory.findUnique({
      where: {
        phoneNumber: normalizePhoneNumber(phoneNumber)
      }
    });

    return record ? this.mapRecord(record) : null;
  }

  public async upsert(tenantId: string, phoneNumber: string, data: UpsertClientMemoryInput): Promise<ClientMemory> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    const tags = data.tags ? [...new Set(data.tags)] : undefined;
    const record = await prisma.clientMemory.upsert({
      where: {
        phoneNumber: normalizedPhoneNumber
      },
      create: {
        phoneNumber: normalizedPhoneNumber,
        ...(data.name !== undefined ? { name: data.name?.trim() || null } : {}),
        ...(data.isExistingClient !== undefined ? { isExistingClient: data.isExistingClient } : {}),
        ...(data.projectDescription !== undefined ? { projectDescription: data.projectDescription?.trim() || null } : {}),
        ...(data.serviceInterest !== undefined ? { serviceInterest: data.serviceInterest?.trim() || null } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(data.notes !== undefined ? { notes: data.notes?.trim() || null } : {}),
        lastContactAt: data.lastContactAt ?? new Date(),
        ...(data.scheduledAt !== undefined ? { scheduledAt: data.scheduledAt } : {})
      },
      update: {
        ...(data.name !== undefined ? { name: data.name?.trim() || null } : {}),
        ...(data.isExistingClient !== undefined ? { isExistingClient: data.isExistingClient } : {}),
        ...(data.projectDescription !== undefined ? { projectDescription: data.projectDescription?.trim() || null } : {}),
        ...(data.serviceInterest !== undefined ? { serviceInterest: data.serviceInterest?.trim() || null } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(data.notes !== undefined ? { notes: data.notes?.trim() || null } : {}),
        ...(data.lastContactAt !== undefined ? { lastContactAt: data.lastContactAt } : {}),
        ...(data.scheduledAt !== undefined ? { scheduledAt: data.scheduledAt } : {})
      }
    });

    return this.mapRecord(record);
  }

  public async addTag(tenantId: string, phoneNumber: string, tag: ClientMemoryTag): Promise<void> {
    const existing = await this.findByPhone(tenantId, phoneNumber);

    if (!existing) {
      await this.upsert(tenantId, phoneNumber, {
        tags: [tag]
      });
      return;
    }

    if (existing.tags.includes(tag)) {
      return;
    }

    await this.upsert(tenantId, phoneNumber, {
      tags: [...existing.tags, tag]
    });
  }

  public async removeTag(tenantId: string, phoneNumber: string, tag: ClientMemoryTag): Promise<void> {
    const existing = await this.findByPhone(tenantId, phoneNumber);

    if (!existing || !existing.tags.includes(tag)) {
      return;
    }

    await this.upsert(tenantId, phoneNumber, {
      tags: existing.tags.filter((existingTag) => existingTag !== tag)
    });
  }

  public async listForFollowUp(tenantId: string, daysSinceLastContact = 7): Promise<ClientMemory[]> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const cutoff = new Date(Date.now() - daysSinceLastContact * 24 * 60 * 60 * 1000);
    const records = await prisma.clientMemory.findMany({
      where: {
        tags: {
          has: "follow_up"
        },
        lastContactAt: {
          lt: cutoff
        }
      },
      orderBy: {
        lastContactAt: "asc"
      }
    });

    return records.map((record) => this.mapRecord(record));
  }

  public async list(tenantId: string, filters?: ListClientMemoryFilters): Promise<ClientMemory[]> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const records = await prisma.clientMemory.findMany({
      where: {
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.tag
          ? {
              tags: {
                has: filters.tag
              }
            }
          : {})
      },
      orderBy: {
        lastContactAt: "desc"
      }
    });

    return records.map((record) => this.mapRecord(record));
  }

  public async requireByPhone(tenantId: string, phoneNumber: string): Promise<ClientMemory> {
    const record = await this.findByPhone(tenantId, phoneNumber);

    if (!record) {
      throw new ApiError(404, "CLIENT_MEMORY_NOT_FOUND", "Memoria do cliente nao encontrada");
    }

    return record;
  }

  public async deleteByPhone(tenantId: string, phoneNumber: string): Promise<boolean> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    const result = await prisma.clientMemory.deleteMany({
      where: {
        phoneNumber: normalizedPhoneNumber
      }
    });

    return result.count > 0;
  }

  private mapRecord(record: {
    id: string;
    phoneNumber: string;
    name: string | null;
    isExistingClient: boolean;
    projectDescription: string | null;
    serviceInterest: string | null;
    status: string;
    tags: string[];
    notes: string | null;
    lastContactAt: Date;
    scheduledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): ClientMemory {
    return {
      id: record.id,
      phoneNumber: record.phoneNumber,
      name: record.name,
      isExistingClient: record.isExistingClient,
      projectDescription: record.projectDescription,
      serviceInterest: record.serviceInterest,
      status: record.status as ClientMemoryStatus,
      tags: record.tags as ClientMemoryTag[],
      notes: record.notes,
      lastContactAt: record.lastContactAt.toISOString(),
      scheduledAt: record.scheduledAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}
