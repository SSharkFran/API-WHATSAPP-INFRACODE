import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { getAdminTenants } from "../../../../lib/api";

const formatNumber = (value: number) => new Intl.NumberFormat("pt-BR").format(value);

export default async function SuperAdminTenantsPage() {
  const tenants = await getAdminTenants();

  return (
    <section className="space-y-6">
      <div className="max-w-3xl space-y-2">
        <p className="control-kicker text-slate-400">Tenants</p>
        <h2 className="text-3xl font-semibold text-white">Cadastro, capacidade e saude por cliente</h2>
        <p className="text-sm leading-7 text-slate-300">Cada card resume plano, consumo, billing e contexto operacional do tenant.</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {tenants.map((tenant) => {
          const usage = Math.round((tenant.messagesThisMonth / Math.max(tenant.messagesPerMonth, 1)) * 100);

          return (
            <Card className="surface-card-dark text-white" key={tenant.id}>
              <CardHeader className="border-b border-white/8">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-2xl text-white">{tenant.name}</CardTitle>
                    <CardDescription className="mt-2 font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">
                      {tenant.slug}
                    </CardDescription>
                  </div>
                  <span className="status-pill bg-white/10 text-slate-200">{tenant.status}</span>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="list-row-dark rounded-[22px] p-4">
                    <p className="control-kicker text-slate-400">Plano</p>
                    <p className="mt-3 text-lg font-semibold text-white">{tenant.plan?.name ?? "Sem plano"}</p>
                    <p className="mt-2 text-sm text-slate-300">{formatNumber(tenant.messagesPerMonth)} mensagens por mes</p>
                  </div>
                  <div className="list-row-dark rounded-[22px] p-4">
                    <p className="control-kicker text-slate-400">Operacao</p>
                    <p className="mt-3 text-lg font-semibold text-white">{tenant.activeInstances} instancias ativas</p>
                    <p className="mt-2 text-sm text-slate-300">Billing: {tenant.billingEmail ?? "nao informado"}</p>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-sm text-slate-300">
                    <span>{formatNumber(tenant.messagesThisMonth)} usadas no mes</span>
                    <span className="font-[var(--font-mono)]">{usage}% do plano</span>
                  </div>
                  <div className="progress-track mt-3">
                    <div className="progress-fill" style={{ width: `${Math.max(8, Math.min(100, usage))}%` }} />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
