import { Server, MessageSquare, Users, Zap, Send, Bell, BookOpen, CheckCircle } from "lucide-react";
import { StatCard } from "../../../components/dashboard/stat-card";
import { getTenantDashboard, getTenantInstances } from "../../../lib/api";
import { Badge } from "../../../components/ui/Badge";

export const dynamic = "force-dynamic";

const formatNumber = (value: number) => new Intl.NumberFormat("pt-BR").format(value);

export default async function TenantDashboardPage() {
  const [dashboard, instances] = await Promise.all([getTenantDashboard(), getTenantInstances()]);

  return (
    <div className="space-y-6">
      {/* Metric cards */}
      <section className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Instâncias"
          value={String(dashboard.connectedInstances)}
          icon={Server}
        />
        <StatCard
          label="Fila"
          value={String(dashboard.queuedMessages)}
          icon={Zap}
        />
        <StatCard
          label="Usuários"
          value={`${dashboard.usersUsed}/${dashboard.usersLimit}`}
          icon={Users}
        />
        <StatCard
          label="Mensagens/mês"
          value={`${formatNumber(dashboard.messagesThisMonth)}/${formatNumber(dashboard.messagesPerMonth)}`}
          icon={MessageSquare}
        />
      </section>

      {/* Analytics cards */}
      <section className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Mensagens enviadas hoje"
          value={String(dashboard.messagesTodayOutbound)}
          icon={Send}
        />
        <StatCard
          label="Escalações ativas hoje"
          value={String(dashboard.escalationsToday)}
          icon={Bell}
        />
        <StatCard
          label="Conhecimentos aprendidos hoje"
          value={String(dashboard.knowledgeLearnedToday)}
          icon={BookOpen}
        />
        <StatCard
          label="Taxa de resolução (7d)"
          value={`${dashboard.resolutionRateLast7Days}%`}
          icon={CheckCircle}
        />
      </section>

      {/* Instance map */}
      <section className="grid gap-4 xl:grid-cols-[1.3fr_0.95fr]">
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Instâncias</p>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Mapa da operação</h2>
          </div>
          <div className="p-4 space-y-2">
            {instances.map((instance) => (
              <div
                key={instance.id}
                className="flex items-start justify-between gap-4 px-4 py-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] hover:border-[var(--border-default)] transition-colors duration-150"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{instance.name}</p>
                  <p className="text-xs text-[var(--text-tertiary)] truncate mt-0.5 font-mono">
                    {instance.phoneNumber ?? "Aguardando número"}
                  </p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-[var(--text-tertiary)]">
                    <span>Enviadas: <span className="text-[var(--text-secondary)]">{formatNumber(instance.usage.messagesSent)}</span></span>
                    <span>Recebidas: <span className="text-[var(--text-secondary)]">{formatNumber(instance.usage.messagesReceived)}</span></span>
                    <span>Risco: <span className="text-[var(--text-secondary)]">{instance.usage.riskScore}</span></span>
                  </div>
                </div>
                <Badge
                  variant={instance.status === "CONNECTED" ? "success" : instance.status === "QR_PENDING" ? "warning" : "neutral"}
                  pulse={instance.status === "CONNECTED"}
                >
                  {instance.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        {/* Quick panel */}
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Operação</p>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Anti-ban</h2>
          </div>
          <div className="p-4 space-y-2">
            {[
              "Evite bursts longos com o mesmo template em sequência curta.",
              "Distribua campanhas com jitter e acompanhe QR pendente em tempo real.",
              "Use webhook ativo para fechar onboarding e monitorar retries."
            ].map((tip, i) => (
              <div
                key={i}
                className="px-4 py-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)] leading-relaxed"
              >
                {tip}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
