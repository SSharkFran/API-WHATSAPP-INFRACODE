import { normalizePhoneNumber } from "../../../lib/phone.js";
import type { ConversationSession, LeadData } from "./types.js";

interface LeadAgentDeps {
  sendLeadAlert: (params: {
    tenantId: string;
    instanceId: string;
    phoneNumber: string;
    summary: string;
  }) => Promise<void>;
  onWarn?: (message: string) => void;
}

export class LeadAgent {
  private readonly sendLeadAlert: LeadAgentDeps["sendLeadAlert"];
  private readonly onWarn?: LeadAgentDeps["onWarn"];

  public constructor(deps: LeadAgentDeps) {
    this.sendLeadAlert = deps.sendLeadAlert;
    this.onWarn = deps.onWarn;
  }

  public async process(params: {
    responseText: string;
    resolvedContactNumber: string;
    session: ConversationSession;
    tenantId: string;
    instanceId: string;
    leadsPhoneNumber?: string | null;
    leadsEnabled?: boolean;
  }): Promise<{ cleanedText: string; leadData: LeadData | null }> {
    const summaryBlockPattern = /\[RESUMO_LEAD\]([\s\S]*?)\[\/RESUMO_LEAD\]/;
    const allSummaryBlocksPattern = /\[RESUMO_LEAD\][\s\S]*?\[\/RESUMO_LEAD\]/g;
    const summaryMatch = params.responseText.match(summaryBlockPattern);
    const cleanedText = params.responseText.replace(allSummaryBlocksPattern, "").trim();

    if (!summaryMatch?.[1]?.trim()) {
      return {
        cleanedText,
        leadData: null
      };
    }

    if (params.session.leadAlreadySent) {
      return {
        cleanedText,
        leadData: null
      };
    }

    const normalizedSummary = this.normalizeLeadSummary(summaryMatch[1].trim(), params.resolvedContactNumber);
    const leadData = this.parseLeadSummary(normalizedSummary);

    if (!leadData.isComplete) {
      return {
        cleanedText,
        leadData
      };
    }

    if (params.leadsEnabled !== false && params.leadsPhoneNumber) {
      await this.sendLeadAlert({
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        phoneNumber: params.leadsPhoneNumber,
        summary: normalizedSummary
      });
    } else {
      this.onWarn?.("Resumo de lead gerado, mas leadsPhoneNumber nao configurado ou leadsEnabled=false");
    }

    params.session.leadAlreadySent = true;

    return {
      cleanedText,
      leadData
    };
  }

  private normalizeLeadSummary(summary: string, resolvedContactNumber: string): string {
    const number = normalizePhoneNumber(resolvedContactNumber);
    const withResolvedNumber = summary.replace(/\{\{\s*numero\s*\}\}/gi, number);
    const contactLine = `Contato: ${number}`;

    if (/^Contato:\s*.+$/im.test(withResolvedNumber)) {
      return withResolvedNumber.replace(/^Contato:\s*.+$/im, contactLine);
    }

    return `${withResolvedNumber}\n${contactLine}`;
  }

  private parseLeadSummary(summary: string): LeadData {
    const name = this.sanitizeLeadField(this.extractLeadField(summary, /^Nome:\s*(.+)$/im));
    const contact = normalizePhoneNumber(this.extractLeadField(summary, /^Contato:\s*(.+)$/im) ?? "");
    const email = this.sanitizeLeadField(this.extractLeadField(summary, /^E-mail:\s*(.+)$/im));
    const companyName = this.sanitizeLeadField(this.extractLeadField(summary, /^Empresa:\s*(.+)$/im));
    const problemDescription = this.sanitizeLeadField(this.extractLeadField(summary, /^Problema:\s*(.+)$/im));
    const serviceInterest = this.sanitizeLeadField(
      this.extractLeadField(summary, /^Servi(?:\u00E7|c)o de interesse:\s*(.+)$/im)
    );
    const scheduledText = this.sanitizeLeadField(
      this.extractLeadField(summary, /^Hor(?:\u00E1|a)rio agendado:\s*(.+)$/im)
    );

    const leadData: LeadData = {
      rawSummary: summary,
      name,
      contact,
      email,
      companyName,
      problemDescription,
      serviceInterest,
      scheduledText,
      scheduledAt: this.parseScheduledAt(scheduledText),
      isComplete: false
    };

    leadData.isComplete = [leadData.name, leadData.contact, leadData.serviceInterest, leadData.scheduledText].every((value) =>
      Boolean(value)
    );

    return leadData;
  }

  private extractLeadField(summary: string, pattern: RegExp): string | null {
    return summary.match(pattern)?.[1]?.trim() ?? null;
  }

  private sanitizeLeadField(value: string | null): string | null {
    if (!value) {
      return null;
    }

    const normalized = value.normalize("NFKC").trim();

    if (!normalized) {
      return null;
    }

    if (["nao informado", "não informado", "(nome)", "(número)", "(numero)", "(celular)"].includes(normalized.toLowerCase())) {
      return null;
    }

    return normalized;
  }

  private parseScheduledAt(value: string | null): Date | null {
    const scheduledText = this.sanitizeLeadField(value);

    if (!scheduledText) {
      return null;
    }

    const directDate = new Date(scheduledText);

    if (!Number.isNaN(directDate.getTime())) {
      return directDate;
    }

    const match = scheduledText.match(
      /(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?:\s*(?:as|\u00E0s)?\s*(\d{1,2})(?::|h)?(\d{2})?)?/i
    );

    if (!match) {
      return null;
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const hour = match[4] ? Number(match[4]) : 0;
    const minute = match[5] ? Number(match[5]) : 0;
    const parsed = new Date(year, month - 1, day, hour, minute);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
