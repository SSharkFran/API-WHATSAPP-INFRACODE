import type { ClientMemory } from "@infracode/types";
import type { ClientMemoryService } from "../memory.service.js";
import type { LeadData, MemoryContextResult } from "./types.js";

interface MemoryAgentDeps {
  clientMemoryService: ClientMemoryService;
}

export class MemoryAgent {
  private readonly clientMemoryService: ClientMemoryService;

  public constructor(deps: MemoryAgentDeps) {
    this.clientMemoryService = deps.clientMemoryService;
  }

  public async getContext(params: {
    tenantId: string;
    phoneNumber: string;
    name?: string | null;
    isNewSession?: boolean;
  }): Promise<MemoryContextResult> {
    const memory = await this.clientMemoryService.findByPhone(params.tenantId, params.phoneNumber);

    await this.clientMemoryService.upsert(params.tenantId, params.phoneNumber, {
      name: params.name?.trim() || undefined,
      lastContactAt: new Date()
    });

    return {
      memory,
      contextString: this.buildContextString(memory, params.isNewSession ?? false)
    };
  }

  public async update(params: {
    tenantId: string;
    phoneNumber: string;
    clientMessage: string;
    leadData?: LeadData | null;
    name?: string | null;
  }): Promise<void> {
    const currentMemory = await this.clientMemoryService.findByPhone(params.tenantId, params.phoneNumber);
    const updates: Parameters<ClientMemoryService["upsert"]>[2] = {
      name: params.name?.trim() || undefined,
      lastContactAt: new Date()
    };

    if (this.isFollowUpCandidateMessage(params.clientMessage)) {
      updates.status = "lead_frio";
      updates.tags = ["follow_up"];
    }

    if (params.leadData) {
      updates.name = params.leadData.name ?? updates.name;
      updates.projectDescription = params.leadData.problemDescription ?? undefined;
      updates.serviceInterest = params.leadData.serviceInterest ?? undefined;
      updates.scheduledAt = params.leadData.scheduledAt;
      updates.notes = this.mergeNotes(currentMemory?.notes, params.leadData);

      if (params.leadData.isComplete) {
        updates.status = "lead_quente";
        updates.tags = ["follow_up"];
      }
    }

    await this.clientMemoryService.upsert(params.tenantId, params.phoneNumber, updates);
  }

  private buildContextString(memory: ClientMemory | null, isNewSession: boolean): string {
    if (!memory) {
      return "";
    }

    const isReturningClient = memory.isExistingClient || (
      memory.lastContactAt != null &&
      Date.now() - new Date(memory.lastContactAt).getTime() > 4 * 60 * 60 * 1000 // > 4h
    );

    const lastContactFormatted = memory.lastContactAt
      ? this.formatLastContact(new Date(memory.lastContactAt))
      : null;

    const greetingInstruction = isNewSession && isReturningClient && memory.name
      ? `INSTRUCAO DE BOAS-VINDAS: Este e um cliente que ja foi atendido antes. Ao responder, cumprimente-o pelo nome ("${memory.name}") de forma natural e breve. Se houver projeto ou interesse registrado, pode fazer uma referencia curta para mostrar continuidade no atendimento.`
      : null;

    const lines = [
      "CONTEXTO DO CLIENTE (use para personalizar o atendimento):",
      `- Nome: ${memory.name ?? "nao informado"}`,
      `- Cliente existente: ${memory.isExistingClient ? "SIM" : "NAO ou desconhecido"}`,
      `- Projeto registrado: ${memory.projectDescription ?? "nenhum"}`,
      `- Interesse registrado: ${memory.serviceInterest ?? "nenhum"}`,
      `- Status: ${memory.status}`,
      lastContactFormatted ? `- Ultimo contato: ${lastContactFormatted}` : null,
      `- Observacoes: ${memory.notes ?? "nenhuma"}`
    ].filter((l): l is string => l !== null);

    const parts = [lines.join("\n")];
    if (greetingInstruction) {
      parts.push(greetingInstruction);
    }

    return parts.join("\n\n");
  }

  private formatLastContact(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "hoje";
    if (diffDays === 1) return "ontem";
    if (diffDays < 7) return `${diffDays} dias atras`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} semana(s) atras`;
    return `${Math.floor(diffDays / 30)} mes(es) atras`;
  }

  private mergeNotes(existingNotes: string | null | undefined, leadData: LeadData): string | undefined {
    const noteLines = [
      leadData.companyName ? `Empresa: ${leadData.companyName}` : null,
      leadData.email ? `E-mail: ${leadData.email}` : null
    ].filter((line): line is string => Boolean(line));

    if (noteLines.length === 0) {
      return undefined;
    }

    const existing = existingNotes?.trim();

    if (!existing) {
      return noteLines.join("\n");
    }

    const missingLines = noteLines.filter((line) => !existing.includes(line));

    if (missingLines.length === 0) {
      return existing;
    }

    return `${existing}\n${missingLines.join("\n")}`;
  }

  private isFollowUpCandidateMessage(input: string): boolean {
    if (!input) {
      return false;
    }

    const normalizedInput = input
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .trim()
      .toLowerCase();

    return [
      /\bnao\s+(?:tenho\s+)?interesse\b/i,
      /\bnao\s+agora\b/i,
      /\bvou\s+pensar\b/i,
      /\bdepois\b/i,
      /\bte\s+aviso\b/i,
      /\btalvez\b/i
    ].some((pattern) => pattern.test(normalizedInput));
  }
}
