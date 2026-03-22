import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export class AdminMemoryService {
  private readonly dataDir: string;

  public constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  public async handleAdminMessage(
    instanceId: string,
    tenantId: string,
    adminPhone: string,
    incomingPhone: string,
    text: string
  ): Promise<boolean> {
    if (!this.isAdmin(incomingPhone, adminPhone)) {
      return false;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    await this.appendMemory(instanceId, tenantId, this.extractMemoryContent(trimmed));
    return true;
  }

  private isAdmin(incomingPhone: string, adminPhone: string): boolean {
    const normalizedIncoming = this.normalizePhone(incomingPhone);
    const normalizedAdmin = this.normalizePhone(adminPhone);
    return normalizedIncoming === normalizedAdmin;
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/\D/g, "");
  }

  private extractMemoryContent(text: string): string {
    if (text.startsWith("/pitaco ")) {
      return text.slice("/pitaco ".length).trim();
    }
    if (text.startsWith("/regra ")) {
      return text.slice("/regra ".length).trim();
    }
    return text;
  }

  private async appendMemory(instanceId: string, tenantId: string, content: string): Promise<void> {
    const dirPath = resolve(this.dataDir, "tenants", tenantId, "instances", instanceId);
    const filePath = resolve(dirPath, "memory.md");

    await mkdir(dirPath, { recursive: true });

    const entry = `- [${this.formatDateTime(new Date())}] Instrucao do admin: ${content}\n`;

    await appendFile(filePath, entry, "utf-8");
  }

  private formatDateTime(date: Date): string {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }
}
