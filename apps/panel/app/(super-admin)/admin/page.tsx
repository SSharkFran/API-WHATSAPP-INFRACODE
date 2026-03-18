import { Users, XCircle, AlertTriangle, Zap } from "lucide-react";
import { StatCard } from "../../../components/dashboard/stat-card";
import { getAdminBilling, getAdminTenants } from "../../../lib/api";
import { Badge } from "../../../components/ui/Badge";

export const dynamic = "force-dynamic";

const formatNumber = (value: number) => new Intl.NumberFormat("pt-BR").format(value);

export default async function SuperAdminOverviewPage() {
  const [tenants, billing] = await Promise.all([getAdminTenants(), getAdminBilling()]);
  const activeTenants = tenants.filter((t) => t.status === "ACTIVE");
  const suspendedTenants = tenants.filter((t) => t.status === "SUSPENDED");
  const overdueAccounts = billing.filter((b) => b.status === "PAST_DUE");
  const monthlyCapacity = tenants.reduce((sum, t) => sum + t.messagesPerMonth, 0);

  return (
    <div className="space-y-6">
      {/* Metrics */}
      <section className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        <StatCard label="Tenants ativos"    value={String(activeTenants.length)}    icon={Users} />
        <StatCard label="Suspensos"         value={String(suspendedTenants.length)} icon={XCircle} />
        <StatCard label="Past due"          value={String(overdueAccounts.length)}  icon={AlertTriangle} />
        <StatCard label="Capacidade/mês"   value={formatNumber(monthlyCapacity)}   icon={Zap} />
      </section>

      {/* Content grid */}
      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.95fr]">
        {/* Tenant consumption */}
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Tenants</p>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Consumo por cliente</h2>
          </div>
          <div className="p-4 space-y-2">
            {tenants.map((tenant) => {
              const usage = Math.round(
                (tenant.messagesThisMonth / Math.max(tenant.messagesPerMonth, 1)) * 100
              );
              return (
                <div
                  key={tenant.id}
                  className="px-4 py-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] hover:border-[var(--border-default)] transition-colors duration-150"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{tenant.name}</p>
                      <p className="text-xs text-[var(--text-tertiary)] font-mono truncate mt-0.5">{tenant.slug}</p>
                    </div>
                    <Badge
                      variant={tenant.status === "ACTIVE" ? "success" : tenant.status === "SUSPENDED" ? "error" : "neutral"}
                      pulse={tenant.status === "ACTIVE"}
                    >
                      {tenant.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)] mb-2">
                    <span>{formatNumber(tenant.messagesThisMonth)} / {formatNumber(tenant.messagesPerMonth)}</span>
                    <span className="font-mono">{usage}%</span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${Math.max(2, Math.min(100, usage))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right column */}
        <div className="grid gap-4">
          {/* Control plane */}
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Control plane</p>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Sinais globais</h2>
            </div>
            <div className="p-4 space-y-2">
              {[
                "Impersonation gera trilha de auditoria com ator e contexto.",
                "Nginx aplica rate limit por host e por host+IP.",
                "PgBouncer e cache LRU seguram conexões ao escalar tenants."
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

          {/* Billing radar */}
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Billing</p>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Radar financeiro</h2>
            </div>
            <div className="p-4 space-y-2">
              {billing.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-4 py-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]"
                >
                  <span className="text-sm text-[var(--text-primary)] truncate">{item.tenantName}</span>
                  <Badge
                    variant={
                      item.status === "PAID" ? "success" :
                      item.status === "PAST_DUE" ? "error" :
                      item.status === "PENDING" ? "warning" : "neutral"
                    }
                  >
                    {item.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
