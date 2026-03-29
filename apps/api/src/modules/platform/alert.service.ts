import type { PlatformPrisma } from "../../lib/database.js";
import type { InstanceOrchestrator } from "../instances/service.js";

interface PlatformConfigRecord {
  adminAlertPhone: string | null;
  groqUsageLimit: number;
  alertInstanceDown: boolean;
  alertNewLead: boolean;
  alertHighTokens: boolean;
}

const instanceLogAlertCooldownMs = 10 * 60 * 1000;

export class PlatformAlertService {
  private readonly platformPrisma: PlatformPrisma;
  private readonly instanceOrchestrator: InstanceOrchestrator;
  private readonly logAlertCooldowns = new Map<string, number>();
  private connectedInstanceCache:
    | {
        expiresAt: number;
        value: {
          tenantId: string;
          instanceId: string;
          name: string;
        } | null;
      }
    | null = null;

  public constructor(
    platformPrisma: PlatformPrisma,
    instanceOrchestrator: InstanceOrchestrator
  ) {
    this.platformPrisma = platformPrisma;
    this.instanceOrchestrator = instanceOrchestrator;
  }

  private async getConfig(): Promise<PlatformConfigRecord | null> {
    const config = await this.platformPrisma.platformConfig.findUnique({
      where: { id: "singleton" }
    });
    return config;
  }

  private async getAdminPhone(): Promise<string | null> {
    const config = await this.getConfig();
    return config?.adminAlertPhone ?? null;
  }

  private async getAnyConnectedInstance(): Promise<{
    tenantId: string;
    instanceId: string;
    name: string;
  } | null> {
    if (this.connectedInstanceCache && this.connectedInstanceCache.expiresAt > Date.now()) {
      return this.connectedInstanceCache.value;
    }

    const tenants = await this.platformPrisma.tenant.findMany({
      where: {
        status: "ACTIVE",
        suspendedAt: null
      },
      select: { id: true }
    });

    for (const tenant of tenants) {
      try {
        const instances = await this.instanceOrchestrator.listInstances(tenant.id);
        const connected = instances.find((i) => i.status === "CONNECTED");
        if (connected) {
          const resolved = {
            tenantId: tenant.id,
            instanceId: connected.id,
            name: connected.name
          };

          this.connectedInstanceCache = {
            expiresAt: Date.now() + 30_000,
            value: resolved
          };

          return resolved;
        }
      } catch {
        continue;
      }
    }

    this.connectedInstanceCache = {
      expiresAt: Date.now() + 30_000,
      value: null
    };

    return null;
  }

  async alertInstanceDown(
    tenantId: string,
    instanceId: string,
    instanceName: string
  ): Promise<void> {
    const config = await this.getConfig();
    if (!config?.adminAlertPhone || !config.alertInstanceDown) return;

    const phone = config.adminAlertPhone;
    const msg = `⚠️ *ALERTA InfraCode*\n\nInstância caída!\n\nTenant: ${tenantId}\nInstância: ${instanceName} (${instanceId})\nHorário: ${new Date().toLocaleString("pt-BR")}`;

    await this.sendAdminAlert(phone, msg);
  }

  async alertInstanceUp(
    tenantId: string,
    instanceId: string,
    instanceName: string
  ): Promise<void> {
    const config = await this.getConfig();
    if (!config?.adminAlertPhone || !config.alertInstanceDown) return;

    const phone = config.adminAlertPhone;
    const msg = `✅ *InfraCode*\n\nInstância reconectada!\n\nTenant: ${tenantId}\nInstância: ${instanceName}\nHorário: ${new Date().toLocaleString("pt-BR")}`;

    await this.sendAdminAlert(phone, msg);
  }

  async alertHighTokenUsage(
    tenantId: string,
    provider: string,
    usagePercent: number
  ): Promise<void> {
    const config = await this.getConfig();
    if (!config?.adminAlertPhone || !config.alertHighTokens) return;

    const phone = config.adminAlertPhone;
    const msg = `🔴 *ALERTA InfraCode*\n\nUso de tokens alto!\n\nTenant: ${tenantId}\nProvider: ${provider}\nUso: ${usagePercent}% do limite\nHorário: ${new Date().toLocaleString("pt-BR")}`;

    await this.sendAdminAlert(phone, msg);
  }

  async alertNewLead(
    tenantId: string,
    instanceName: string,
    leadSummary: string,
    senderPhoneNumber: string
  ): Promise<boolean> {
    const alertMessage = `📋 *Novo lead — InfraCode*\n\nTenant: ${tenantId}\nInstância: ${instanceName}\n\n${leadSummary}`;
    return this.alertLeadMessage(alertMessage, senderPhoneNumber);
  }

  async alertLeadMessage(alertMessage: string, senderPhoneNumber: string): Promise<boolean> {
    const config = await this.getConfig();
    if (!config?.adminAlertPhone || !config.alertNewLead) return false;

    const phone = config.adminAlertPhone;
    const renderedMessage = alertMessage.replace(/\{\{numero\}\}/g, senderPhoneNumber);

    return this.sendAdminAlert(phone, renderedMessage);
  }

  async sendAlertToPhone(phone: string, message: string): Promise<boolean> {
    return this.sendAdminAlert(phone, message);
  }

  async sendInstanceAlert(
    tenantId: string,
    instanceId: string,
    phone: string,
    message: string
  ): Promise<boolean> {
    try {
      await this.instanceOrchestrator.sendMessage(tenantId, instanceId, {
        type: "text",
        to: phone,
        targetJid: `${phone}@s.whatsapp.net`,
        text: message
      });
      return true;
    } catch (err) {
      console.error("[alert] erro ao enviar alerta pela instancia:", err);
      return false;
    }
  }

  async alertCriticalError(
    tenantId: string,
    instanceId: string,
    error: string
  ): Promise<void> {
    const config = await this.getConfig();
    if (!config?.adminAlertPhone) return;

    const phone = config.adminAlertPhone;
    const msg = `🚨 *ERRO CRÍTICO — InfraCode*\n\nTenant: ${tenantId}\nInstância: ${instanceId}\nErro: ${error.slice(0, 200)}\nHorário: ${new Date().toLocaleString("pt-BR")}`;

    await this.sendAdminAlert(phone, msg);
  }

  async alertInstanceLogError(
    tenantId: string,
    instanceId: string,
    instanceName: string,
    logMessage: string,
    context?: Record<string, unknown>
  ): Promise<void> {
    const config = await this.getConfig();
    if (!config?.adminAlertPhone) return;

    const normalizedMessage = logMessage.replace(/\s+/g, " ").trim();
    const dedupeKey = `${tenantId}:${instanceId}:${normalizedMessage.slice(0, 160)}`;
    const now = Date.now();

    for (const [key, expiresAt] of this.logAlertCooldowns.entries()) {
      if (expiresAt <= now) {
        this.logAlertCooldowns.delete(key);
      }
    }

    const activeCooldown = this.logAlertCooldowns.get(dedupeKey);

    if (activeCooldown && activeCooldown > now) {
      return;
    }

    this.logAlertCooldowns.set(dedupeKey, now + instanceLogAlertCooldownMs);

    let renderedContext = "";

    if (context && Object.keys(context).length > 0) {
      try {
        const serialized = JSON.stringify(context);
        renderedContext = serialized ? `\nContexto: ${serialized.slice(0, 280)}` : "";
      } catch {
        renderedContext = "";
      }
    }

    const phone = config.adminAlertPhone;
    const msg = `🚨 *ERRO DE LOG — InfraCode*\n\nTenant: ${tenantId}\nInstância: ${instanceName} (${instanceId})\nLog: ${normalizedMessage.slice(0, 220)}${renderedContext}\nHorário: ${new Date().toLocaleString("pt-BR")}`;

    await this.sendAdminAlert(phone, msg);
  }

  async getConfigPublic(): Promise<PlatformConfigRecord> {
    const config = await this.platformPrisma.platformConfig.findUnique({
      where: { id: "singleton" }
    });

    if (!config) {
      const created = await this.platformPrisma.platformConfig.create({
        data: { id: "singleton" }
      });
      return {
        adminAlertPhone: created.adminAlertPhone,
        groqUsageLimit: created.groqUsageLimit,
        alertInstanceDown: created.alertInstanceDown,
        alertNewLead: created.alertNewLead,
        alertHighTokens: created.alertHighTokens
      };
    }

    return {
      adminAlertPhone: config.adminAlertPhone,
      groqUsageLimit: config.groqUsageLimit,
      alertInstanceDown: config.alertInstanceDown,
      alertNewLead: config.alertNewLead,
      alertHighTokens: config.alertHighTokens
    };
  }

  async updateConfig(input: {
    adminAlertPhone?: string | null;
    groqUsageLimit?: number;
    alertInstanceDown?: boolean;
    alertNewLead?: boolean;
    alertHighTokens?: boolean;
  }): Promise<PlatformConfigRecord> {
    const updated = await this.platformPrisma.platformConfig.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        adminAlertPhone: input.adminAlertPhone ?? null,
        groqUsageLimit: input.groqUsageLimit ?? 80,
        alertInstanceDown: input.alertInstanceDown ?? true,
        alertNewLead: input.alertNewLead ?? true,
        alertHighTokens: input.alertHighTokens ?? true
      },
      update: {
        ...(input.adminAlertPhone !== undefined && { adminAlertPhone: input.adminAlertPhone }),
        ...(input.groqUsageLimit !== undefined && { groqUsageLimit: input.groqUsageLimit }),
        ...(input.alertInstanceDown !== undefined && { alertInstanceDown: input.alertInstanceDown }),
        ...(input.alertNewLead !== undefined && { alertNewLead: input.alertNewLead }),
        ...(input.alertHighTokens !== undefined && { alertHighTokens: input.alertHighTokens })
      }
    });

    return {
      adminAlertPhone: updated.adminAlertPhone,
      groqUsageLimit: updated.groqUsageLimit,
      alertInstanceDown: updated.alertInstanceDown,
      alertNewLead: updated.alertNewLead,
      alertHighTokens: updated.alertHighTokens
    };
  }

  private async sendAdminAlert(phone: string, message: string): Promise<boolean> {
    try {
      const sender = await this.getAnyConnectedInstance();
      if (!sender) {
        console.warn("[alert] nenhuma instância disponível para enviar alerta admin");
        return false;
      }

      await this.instanceOrchestrator.sendMessage(sender.tenantId, sender.instanceId, {
        type: "text",
        to: phone,
        targetJid: `${phone}@s.whatsapp.net`,
        text: message
      });
      return true;
    } catch (err) {
      console.error("[alert] erro ao enviar alerta admin:", err);
      return false;
    }
  }
}
