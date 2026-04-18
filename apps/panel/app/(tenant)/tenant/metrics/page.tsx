import { BarChart2, Clock, Users2, AlertTriangle, TrendingUp, PhoneForwarded } from "lucide-react";
import { StatCard } from "../../../../components/dashboard/stat-card";
import { getTenantTodayMetrics, getTenantActiveQueue } from "../../../../lib/api";

export const dynamic = "force-dynamic";

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}min ${s}s` : `${s}s`;
}

function UrgencyBadge({ score }: { score: number }) {
  if (score >= 80) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Alta
      </span>
    );
  }
  if (score >= 40) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
        Média
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border border-[var(--border-subtle)]">
      Normal
    </span>
  );
}

export default async function TenantMetricsPage() {
  const [metrics, queue] = await Promise.all([getTenantTodayMetrics(), getTenantActiveQueue()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Métricas de Atendimento</h1>
        <p className="text-sm text-[var(--text-tertiary)] mt-0.5">Dados do dia corrente (UTC)</p>
      </div>

      {/* Today's session counts */}
      <section className="grid gap-4 grid-cols-2 xl:grid-cols-3">
        <StatCard label="Iniciados hoje" value={String(metrics.startedCount)} icon={BarChart2} />
        <StatCard label="Encerrados hoje" value={String(metrics.endedCount)} icon={TrendingUp} />
        <StatCard label="Inativos hoje" value={String(metrics.inactiveCount)} icon={Clock} />
        <StatCard label="Transferidos" value={String(metrics.handoffCount)} icon={PhoneForwarded} />
        <StatCard label="Duração média" value={formatDuration(metrics.avgDurationSeconds)} icon={Clock} />
        <StatCard label="1ª resposta média" value={formatMs(metrics.avgFirstResponseMs)} icon={Clock} />
      </section>

      {/* Continuation rate */}
      <section className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Taxa de continuação</p>
        <p className="text-2xl font-semibold text-[var(--text-primary)]">
          {metrics.continuationRate !== null ? `${metrics.continuationRate}%` : "—"}
        </p>
        <p className="text-xs text-[var(--text-tertiary)] mt-1">
          Sessões em que o cliente respondeu após a mensagem de inatividade
        </p>
      </section>

      {/* Active queue */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)]">Atendimentos ativos</p>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Fila de atendimento ({queue.length})
            </h2>
          </div>
        </div>

        {queue.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-8 text-center">
            <Users2 className="h-8 w-8 mx-auto text-[var(--text-tertiary)] mb-2" aria-hidden="true" />
            <p className="text-sm text-[var(--text-tertiary)]">Nenhum atendimento ativo no momento</p>
          </div>
        ) : (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-tertiary)]">Contato</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-tertiary)]">Duração</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-tertiary)]">Urgência</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-secondary)] truncate max-w-[200px]">
                      {entry.remoteJid.replace(/@s\.whatsapp\.net$/, "")}
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-secondary)]">
                      {formatDuration(entry.elapsedSeconds)}
                    </td>
                    <td className="px-4 py-3">
                      <UrgencyBadge score={entry.urgencyScore} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
