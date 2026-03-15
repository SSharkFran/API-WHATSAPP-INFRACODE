import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { StatCard } from "../../../components/dashboard/stat-card";
import { getTenantDashboard, getTenantInstances } from "../../../lib/api";

const formatNumber = (value: number) => new Intl.NumberFormat("pt-BR").format(value);

export default async function TenantDashboardPage() {
  const [dashboard, instances] = await Promise.all([getTenantDashboard(), getTenantInstances()]);

  return (
    <div className="space-y-8">
      <section className="grid gap-5 lg:grid-cols-4">
        <StatCard hint="Fleet operacional no tenant." label="Instancias conectadas" value={String(dashboard.connectedInstances)} />
        <StatCard hint="Mensagens aguardando envio." label="Fila" value={String(dashboard.queuedMessages)} />
        <StatCard hint="RBAC interno usado no tenant." label="Usuarios" value={`${dashboard.usersUsed}/${dashboard.usersLimit}`} />
        <StatCard hint="Consumo atual do plano contratado." label="Mensagens no mes" value={`${formatNumber(dashboard.messagesThisMonth)}/${formatNumber(dashboard.messagesPerMonth)}`} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.3fr_0.95fr]">
        <Card className="surface-card">
          <CardHeader>
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Instancias</CardDescription>
            <CardTitle className="text-2xl text-slate-950">Mapa rapido da operacao</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {instances.map((instance) => (
              <div className="list-row-light rounded-[24px] p-4" key={instance.id}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-lg font-semibold text-slate-950">{instance.name}</p>
                    <p className="mt-1 text-sm text-slate-500">{instance.phoneNumber ?? "Aguardando numero"}</p>
                  </div>
                  <span className="status-pill bg-slate-950 text-white">{instance.status}</span>
                </div>
                <div className="mt-4 grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
                  <div>
                    <p className="control-kicker text-slate-400">Enviadas</p>
                    <p className="mt-2 text-lg font-semibold text-slate-950">{formatNumber(instance.usage.messagesSent)}</p>
                  </div>
                  <div>
                    <p className="control-kicker text-slate-400">Recebidas</p>
                    <p className="mt-2 text-lg font-semibold text-slate-950">{formatNumber(instance.usage.messagesReceived)}</p>
                  </div>
                  <div>
                    <p className="control-kicker text-slate-400">Risco</p>
                    <p className="mt-2 text-lg font-semibold text-slate-950">{instance.usage.riskScore}</p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="surface-card-dark text-white">
          <CardHeader className="border-b border-white/8">
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Recomendacoes</CardDescription>
            <CardTitle className="text-2xl text-white">Anti-ban e operacao</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-7 text-slate-300">
            <div className="list-row-dark rounded-[22px] p-4">Evite bursts longos com o mesmo template em sequencia curta.</div>
            <div className="list-row-dark rounded-[22px] p-4">Distribua campanhas com jitter e acompanhe QR pendente em tempo real.</div>
            <div className="list-row-dark rounded-[22px] p-4">Use webhook ativo para fechar onboarding e monitorar retries.</div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
