import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Domain event interfaces
// ---------------------------------------------------------------------------

export interface SessionActivityEvent {
  type: 'session.activity';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string; // from Redis hash — may be empty string if session not yet persisted
}

export interface SessionCloseIntentEvent {
  type: 'session.close_intent_detected';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  intentLabel: string; // e.g. 'ENCERRAMENTO' — static label from SESS-09 stub, LLM label in Phase 5
}

export interface SessionUrgencyDetectedEvent {
  type: 'session.urgency_detected';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  urgencyScore: number; // 80 for URGENCIA_ALTA from intent pre-pass
}

export interface AdminCommandEvent {
  type: 'admin.command';
  tenantId: string;
  instanceId: string;
  command: string;
  fromJid: string; // admin JID
}

export interface SessionOpenedEvent {
  type: 'session.opened';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  contactId?: string | null;
}

export interface SessionFirstResponseEvent {
  type: 'session.first_response';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  firstResponseMs: number;
}

export interface SessionHandoffEvent {
  type: 'session.handoff';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
}

export interface SessionClosedEvent {
  type: 'session.closed';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  closedReason: string;
  durationSeconds: number | null;
}

export interface DocumentSentEvent {
  type: 'document.sent';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string | null;
}

export type InstanceDomainEvent =
  | SessionActivityEvent
  | SessionCloseIntentEvent
  | SessionUrgencyDetectedEvent   // NEW — Phase 5.2
  | AdminCommandEvent
  | SessionOpenedEvent
  | SessionFirstResponseEvent
  | SessionHandoffEvent
  | SessionClosedEvent
  | DocumentSentEvent;

// ---------------------------------------------------------------------------
// InstanceEventBus — typed EventEmitter wrapper
// ---------------------------------------------------------------------------

/**
 * Typed in-process event bus for InstanceOrchestrator domain events.
 * Typed overloads ensure TypeScript rejects unknown event names at compile time.
 * All listeners must catch their own errors to avoid propagating to the emit call site.
 */
export class InstanceEventBus extends EventEmitter {
  emit(event: InstanceDomainEvent['type'], payload: InstanceDomainEvent): boolean {
    return super.emit(event, payload);
  }

  on(event: InstanceDomainEvent['type'], listener: (payload: InstanceDomainEvent) => void): this {
    return super.on(event, listener);
  }

  off(event: InstanceDomainEvent['type'], listener: (payload: InstanceDomainEvent) => void): this {
    return super.off(event, listener);
  }
}
