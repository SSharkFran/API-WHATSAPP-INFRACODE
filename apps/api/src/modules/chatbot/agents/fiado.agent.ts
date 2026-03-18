import type { FiadoService } from "../fiado.service.js";

interface FiadoAgentDeps {
  fiadoService: FiadoService;
}

export class FiadoAgent {
  private readonly fiadoService: FiadoService;

  public constructor(deps: FiadoAgentDeps) {
    this.fiadoService = deps.fiadoService;
  }

  public async process(params: {
    message: string;
    phoneNumber: string;
    tenantId: string;
    instanceId: string;
    displayName?: string | null;
    fiadoEnabled: boolean;
  }): Promise<string | null> {
    if (!params.fiadoEnabled) {
      return null;
    }

    const normalizedMessage = params.message.normalize("NFKC").trim().toLowerCase();

    if (/\b(?:qual(?:\s+e)?|quanto)\s+(?:meu\s+)?fiado\b|\bquanto\s+(?:eu\s+)?devo\b/i.test(normalizedMessage)) {
      try {
        const tab = await this.fiadoService.getTab(params.tenantId, params.instanceId, params.phoneNumber);
        return `Seu fiado atual e de R$${tab.total.toFixed(2).replace(".", ",")} com ${tab.items.length} item(ns).`;
      } catch {
        return "Voce nao tem fiado em aberto no momento.";
      }
    }

    if (/\b(?:pagar|quitar|limpar)\s+fiado\b/i.test(normalizedMessage)) {
      try {
        await this.fiadoService.clearTab(params.tenantId, params.instanceId, params.phoneNumber);
        return "Fiado marcado como pago. Obrigado!";
      } catch {
        return "Nao encontrei fiado em aberto para este numero.";
      }
    }

    const wantsFiadoAdd =
      /\b(?:adiciona|anota|coloca|lanca)\b.*\bfiado\b/i.test(normalizedMessage) || /\bfiado\b/i.test(normalizedMessage);
    const fiadoRegex = /(\d+)\s+(.+?)\s+(?:por\s+)?(?:R\$\s*)?(\d+(?:[.,]\d{1,2})?)/i;
    const match = params.message.match(fiadoRegex);

    if (!wantsFiadoAdd || !match) {
      return null;
    }

    const quantity = Number.parseInt(match[1] ?? "0", 10);
    const description = `${quantity}x ${(match[2] ?? "").trim()}`;
    const value = Number.parseFloat((match[3] ?? "").replace(",", "."));

    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    const tab = await this.fiadoService.addItem(
      params.tenantId,
      params.instanceId,
      params.phoneNumber,
      params.displayName ?? null,
      description,
      value
    );
    const totalFormatted = tab.total.toFixed(2).replace(".", ",");

    return `Adicionado: ${description} - R$${value.toFixed(2).replace(".", ",")}\nSeu total: R$${totalFormatted}`;
  }
}
