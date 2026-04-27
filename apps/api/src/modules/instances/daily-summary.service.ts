import type pino from 'pino';
import type { Redis as IORedis } from 'ioredis';
import type { TenantPrismaRegistry } from '../../lib/database.js';
import type { AdminCommandService } from '../chatbot/admin-command.service.js';
import {
  sanitizeChatbotModules,
  getResumoDiarioModuleConfig,
  getAprendizadoContinuoModuleConfig,
} from '../chatbot/module-runtime.js';

export interface DailySummaryServiceDeps {
  redis: IORedis;
  tenantPrismaRegistry: TenantPrismaRegistry;
  adminCommandService: AdminCommandService;
  sendMessage: (
    tenantId: string,
    instanceId: string,
    adminPhone: string,
    adminJid: string,
    text: string,
    meta: Record<string, unknown>
  ) => Promise<void>;
  logger: pino.Logger;
}

interface SessionMetricsRow {
  startedCount: unknown;
  endedCount: unknown;
  inactiveCount: unknown;
  transferredCount: unknown;
  timedOutCount: unknown;
  totalClosedCount: unknown;
  avgDurationSeconds: unknown;
}

export class DailySummaryService {
  private readonly logger: pino.Logger;
  private readonly dailySummarySentDates = new Map<string, string>();

  constructor(private readonly deps: DailySummaryServiceDeps) {
    this.logger = deps.logger.child({ component: 'DailySummaryService' });
  }

  /**
   * Main entry point called by InstanceOrchestrator scheduler.
   * workers: Map<workerKey, unknown> where workerKey = "tenantId:instanceId"
   */
  async sendForAllInstances(workers: Map<string, unknown>): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);

    for (const workerKey of workers.keys()) {
      const [tenantId, instanceId] = workerKey.split(':');
      if (!tenantId || !instanceId) continue;

      const summaryKey = `${tenantId}:${instanceId}`;
      const redisDedupeKey = `daily-summary:sent:${summaryKey}:${today}`;

      // In-memory fast path (same process)
      if (this.dailySummarySentDates.get(summaryKey) === today) continue;

      // Atomic acquire: SET NX evita race entre múltiplos containers no rolling deploy
      const acquired = await this.deps.redis.set(redisDedupeKey, '1', 'EX', 86400, 'NX').catch(() => null);
      if (!acquired) continue; // outro container já adquiriu ou já foi enviado hoje

      try {
        const prisma = await this.deps.tenantPrismaRegistry.getClient(tenantId);
        const config = await prisma.chatbotConfig.findUnique({
          where: { instanceId },
          select: { modules: true },
        });

        const sanitizedModules = sanitizeChatbotModules(config?.modules);
        const resumoDiarioModule = getResumoDiarioModuleConfig(sanitizedModules);
        const aprendizadoModule = getAprendizadoContinuoModuleConfig(sanitizedModules);

        // resumoDiario precisa estar ativo; se não configurado, usa comportamento legado (aprendizadoContinuo ativo)
        const summaryEnabled =
          resumoDiarioModule?.isEnabled === true ||
          (resumoDiarioModule == null && aprendizadoModule?.isEnabled === true);
        if (!summaryEnabled) continue;

        // Verifica se já passou da hora configurada (default: 8h UTC)
        const sendHour = resumoDiarioModule?.horaEnvioUtc ?? 8;
        if (new Date().getUTCHours() < sendHour) continue;

        const adminPhone =
          aprendizadoModule?.verifiedPhone ??
          aprendizadoModule?.configuredAdminPhone ??
          null;
        if (!adminPhone) continue;

        const instance = await prisma.instance.findUnique({
          where: { id: instanceId },
          select: { id: true },
        });
        if (!instance) continue;

        // Build summary: existing generateDailySummary (Conversation/ClientMemory data)
        // PLUS new session metrics section (MET-06)
        const [legacySummary, sessionMetricsSection] = await Promise.all([
          this.deps.adminCommandService.generateDailySummary(tenantId, instanceId),
          this.buildSessionMetricsSummary(tenantId, instanceId),
        ]);

        const fullSummary = sessionMetricsSection
          ? `${legacySummary}\n\n${sessionMetricsSection}`
          : legacySummary;

        await this.deps.sendMessage(
          tenantId,
          instanceId,
          adminPhone,
          `${adminPhone}@s.whatsapp.net`,
          fullSummary,
          { action: 'daily_summary', kind: 'chatbot' }
        );

        this.dailySummarySentDates.set(summaryKey, today);
      } catch (err) {
        this.logger.warn({ err, workerKey }, '[daily-summary] erro ao enviar resumo diario');
      }
    }
  }

  /**
   * Builds the session metrics section of the daily summary.
   * Returns null if no session data is available for today.
   * MET-06: session-level metrics (started, ended, inactive, transferred, avg duration, continuation rate MET-04)
   */
  async buildSessionMetricsSummary(tenantId: string, instanceId: string): Promise<string | null> {
    try {
      const prisma = await this.deps.tenantPrismaRegistry.getClient(tenantId);
      const startOfToday = new Date();
      startOfToday.setUTCHours(0, 0, 0, 0);

      // instanceId comes from workers Map (server-internal), passed as positional param — T-06-03-02 mitigation
      const rows = await prisma.$queryRawUnsafe<SessionMetricsRow[]>(
        `SELECT
           COUNT(*) AS "startedCount",
           COUNT(*) FILTER (WHERE "status" = 'ENCERRADA') AS "endedCount",
           COUNT(*) FILTER (WHERE "status" = 'INATIVA') AS "inactiveCount",
           COUNT(*) FILTER (WHERE "handoffCount" > 0) AS "transferredCount",
           COUNT(*) FILTER (WHERE "closedReason" = 'timeout_no_response') AS "timedOutCount",
           COUNT(*) FILTER (WHERE "closedReason" IS NOT NULL) AS "totalClosedCount",
           ROUND(AVG("durationSeconds")::numeric, 0)::INTEGER AS "avgDurationSeconds"
         FROM "ConversationSession"
         WHERE "instanceId" = $1
           AND "startedAt" >= $2`,
        instanceId,
        startOfToday
      );

      const r = rows[0];
      if (!r) return null;

      const started = parseInt(String(r.startedCount ?? 0), 10);
      if (started === 0) return null;

      const ended = parseInt(String(r.endedCount ?? 0), 10);
      const inactive = parseInt(String(r.inactiveCount ?? 0), 10);
      const transferred = parseInt(String(r.transferredCount ?? 0), 10);
      const timedOut = parseInt(String(r.timedOutCount ?? 0), 10);
      const totalClosed = parseInt(String(r.totalClosedCount ?? 0), 10);
      const avgDuration = r.avgDurationSeconds
        ? parseInt(String(r.avgDurationSeconds), 10)
        : null;

      // MET-04: continuation rate = 1 - (timed out / total closed)
      const continuationRateText =
        totalClosed > 0
          ? `${((1 - timedOut / totalClosed) * 100).toFixed(1)}%`
          : '—';

      const avgDurationText =
        avgDuration !== null
          ? avgDuration >= 60
            ? `${Math.floor(avgDuration / 60)}min ${avgDuration % 60}s`
            : `${avgDuration}s`
          : '—';

      return [
        '*Sessões de atendimento (hoje):*',
        `• Iniciadas: ${started}`,
        `• Encerradas: ${ended}`,
        `• Inativas (sem resposta): ${inactive}`,
        `• Transferidas para humano: ${transferred}`,
        `• Duração média: ${avgDurationText}`,
        `• Taxa de continuação: ${continuationRateText}`,
      ].join('\n');
    } catch (err) {
      this.logger.warn(
        { err, tenantId, instanceId },
        '[daily-summary] buildSessionMetricsSummary failed'
      );
      return null;
    }
  }
}
