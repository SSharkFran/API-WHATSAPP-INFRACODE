import type pino from 'pino';
import type { TenantPrismaRegistry } from '../../lib/database.js';
import type { InstanceEventBus } from '../../lib/instance-events.js';
import type {
  SessionFirstResponseEvent,
  SessionHandoffEvent,
  DocumentSentEvent,
  SessionUrgencyDetectedEvent,
} from '../../lib/instance-events.js';

export interface SessionMetricsCollectorDeps {
  eventBus: InstanceEventBus;
  tenantPrismaRegistry: TenantPrismaRegistry;
  logger: pino.Logger;
}

export class SessionMetricsCollector {
  private readonly logger: pino.Logger;

  constructor(private readonly deps: SessionMetricsCollectorDeps) {
    this.logger = deps.logger.child({ component: 'SessionMetricsCollector' });

    // session.opened — no DB write needed (SessionStateService already inserted the row)
    // Subscribe to track that collector is active for this event type (MET-01)
    this.deps.eventBus.on('session.opened', (_e) => {
      // SessionStateService already wrote the ConversationSession row on openSession().
      // No additional write needed here — just subscribing to confirm the event flows.
    });

    // session.first_response → write firstResponseMs (MET-03)
    this.deps.eventBus.on('session.first_response', (e) => {
      const event = e as SessionFirstResponseEvent;
      setImmediate(() => {
        void this.onFirstResponse(event).catch((err) =>
          this.logger.warn({ err }, '[metrics] session.first_response write failed')
        );
      });
    });

    // session.handoff → increment handoffCount (MET-01 handoff tracking)
    this.deps.eventBus.on('session.handoff', (e) => {
      const event = e as SessionHandoffEvent;
      setImmediate(() => {
        void this.onHandoff(event).catch((err) =>
          this.logger.warn({ err }, '[metrics] session.handoff write failed')
        );
      });
    });

    // document.sent → increment documentCount (MET-05)
    this.deps.eventBus.on('document.sent', (e) => {
      const event = e as DocumentSentEvent;
      setImmediate(() => {
        void this.onDocumentSent(event).catch((err) =>
          this.logger.warn({ err }, '[metrics] document.sent write failed')
        );
      });
    });

    // session.urgency_detected → write urgencyScore (URG-02 dashboard sort)
    this.deps.eventBus.on('session.urgency_detected', (e) => {
      const event = e as SessionUrgencyDetectedEvent;
      setImmediate(() => {
        void this.onUrgencyDetected(event).catch((err) =>
          this.logger.warn({ err }, '[metrics] session.urgency_detected write failed')
        );
      });
    });
  }

  private async onFirstResponse(event: SessionFirstResponseEvent): Promise<void> {
    const prisma = await this.deps.tenantPrismaRegistry.getClient(event.tenantId);
    const rowsAffected = await prisma.$executeRawUnsafe(
      `UPDATE "ConversationSession" SET "firstResponseMs" = $1, "updatedAt" = NOW() WHERE "id" = $2 AND "firstResponseMs" IS NULL`,
      event.firstResponseMs,
      event.sessionId
    );
    if ((rowsAffected as number) === 0) {
      this.logger.debug(
        { sessionId: event.sessionId },
        '[metrics] firstResponseMs already set or session not found'
      );
    }
  }

  private async onHandoff(event: SessionHandoffEvent): Promise<void> {
    const prisma = await this.deps.tenantPrismaRegistry.getClient(event.tenantId);
    const rowsAffected = await prisma.$executeRawUnsafe(
      `UPDATE "ConversationSession" SET "handoffCount" = COALESCE("handoffCount", 0) + 1, "updatedAt" = NOW() WHERE "id" = $1`,
      event.sessionId
    );
    if ((rowsAffected as number) === 0) {
      this.logger.warn(
        { sessionId: event.sessionId },
        '[metrics] onHandoff: 0 rows updated — session not found'
      );
    }
  }

  private async onDocumentSent(event: DocumentSentEvent): Promise<void> {
    if (!event.sessionId) {
      this.logger.warn(
        { instanceId: event.instanceId, remoteJid: event.remoteJid },
        '[metrics] document.sent: null sessionId — skipping documentCount increment'
      );
      return;
    }
    const prisma = await this.deps.tenantPrismaRegistry.getClient(event.tenantId);
    const rowsAffected = await prisma.$executeRawUnsafe(
      `UPDATE "ConversationSession" SET "documentCount" = COALESCE("documentCount", 0) + 1, "updatedAt" = NOW() WHERE "id" = $1`,
      event.sessionId
    );
    if ((rowsAffected as number) === 0) {
      this.logger.warn(
        { sessionId: event.sessionId },
        '[metrics] onDocumentSent: 0 rows updated — session closed before document write (benign)'
      );
    }
  }

  private async onUrgencyDetected(event: SessionUrgencyDetectedEvent): Promise<void> {
    const prisma = await this.deps.tenantPrismaRegistry.getClient(event.tenantId);
    await prisma.$executeRawUnsafe(
      `UPDATE "ConversationSession" SET "urgencyScore" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
      event.urgencyScore,
      event.sessionId
    );
  }
}
