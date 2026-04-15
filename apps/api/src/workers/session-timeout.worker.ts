import type { Job } from "bullmq";
import type pino from "pino";
import type { SessionStateService } from "../modules/instances/session-state.service.js";
import type { InstanceOrchestrator } from "../modules/instances/service.js";
import { SessionStatus } from "../modules/instances/conversation-session-manager.js";

export interface SessionTimeoutJobPayload {
  sessionId: string;
  tenantId: string;
  instanceId: string;
  remoteJid: string;
}

export interface SessionTimeoutWorkerDeps {
  sessionStateService: SessionStateService;
  instanceOrchestrator: InstanceOrchestrator;
  secondTimeoutMs: number;
  logger: pino.Logger;
}

/**
 * Factory that creates a BullMQ processor function for session-timeout jobs.
 *
 * State machine transitions (SESS-05):
 *   ATIVA              → sends confirmation message → transitions to CONFIRMACAO_ENVIADA
 *   CONFIRMACAO_ENVIADA → client did not reply → calls closeSession (INATIVA)
 *   ENCERRADA / INATIVA → no-op (already closed)
 *   null state          → no-op (Pitfall 6: Redis TTL expired or session never opened)
 */
export const createSessionTimeoutProcessor = (deps: SessionTimeoutWorkerDeps) =>
  async (job: Job<SessionTimeoutJobPayload>): Promise<void> => {
    const { sessionId, tenantId, instanceId, remoteJid } = job.data;
    const logger = deps.logger.child({ component: "SessionTimeoutWorker", sessionId });

    // T-04-03-01: Pitfall 6 — always check state before acting
    const state = await deps.sessionStateService.getSessionState(tenantId, instanceId, remoteJid);
    if (!state || !state.status) {
      logger.debug({ sessionId }, "[session-timeout] no Redis state — skipping (safe)");
      return;
    }

    // T-04-03-03: already closed — no double action
    if (state.status === SessionStatus.ENCERRADA || state.status === SessionStatus.INATIVA) {
      logger.debug({ sessionId, status: state.status }, "[session-timeout] session already closed — skipping");
      return;
    }

    if (state.status === SessionStatus.CONFIRMACAO_ENVIADA) {
      // Second timeout — client did not reply to the confirmation message
      logger.info({ sessionId, instanceId, remoteJid }, "[session-timeout] second timeout — transitioning to INATIVA");
      await deps.sessionStateService.closeSession({
        tenantId,
        instanceId,
        remoteJid,
        closedReason: "timeout_no_response",
      });
      return;
    }

    // First timeout — transition ATIVA → CONFIRMACAO_ENVIADA and send "still there?" message
    logger.info({ sessionId, instanceId, remoteJid }, "[session-timeout] first timeout — sending confirmation message");
    await deps.sessionStateService.updateStatus(tenantId, instanceId, remoteJid, SessionStatus.CONFIRMACAO_ENVIADA);
    try {
      await deps.instanceOrchestrator.sendSessionMessage(
        tenantId,
        instanceId,
        remoteJid,
        "Ainda deseja continuar o atendimento? Se não houver resposta, encerraremos em breve."
      );
    } catch (err) {
      logger.warn({ err, sessionId }, "[session-timeout] failed to send confirmation message — continuing");
    }
    // Note: the second-window job re-enqueue is handled by SessionLifecycleService.scheduleSecondTimeout()
    // which is triggered by the SessionLifecycleService after calling processTimeoutJob().
  };
