import type pino from 'pino';

export interface StatusSnapshot {
  instanceStatus: 'connected' | 'disconnected' | 'unknown';
  activeSessionCount: number;
  todayMessageCount: number;
  lastSummaryAt: Date | null;
  generatedAt: Date;
}

export interface StatusQueryDeps {
  logger: pino.Logger;
  getInstanceStatus: (instanceId: string) => 'connected' | 'disconnected' | 'unknown';
  getActiveSessionCount: (tenantId: string, instanceId: string) => Promise<number>;
  getTodayMessageCount: (tenantId: string, instanceId: string) => Promise<number>;
  getLastSummaryAt: (tenantId: string, instanceId: string) => Promise<Date | null>;
}

export class StatusQueryService {
  constructor(private readonly deps: StatusQueryDeps) {}

  async getSnapshot(tenantId: string, instanceId: string): Promise<StatusSnapshot> {
    const [instanceStatus, activeSessionCount, todayMessageCount, lastSummaryAt] =
      await Promise.all([
        Promise.resolve(this.deps.getInstanceStatus(instanceId)),
        this.deps.getActiveSessionCount(tenantId, instanceId).catch((err) => {
          this.deps.logger.warn({ err }, '[StatusQueryService] getActiveSessionCount failed');
          return 0;
        }),
        this.deps.getTodayMessageCount(tenantId, instanceId).catch((err) => {
          this.deps.logger.warn({ err }, '[StatusQueryService] getTodayMessageCount failed');
          return 0;
        }),
        this.deps.getLastSummaryAt(tenantId, instanceId).catch(() => null),
      ]);

    return {
      instanceStatus,
      activeSessionCount,
      todayMessageCount,
      lastSummaryAt,
      generatedAt: new Date(),
    };
  }

  formatStatusMessage(snapshot: StatusSnapshot): string {
    const statusEmoji = snapshot.instanceStatus === 'connected' ? '🟢' : '🔴';
    const statusLabel =
      snapshot.instanceStatus === 'connected'
        ? 'Conectado'
        : snapshot.instanceStatus === 'disconnected'
          ? 'Desconectado'
          : 'Desconhecido';
    const lastSummary = snapshot.lastSummaryAt
      ? snapshot.lastSummaryAt.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'Nenhum';

    return [
      `*Status do Sistema*`,
      `${statusEmoji} Instância: ${statusLabel}`,
      `💬 Atendimentos ativos: ${snapshot.activeSessionCount}`,
      `📊 Mensagens hoje: ${snapshot.todayMessageCount}`,
      `📋 Último resumo: ${lastSummary}`,
      `_Atualizado: ${snapshot.generatedAt.toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' })}_`,
    ].join('\n');
  }

  formatResumoMessage(snapshot: StatusSnapshot): string {
    const today = new Date().toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const statusLabel = snapshot.instanceStatus === 'connected' ? 'Online' : 'Offline';

    return [
      `*Resumo do Dia — ${today}*`,
      ``,
      `📱 Status da instância: ${statusLabel}`,
      `💬 Atendimentos ativos agora: ${snapshot.activeSessionCount}`,
      `📨 Total de mensagens hoje: ${snapshot.todayMessageCount}`,
      ``,
      `_Gerado às ${snapshot.generatedAt.toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' })}_`,
    ].join('\n');
  }
}
