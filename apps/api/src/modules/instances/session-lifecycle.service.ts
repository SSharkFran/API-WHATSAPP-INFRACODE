import { Worker as BullWorker } from "bullmq";
import type { Queue } from "bullmq";
import type { Redis as IORedis } from "ioredis";
import type pino from "pino";
import { QUEUE_NAMES } from "../../queues/queue-names.js";
import type { SessionStateService } from "./session-state.service.js";
import { SessionStatus } from "./conversation-session-manager.js";
import type { InstanceOrchestrator } from "./service.js";
import {
  createSessionTimeoutProcessor,
  type SessionTimeoutJobPayload,
} from "../../workers/session-timeout.worker.js";
import { type InstanceEventBus } from "../../lib/instance-events.js";
import { recognizeCloseIntent } from "../../lib/session-intents.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;       // 10 minutes production
const DEFAULT_SECOND_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes second window

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SessionLifecycleServiceDeps {
  redis: IORedis;
  queue: Queue;
  sessionStateService: SessionStateService;
  instanceOrchestrator: InstanceOrchestrator;
  config: {
    SESSION_LIFECYCLE_V2?: string;
    SESSION_TIMEOUT_MS?: string;
    NODE_ENV: string;
  };
  logger: pino.Logger;
  eventBus?: InstanceEventBus;
}

export interface SessionActivityParams {
  sessionId: string;
  tenantId: string;
  instanceId: string;
  remoteJid: string;
}

// ---------------------------------------------------------------------------
// SessionLifecycleService
// ---------------------------------------------------------------------------

export class SessionLifecycleService {
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly secondTimeoutMs: number;
  private readonly workerConnection: IORedis;
  private readonly ownsWorkerConnection: boolean;
  private readonly timeoutWorker?: BullWorker<SessionTimeoutJobPayload>;
  private readonly logger: pino.Logger;

  constructor(private readonly deps: SessionLifecycleServiceDeps) {
    this.logger = deps.logger.child({ component: "SessionLifecycleService" });
    this.enabled = deps.config.SESSION_LIFECYCLE_V2 === "true";
    this.timeoutMs = deps.config.SESSION_TIMEOUT_MS
      ? parseInt(deps.config.SESSION_TIMEOUT_MS, 10)
      : DEFAULT_TIMEOUT_MS;
    this.secondTimeoutMs = DEFAULT_SECOND_TIMEOUT_MS;

    // In test env: reuse the provided Redis connection (no duplicate needed)
    if (deps.config.NODE_ENV === "test") {
      this.workerConnection = deps.redis;
      this.ownsWorkerConnection = false;
      return;
    }

    // T-04-03-05: Worker uses redis.duplicate() with same options as original (Pitfall 2)
    this.workerConnection = deps.redis.duplicate();
    this.ownsWorkerConnection = true;

    if (this.enabled) {
      const processor = createSessionTimeoutProcessor({
        sessionStateService: deps.sessionStateService,
        instanceOrchestrator: deps.instanceOrchestrator,
        secondTimeoutMs: this.secondTimeoutMs,
        logger: this.logger,
      });
      this.timeoutWorker = new BullWorker<SessionTimeoutJobPayload>(
        QUEUE_NAMES.SESSION_TIMEOUT,
        processor,
        { autorun: true, connection: this.workerConnection as never, concurrency: 10 }
      );
    }

    // ---------------------------------------------------------------------------
    // InstanceEventBus subscriptions
    // T-04-04-01: every async listener wraps in .catch() so unhandled rejections
    // do NOT propagate to the InstanceOrchestrator emit call site
    // ---------------------------------------------------------------------------
    if (deps.eventBus) {
      deps.eventBus.on('session.activity', async (event) => {
        if (event.type !== 'session.activity') return;
        await this.recordActivity({
          sessionId: event.sessionId,
          tenantId: event.tenantId,
          instanceId: event.instanceId,
          remoteJid: event.remoteJid,
        }).catch(err =>
          this.logger.error({ errMsg: (err as Error).message, stack: (err as Error).stack, sessionId: event.sessionId }, '[lifecycle] error handling session.activity')
        );
      });

      deps.eventBus.on('session.close_intent_detected', async (event) => {
        if (event.type !== 'session.close_intent_detected') return;
        this.logger.info(
          { sessionId: event.sessionId, intentLabel: event.intentLabel },
          '[lifecycle] close intent detected'
        );
        // Transition to CONFIRMACAO_ENVIADA — Phase 5 will complete this wiring
        await this.deps.sessionStateService
          .updateStatus(event.tenantId, event.instanceId, event.remoteJid, SessionStatus.CONFIRMACAO_ENVIADA)
          .catch(err => this.logger.error({ errMsg: (err as Error).message, stack: (err as Error).stack }, '[lifecycle] error handling close_intent_detected'));
      });
    }
  }

  // ---------------------------------------------------------------------------
  // recordActivity — called on every inbound client message
  // ---------------------------------------------------------------------------

  /**
   * Called on every inbound client message.
   * - Returns immediately if SESSION_LIFECYCLE_V2 is not enabled (SESS-feature-flag).
   * - Returns immediately if humanTakeover is active (SESS-07).
   * - Enqueues / resets the inactivity timeout job with deduplication (SESS-03/04).
   *   BullMQ handles timer-reset semantics: extend=true means the TTL is extended on each call.
   */
  async recordActivity(params: SessionActivityParams): Promise<void> {
    if (!this.enabled) return;

    const { sessionId, tenantId, instanceId, remoteJid } = params;

    // SESS-07 fast path: humanTakeover → skip inactivity timeout entirely
    const isHuman = await this.deps.sessionStateService.isHumanTakeover(tenantId, instanceId, remoteJid);
    if (isHuman) {
      this.logger.debug({ sessionId }, "[lifecycle] humanTakeover active — skipping timeout reset");
      return;
    }

    // T-04-03-02: globally unique deduplication key prevents cross-tenant/instance collisions
    await this.deps.queue.add(
      "check-inactivity",
      { sessionId, tenantId, instanceId, remoteJid },
      {
        deduplication: {
          id: `session-timeout:${tenantId}:${instanceId}:${remoteJid}`,
          ttl: this.timeoutMs,
          extend: true,   // SESS-04: timer resets with each new message
          replace: true,
        },
        delay: this.timeoutMs,
      }
    );

    this.logger.debug({ sessionId, timeoutMs: this.timeoutMs }, "[lifecycle] inactivity timer reset");
  }

  // ---------------------------------------------------------------------------
  // processTimeoutJob — state machine logic (called by worker OR directly in tests)
  // ---------------------------------------------------------------------------

  /**
   * Processes a timeout job. Contains the state machine transition logic so it can
   * be called directly in unit tests without spinning up a real BullMQ worker.
   */
  async processTimeoutJob(params: SessionActivityParams): Promise<void> {
    const { sessionId, tenantId, instanceId, remoteJid } = params;
    const logger = this.logger.child({ sessionId });

    // T-04-03-01: Pitfall 6 — check state before acting; it may have changed since enqueue
    const state = await this.deps.sessionStateService.getSessionState(tenantId, instanceId, remoteJid);
    if (!state || !state.status) {
      logger.debug({ sessionId }, "[lifecycle] no Redis state — skipping (safe)");
      return;
    }

    // T-04-03-03: already closed — no double action
    if (state.status === SessionStatus.ENCERRADA || state.status === SessionStatus.INATIVA) {
      logger.debug({ sessionId, status: state.status }, "[lifecycle] session already closed — skipping");
      return;
    }

    if (state.status === SessionStatus.CONFIRMACAO_ENVIADA) {
      // Second timeout — client did not reply to the confirmation message
      logger.info({ sessionId, instanceId, remoteJid }, "[lifecycle] second timeout — transitioning to INATIVA");
      await this.deps.sessionStateService.closeSession({
        tenantId,
        instanceId,
        remoteJid,
        closedReason: "timeout_no_response",
      });
      return;
    }

    // First timeout — transition ATIVA → CONFIRMACAO_ENVIADA and send "still there?" message
    logger.info({ sessionId, instanceId, remoteJid }, "[lifecycle] first timeout — sending confirmation message");
    await this.deps.sessionStateService.updateStatus(tenantId, instanceId, remoteJid, SessionStatus.CONFIRMACAO_ENVIADA);
    try {
      await this.deps.instanceOrchestrator.sendSessionMessage(
        tenantId,
        instanceId,
        remoteJid,
        "Ainda deseja continuar o atendimento? Se não houver resposta, encerraremos em breve."
      );
    } catch (err) {
      logger.warn({ err, sessionId }, "[lifecycle] failed to send confirmation message — continuing");
    }
  }

  // ---------------------------------------------------------------------------
  // scheduleSecondTimeout — re-enqueues with fixed second-window delay
  // ---------------------------------------------------------------------------

  /**
   * Schedules the second-window timeout after the first confirmation message is sent.
   * Uses extend=false so the second window is fixed and not reset by new messages.
   */
  async scheduleSecondTimeout(params: SessionActivityParams): Promise<void> {
    if (!this.enabled) return;
    const { sessionId, tenantId, instanceId, remoteJid } = params;
    await this.deps.queue.add(
      "check-inactivity",
      { sessionId, tenantId, instanceId, remoteJid },
      {
        deduplication: {
          id: `session-timeout:${tenantId}:${instanceId}:${remoteJid}`,
          ttl: this.secondTimeoutMs,
          extend: false,  // second window is fixed — do not extend on activity
          replace: true,
        },
        delay: this.secondTimeoutMs,
      }
    );
    this.logger.debug({ sessionId }, "[lifecycle] second timeout window scheduled");
  }

  // ---------------------------------------------------------------------------
  // recognizeCloseIntent — SESS-09 stub
  // ---------------------------------------------------------------------------

  /**
   * SESS-09 stub: delegates to the shared recognizeCloseIntent utility in
   * apps/api/src/lib/session-intents.ts to avoid duplicate logic and circular
   * imports between service.ts and session-lifecycle.service.ts.
   * Phase 5 will replace the underlying utility with a Groq LLM pre-pass classifier.
   */
  recognizeCloseIntent(text: string): boolean {
    return recognizeCloseIntent(text);
  }

  // ---------------------------------------------------------------------------
  // close — graceful shutdown
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.timeoutWorker) {
      await this.timeoutWorker.close();
    }
    if (this.ownsWorkerConnection) {
      await this.workerConnection.quit();
    }
    this.logger.info("[lifecycle] closed");
  }
}
