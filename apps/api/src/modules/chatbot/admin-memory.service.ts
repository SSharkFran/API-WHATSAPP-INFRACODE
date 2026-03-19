import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export class AdminMemoryService {
  private readonly dataDir: string;

  public constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  public async handleAdminCommand(
    instanceId: string,
    adminPhone: string,
    incomingPhone: string,
    text: string
  ): Promise<boolean> {
    if (!this.isAdmin(incomingPhone, adminPhone)) {
      return false;
    }

    const trimmed = text.trim();
    if (!this.isCommand(trimmed)) {
      return false;
    }

    const ruleContent = this.extractRuleContent(trimmed);
    if (!ruleContent) {
      return false;
    }

    await this.appendRule(instanceId, ruleContent);
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

  private isCommand(text: string): boolean {
    return text.startsWith("/pitaco ") || text.startsWith("/regra ");
  }

  private extractRuleContent(text: string): string | null {
    if (text.startsWith("/pitaco ")) {
      return text.slice("/pitaco ".length).trim();
    }
    if (text.startsWith("/regra ")) {
      return text.slice("/regra ".length).trim();
    }
    return null;
  }

  private async appendRule(instanceId: string, ruleContent: string): Promise<void> {
    const dirPath = resolve(this.dataDir, "instances", instanceId);
    const filePath = resolve(dirPath, "memory.md");

    await mkdir(dirPath, { recursive: true });

    const date = new Date();
    const formattedDate = this.formatDate(date);
    const entry = `- [${formattedDate}] Regra adicionada: ${ruleContent}\n`;

    await appendFile(filePath, entry, "utf-8");
  }

  private formatDate(date: Date): string {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  }
}
