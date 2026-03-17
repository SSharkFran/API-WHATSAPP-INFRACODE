import crypto from "node:crypto";
import type { FiadoItem, FiadoTab } from "@infracode/types";
import { ApiError } from "../../lib/errors.js";
import type { TenantPrismaRegistry } from "../../lib/database.js";

interface FiadoServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
}

export class FiadoService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;

  constructor(deps: FiadoServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
  }

  async addItem(
    tenantId: string,
    instanceId: string,
    phoneNumber: string,
    displayName: string | null,
    description: string,
    value: number
  ) {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const newItem: FiadoItem = { description, value, addedAt: new Date().toISOString() };

    const existing = await (prisma as any).fiadoTab.findUnique({
      where: { instanceId_phoneNumber: { instanceId, phoneNumber } }
    });

    if (existing) {
      const items = [...(existing.items as FiadoItem[]), newItem];
      const total = Number(existing.total) + value;
      return (prisma as any).fiadoTab.update({
        where: { instanceId_phoneNumber: { instanceId, phoneNumber } },
        data: { items, total, displayName: displayName ?? existing.displayName, updatedAt: new Date() }
      });
    }

    return (prisma as any).fiadoTab.create({
      data: {
        id: crypto.randomUUID(),
        instanceId,
        phoneNumber,
        displayName,
        total: value,
        items: [newItem],
        paidAt: null
      }
    });
  }

  async getTab(tenantId: string, instanceId: string, phoneNumber: string) {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const tab = await (prisma as any).fiadoTab.findUnique({
      where: { instanceId_phoneNumber: { instanceId, phoneNumber } }
    });
    if (!tab) throw new ApiError(404, "FIADO_NOT_FOUND", "Fiado não encontrado");
    return this.mapTab(tab);
  }

  async listTabs(tenantId: string, instanceId: string) {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const tabs = await (prisma as any).fiadoTab.findMany({
      where: { instanceId, paidAt: null },
      orderBy: { updatedAt: "desc" }
    });
    return tabs.map((t: any) => this.mapTab(t));
  }

  async clearTab(tenantId: string, instanceId: string, phoneNumber: string) {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    return (prisma as any).fiadoTab.update({
      where: { instanceId_phoneNumber: { instanceId, phoneNumber } },
      data: { paidAt: new Date(), total: 0, items: [] }
    });
  }

  private mapTab(tab: any) {
    return {
      id: tab.id,
      instanceId: tab.instanceId,
      phoneNumber: tab.phoneNumber,
      displayName: tab.displayName ?? null,
      total: Number(tab.total),
      items: tab.items as FiadoItem[],
      paidAt: tab.paidAt?.toISOString() ?? null,
      createdAt: tab.createdAt.toISOString(),
      updatedAt: tab.updatedAt.toISOString()
    };
  }
}
