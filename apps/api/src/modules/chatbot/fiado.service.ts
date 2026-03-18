import crypto from "node:crypto";
import type { FiadoItem, FiadoTab } from "@infracode/types";
import type { Prisma } from "../../../../../prisma/generated/tenant-client/index.js";
import type { TenantPrismaRegistry } from "../../lib/database.js";
import { ApiError } from "../../lib/errors.js";

interface FiadoServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
}

type TenantPrismaClient = Awaited<ReturnType<TenantPrismaRegistry["getClient"]>>;
type FiadoTabRecord = NonNullable<Awaited<ReturnType<TenantPrismaClient["fiadoTab"]["findUnique"]>>>;

export class FiadoService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;

  public constructor(deps: FiadoServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
  }

  public async addItem(
    tenantId: string,
    instanceId: string,
    phoneNumber: string,
    displayName: string | null,
    description: string,
    value: number
  ): Promise<FiadoTab> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const newItem: FiadoItem = {
      description,
      value,
      addedAt: new Date().toISOString()
    };

    const existing = await prisma.fiadoTab.findUnique({
      where: {
        instanceId_phoneNumber: {
          instanceId,
          phoneNumber
        }
      }
    });

    if (existing) {
      const items = [...(existing.items as unknown as FiadoItem[]), newItem];
      const total = Number(existing.total) + value;
      const updated = await prisma.fiadoTab.update({
        where: {
          instanceId_phoneNumber: {
            instanceId,
            phoneNumber
          }
        },
        data: {
          items: items as unknown as Prisma.InputJsonValue,
          total,
          displayName: displayName ?? existing.displayName,
          updatedAt: new Date()
        }
      });

      return this.mapTab(updated);
    }

    const created = await prisma.fiadoTab.create({
      data: {
        id: crypto.randomUUID(),
        instanceId,
        phoneNumber,
        displayName,
        total: value,
        items: [newItem] as unknown as Prisma.InputJsonValue,
        paidAt: null
      }
    });

    return this.mapTab(created);
  }

  public async getTab(tenantId: string, instanceId: string, phoneNumber: string): Promise<FiadoTab> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const tab = await prisma.fiadoTab.findUnique({
      where: {
        instanceId_phoneNumber: {
          instanceId,
          phoneNumber
        }
      }
    });

    if (!tab) {
      throw new ApiError(404, "FIADO_NOT_FOUND", "Fiado nao encontrado");
    }

    return this.mapTab(tab);
  }

  public async listTabs(tenantId: string, instanceId: string): Promise<FiadoTab[]> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const tabs = await prisma.fiadoTab.findMany({
      where: {
        instanceId,
        paidAt: null
      },
      orderBy: {
        updatedAt: "desc"
      }
    });

    return tabs.map((tab) => this.mapTab(tab));
  }

  public async clearTab(tenantId: string, instanceId: string, phoneNumber: string): Promise<FiadoTab> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const cleared = await prisma.fiadoTab.update({
      where: {
        instanceId_phoneNumber: {
          instanceId,
          phoneNumber
        }
      },
      data: {
        paidAt: new Date(),
        total: 0,
        items: []
      }
    });

    return this.mapTab(cleared);
  }

  private mapTab(tab: FiadoTabRecord): FiadoTab {
    return {
      id: tab.id,
      instanceId: tab.instanceId,
      phoneNumber: tab.phoneNumber,
      displayName: tab.displayName ?? null,
      total: Number(tab.total),
      items: tab.items as unknown as FiadoItem[],
      paidAt: tab.paidAt?.toISOString() ?? null,
      createdAt: tab.createdAt.toISOString(),
      updatedAt: tab.updatedAt.toISOString()
    };
  }
}
