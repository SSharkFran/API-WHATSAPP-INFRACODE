import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { StatCard } from "../../../components/dashboard/stat-card";
import { getAdminBilling, getAdminTenants } from "../../../lib/api";

const formatNumber = (value: number) => new Intl.NumberFormat("pt-BR").format(value);

export default async function SuperAdminOverviewPage() {
  const [tenants, billing] = await Promise.all([getAdminTenants(), getAdminBilling()]);
  const activeTenants = tenants.filter((tenant) => tenant.status === "ACTIVE");
  const suspendedTenants = tenants.filter((tenant) => tenant.status === "SUSPENDED");
  const overdueAccounts = billing.filter((item) => item.status === "PAST_DUE");
  const monthlyCapacity = tenants.reduce((total, tenant) => total + tenant.messagesPerMonth, 0);

  return (
    <div className="space-y-8">
      <section className="grid gap-5 lg:grid-cols-4">
        <StatCard hint="Clientes com operacao liberada." label="Tenants ativos" tone="dark" value={String(activeTenants.length)} />
        <StatCard hint="Contas temporariamente bloqueadas." label="Suspensos" tone="dark" value={String(suspendedTenants.length)} />
        <StatCard hint="Assinaturas precisando de acao financeira." label="Past due" tone="dark" value={String(overdueAccounts.length)} />
        <StatCard hint="Capacidade somada de envio por mes." label="Capacidade mensal" tone="dark" value={formatNumber(monthlyCapacity)} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.25fr_0.95fr]">
        <Card className="surface-card-dark text-white">
          <CardHeader className="border-b border-white/8">
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Tenants</CardDescription>
            <CardTitle className="text-2xl text-white">Consumo e headroom por cliente</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {tenants.map((tenant) => {
              const usage = Math.round((tenant.messagesThisMonth / Math.max(tenant.messagesPerMonth, 1)) * 100);

              return (
                <div className="list-row-dark rounded-[24px] p-4" key={tenant.id}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-lg font-semibold text-white">{tenant.name}</p>
                      <p className="mt-1 text-sm text-slate-400">{tenant.slug}</p>
                    </div>
                    <span className="status-pill bg-white/10 text-slate-200">{tenant.status}</span>
                  </div>

                  <div className="mt-4 flex items-center justify-between text-sm text-slate-300">
                    <span>{formatNumber(tenant.messagesThisMonth)} de {formatNumber(tenant.messagesPerMonth)} mensagens</span>
                    <span className="font-[var(--font-mono)]">{usage}% do plano</span>
                  </div>

                  <div className="progress-track mt-3">
                    <div className="progress-fill" style={{ width: `${Math.max(8, Math.min(100, usage))}%` }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <div className="grid gap-5">
          <Card className="surface-card">
            <CardHeader>
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Control plane</CardDescription>
              <CardTitle className="text-2xl text-slate-950">Sinais da camada global</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-7 text-slate-600">
              <div className="list-row-light rounded-[22px] p-4">
                Impersonation deve gerar trilha completa de auditoria com ator original e contexto do suporte.
              </div>
              <div className="list-row-light rounded-[22px] p-4">
                Nginx aplica rate limit por host e por host mais IP, reduzindo efeito de noisy neighbor.
              </div>
              <div className="list-row-light rounded-[22px] p-4">
                PgBouncer e cache LRU seguram o crescimento de conexoes ao escalar tenants simultaneos.
              </div>
            </CardContent>
          </Card>

          <Card className="surface-card-dark text-white">
            <CardHeader className="border-b border-white/8">
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Billing pulse</CardDescription>
              <CardTitle className="text-2xl text-white">Radar financeiro</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              {billing.map((item) => (
                <div className="flex items-center justify-between rounded-[20px] border border-white/8 bg-white/5 px-4 py-3" key={item.id}>
                  <span>{item.tenantName}</span>
                  <span className="font-[var(--font-mono)]">{item.status}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
