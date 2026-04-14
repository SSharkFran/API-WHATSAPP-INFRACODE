import { ShieldOff, AlertTriangle } from "lucide-react";
import { StatCard } from "../../../../components/dashboard/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { getAdminBilling, ForbiddenError } from "../../../../lib/api";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { isRedirectError } from "next/dist/client/components/redirect";

export const dynamic = "force-dynamic";

export default async function SuperAdminBillingPage() {
  let items: Awaited<ReturnType<typeof getAdminBilling>>;

  try {
    items = await getAdminBilling();
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    if (error instanceof ForbiddenError) {
      return (
        <div role="alert" aria-live="assertive">
          <EmptyState
            icon={ShieldOff}
            label="Acesso negado. Esta área requer permissão de Platform Owner."
          />
        </div>
      );
    }
    return (
      <div role="alert" aria-live="assertive">
        <EmptyState
          icon={AlertTriangle}
          label="Não foi possível carregar os dados. Tente recarregar a página."
        />
      </div>
    );
  }

  const active = items.filter((item) => item.status === "ACTIVE");
  const overdue = items.filter((item) => item.status === "PAST_DUE");

  if (items.length === 0) {
    return (
      <section className="space-y-6">
        <div className="max-w-3xl space-y-2">
          <p className="control-kicker text-slate-400">Billing</p>
          <h2 className="text-3xl font-semibold text-white">Faturamento, vencimentos e risco financeiro</h2>
        </div>
        <EmptyState
          icon={AlertTriangle}
          label="Nenhum registro de cobrança encontrado."
        />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="max-w-3xl space-y-2">
        <p className="control-kicker text-slate-400">Billing</p>
        <h2 className="text-3xl font-semibold text-white">Faturamento, vencimentos e risco financeiro</h2>
        <p className="text-sm leading-7 text-slate-300">Acompanhamento operacional de assinaturas, ciclos e estados de bloqueio.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <StatCard hint="Assinaturas com operacao liberada." label="Ativas" tone="dark" value={String(active.length)} />
        <StatCard hint="Assinaturas com acao financeira urgente." label="Past due" tone="dark" value={String(overdue.length)} />
        <StatCard hint="Total sob gestao no billing interno." label="Total monitorado" tone="dark" value={String(items.length)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {items.map((item) => (
          <Card className="surface-card" key={item.id}>
            <CardHeader className="border-b border-white/8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">{item.planName}</CardDescription>
                  <CardTitle className="mt-2 text-2xl text-white">{item.tenantName}</CardTitle>
                </div>
                <span className="status-pill bg-slate-800 text-slate-100">{item.status}</span>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm leading-7 text-slate-300 md:grid-cols-2">
              <div className="list-row-light rounded-[22px] p-4">
                <p className="control-kicker text-slate-400">Ciclo</p>
                <p className="mt-3 text-white">{new Date(item.currentPeriodStart).toLocaleDateString("pt-BR")}</p>
                <p className="mt-1">Ate {item.currentPeriodEnd ? new Date(item.currentPeriodEnd).toLocaleDateString("pt-BR") : "aberto"}</p>
              </div>
              <div className="list-row-light rounded-[22px] p-4">
                <p className="control-kicker text-slate-400">Vencimento</p>
                <p className="mt-3 text-white">
                  {item.nextDueAt ? new Date(item.nextDueAt).toLocaleDateString("pt-BR") : "nao informado"}
                </p>
                <p className="mt-1">Suspenso em {item.suspendedAt ? new Date(item.suspendedAt).toLocaleDateString("pt-BR") : "n/a"}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
