import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { StatCard } from "../../../components/dashboard/stat-card";
import { getInstances } from "../../../lib/api";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const instances = await getInstances();
  const activeInstances = instances.filter((instance) => instance.status === "CONNECTED");
  const messagesPerMinute = instances.reduce((total, instance) => total + Math.ceil(instance.usage.messagesSent / 60), 0);
  const errorCount = instances.reduce((total, instance) => total + instance.usage.errors, 0);

  return (
    <div className="space-y-8">
      <section className="mb-2 max-w-3xl space-y-2">
        <p className="control-kicker text-sky-700">Legacy dashboard</p>
        <h2 className="text-3xl font-semibold text-slate-950">Telemetria e distribuicao da operacao</h2>
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        <StatCard hint="Instancias conectadas com heartbeat valido." label="Ativas" value={String(activeInstances.length)} />
        <StatCard hint="Estimativa baseada no volume historico persistido." label="Msgs por min" value={String(messagesPerMinute)} />
        <StatCard hint="Soma de falhas de worker, fila e webhook." label="Erros" value={String(errorCount)} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card className="surface-card">
          <CardHeader>
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Volume recente</CardDescription>
            <CardTitle className="text-2xl text-slate-950">Distribuicao por instancia</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {instances.map((instance) => (
              <div className="list-row-light rounded-[22px] p-4" key={instance.id}>
                <div className="flex items-center justify-between text-sm text-slate-700">
                  <span className="font-semibold text-slate-950">{instance.name}</span>
                  <span className="font-[var(--font-mono)]">{instance.usage.messagesSent + instance.usage.messagesReceived}</span>
                </div>
                <div className="progress-track mt-3">
                  <div className="progress-fill" style={{ width: `${Math.max(8, Math.min(100, instance.usage.messagesSent / 25))}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="surface-card-dark text-white">
          <CardHeader className="border-b border-white/8">
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Alertas</CardDescription>
            <CardTitle className="text-2xl text-white">Fila de atencao</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-7 text-slate-300">
            <div className="list-row-dark rounded-[22px] p-4">Instancias com QR pendente exigem reacesso rapido no painel.</div>
            <div className="list-row-dark rounded-[22px] p-4">Webhooks com retry alto devem ser movidos para DLQ ou inspecionados no Grafana.</div>
            <div className="list-row-dark rounded-[22px] p-4">Scores de risco altos pedem reducao de taxa e mais jitter.</div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
