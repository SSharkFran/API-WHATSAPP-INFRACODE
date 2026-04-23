import type { InstanceEventBus, AdminCommandEvent, InstanceDomainEvent } from '../../lib/instance-events.js';
import type { AdminCommandService } from '../chatbot/admin-command.service.js';

// Minimal logger interface — compatible with pino.Logger and console-wrapper shims
export interface AdminCommandHandlerLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  info?(obj: Record<string, unknown>, msg?: string): void;
}

export interface AdminCommandHandlerDeps {
  eventBus: InstanceEventBus;
  adminCommandService: AdminCommandService;
  sendAutomatedTextMessage: (
    tenantId: string,
    instanceId: string,
    phone: string,
    jid: string,
    text: string,
    meta: { action: string; kind: string }
  ) => Promise<void>;
  logger: AdminCommandHandlerLogger;
}

export class AdminCommandHandler {
  constructor(private readonly deps: AdminCommandHandlerDeps) {
    deps.eventBus.on('admin.command', (payload: InstanceDomainEvent) => {
      const event = payload as AdminCommandEvent;
      setImmediate(() =>
        void this.handle(event).catch((err) =>
          deps.logger.warn({ err }, '[AdminCommandHandler] unhandled error')
        )
      );
    });
  }

  private makeSendResponse(event: AdminCommandEvent) {
    return async (text: string) => {
      await this.deps.sendAutomatedTextMessage(
        event.tenantId,
        event.instanceId,
        event.fromJid.replace(/@[^@]+$/, ''),
        event.fromJid,
        text,
        { action: 'admin_command_response', kind: 'chatbot' }
      );
    };
  }

  private async handle(event: AdminCommandEvent): Promise<void> {
    const text = (event.command ?? '').trim();

    if (text === '/status') {
      await this.handleStatusCommand(event);
      return;
    }
    if (text === '/resumo') {
      await this.handleResumoCommand(event);
      return;
    }
    const contratoMatch = text.match(/^\/contrato\s+(.+)$/i);
    if (contratoMatch) {
      await this.handleDocumentCommand(event, 'contrato', contratoMatch[1].trim());
      return;
    }
    const propostaMatch = text.match(/^\/proposta\s+(.+)$/i);
    if (propostaMatch) {
      await this.handleDocumentCommand(event, 'proposta', propostaMatch[1].trim());
      return;
    }
    const encerrarMatch = text.match(/^\/encerrar\s+(.+)$/i);
    if (encerrarMatch) {
      await this.handleEncerrarCommand(event, encerrarMatch[1].trim());
      return;
    }

    // Tier 2: LLM free-text fallback
    const sendResponse = this.makeSendResponse(event);
    await this.deps.adminCommandService.handleCommand({
      tenantId: event.tenantId,
      instanceId: event.instanceId,
      text,
      adminPhone: event.fromJid,
      sendResponse,
      sendMessageToClient: async (_jid, _phone, _msg) => false, // wired in Plan 7.2
    });
  }

  // Stub implementations — real bodies added in Plan 7.2 (document) and Plan 7.4 (status/resumo)
  protected async handleStatusCommand(event: AdminCommandEvent): Promise<void> {
    await this.makeSendResponse(event)(
      'Status: comando /status será implementado no Plano 7.4.'
    );
  }

  protected async handleResumoCommand(event: AdminCommandEvent): Promise<void> {
    await this.makeSendResponse(event)(
      'Resumo: comando /resumo será implementado no Plano 7.4.'
    );
  }

  protected async handleDocumentCommand(
    event: AdminCommandEvent,
    _documentType: string,
    _clientName: string
  ): Promise<void> {
    await this.makeSendResponse(event)(
      'Envio de documento será implementado no Plano 7.2.'
    );
  }

  protected async handleEncerrarCommand(
    event: AdminCommandEvent,
    _clientName: string
  ): Promise<void> {
    await this.makeSendResponse(event)(
      'Encerramento de sessão via comando será implementado no Plano 7.2.'
    );
  }
}
