import { InfraCodeMark } from "../../../components/branding/infracode-mark";
import { PanelNav } from "../../../components/navigation/panel-nav";

export const dynamic = "force-dynamic";

const navigation = [
  { href: "/admin", label: "Overview", meta: "Saude global, consumo e sinais da plataforma." },
  { href: "/admin/tenants", label: "Tenants", meta: "Clientes, limites, status e contexto operacional." },
  { href: "/admin/billing", label: "Billing", meta: "Ciclos, vencimentos e risco financeiro por conta." },
  { href: "/admin/settings", label: "Settings", meta: "Guardrails globais, manutencao e defaults." }
];

export default function SuperAdminLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <main className="theme-super min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-[1700px] gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="control-sidebar control-sidebar--super text-white">
          <InfraCodeMark className="auth-brand-chip" subtitle="InfraCode control plane" tone="super" />

          <div className="mt-8 space-y-4">
            <p className="control-kicker text-sky-300">Super admin</p>
            <h1 className="text-4xl font-semibold leading-tight text-white">A plataforma inteira sob uma unica camada de controle.</h1>
            <p className="text-sm leading-7 text-slate-300">
              Operacao global da InfraCode com separacao clara entre clientes, billing, limites, observabilidade e suporte por impersonation.
            </p>
          </div>

          <div className="mt-8">
            <PanelNav items={navigation} tone="super" />
          </div>

          <div className="mt-8 grid gap-3">
            <div className="rounded-[26px] border border-white/8 bg-white/5 p-4">
              <p className="control-kicker text-slate-400">Controlos ativos</p>
              <p className="mt-3 text-lg font-semibold">Rate limit por tenant e por IP interno</p>
            </div>
            <div className="rounded-[26px] border border-white/8 bg-white/5 p-4">
              <p className="control-kicker text-slate-400">Infra</p>
              <p className="mt-3 text-lg font-semibold">PgBouncer, Redis, Prometheus e Grafana integrados</p>
            </div>
          </div>
        </aside>

        <section className="control-main control-main--super min-h-[calc(100vh-3rem)]">
          <div className="relative z-10">
            <header className="mb-8 flex flex-col gap-6 border-b border-white/8 pb-6 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-4xl space-y-3">
                <p className="control-kicker text-slate-400">InfraCode hosted SaaS</p>
                <h2 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">Visao global de clientes, receita e saude operacional.</h2>
                <p className="text-sm leading-7 text-slate-300">
                  Cada tenant opera isolado, enquanto a InfraCode enxerga consumo, risco, billing e suporte em um control plane visualmente distinto.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <span className="rounded-full border border-white/8 bg-white/5 px-4 py-2 text-sm text-slate-300">JWT + API Key tenant-scoped</span>
                <span className="rounded-full border border-sky-300/18 bg-sky-400/10 px-4 py-2 text-sm text-sky-100">Schema per tenant</span>
              </div>
            </header>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}
