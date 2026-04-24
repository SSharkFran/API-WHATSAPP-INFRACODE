import type { InstanceEventBus, AdminCommandEvent, InstanceDomainEvent } from '../../lib/instance-events.js';
import type { AdminCommandService } from '../chatbot/admin-command.service.js';
import type { AdminActionLogEntry } from './admin-action-log.service.js';
import type { StatusSnapshot } from './status-query.service.js';

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
  documentDispatch: {
    dispatch: (
      event: AdminCommandEvent,
      documentType: string,
      clientName: string,
      sendResponse: (text: string) => Promise<void>
    ) => Promise<void>;
  };
  actionLog: {
    write: (tenantId: string, entry: AdminActionLogEntry) => void;
  };
  statusQuery: {
    getSnapshot: (tenantId: string, instanceId: string) => Promise<StatusSnapshot>;
    formatStatusMessage: (snapshot: StatusSnapshot) => string;
    formatResumoMessage: (snapshot: StatusSnapshot) => string;
  };
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
    this.deps.actionLog.write(event.tenantId, {
      triggeredByJid: event.fromJid,
      actionType: 'metrics_query',
      messageText: text,
      deliveryStatus: 'sent',
    });
  }

  protected async handleStatusCommand(event: AdminCommandEvent): Promise<void> {
    const snapshot = await this.deps.statusQuery.getSnapshot(event.tenantId, event.instanceId);
    const message = this.deps.statusQuery.formatStatusMessage(snapshot);
    await this.makeSendResponse(event)(message);
    this.deps.actionLog.write(event.tenantId, {
      triggeredByJid: event.fromJid,
      actionType: 'status_query',
      deliveryStatus: 'sent',
    });
  }

  protected async handleResumoCommand(event: AdminCommandEvent): Promise<void> {
    const snapshot = await this.deps.statusQuery.getSnapshot(event.tenantId, event.instanceId);
    const message = this.deps.statusQuery.formatResumoMessage(snapshot);
    await this.makeSendResponse(event)(message);
    this.deps.actionLog.write(event.tenantId, {
      triggeredByJid: event.fromJid,
      actionType: 'metrics_query',
      deliveryStatus: 'sent',
    });
  }

  protected async handleDocumentCommand(
    event: AdminCommandEvent,
    documentType: string,
    clientName: string
  ): Promise<void> {
    const text = (event.command ?? '').trim();
    await this.deps.documentDispatch.dispatch(
      event,
      documentType,
      clientName,
      this.makeSendResponse(event)   // sendResponse bound per-event — 4th param
    );
    this.deps.actionLog.write(event.tenantId, {
      triggeredByJid: event.fromJid,
      actionType: 'document_send',
      messageText: text,
      documentName: clientName,
      deliveryStatus: 'pending', // updated to 'sent' by DocumentDispatchService on success
    });
  }

  protected async handleEncerrarCommand(
    event: AdminCommandEvent,
    clientName: string
  ): Promise<void> {
    // Find client JID from CRM by name, then emit session.close_intent_detected
    // For now, acknowledge to admin — full wiring in Phase 8
    await this.makeSendResponse(event)(
      `Encerrando sessão com "${clientName}"... (verificar contato no CRM)`
    );
    this.deps.actionLog.write(event.tenantId, {
      triggeredByJid: event.fromJid,
      actionType: 'session_close',
      messageText: clientName,
      deliveryStatus: 'pending',
    });
  }
}
