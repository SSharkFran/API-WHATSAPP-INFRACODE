import { InfraCodeMark } from "../../components/branding/infracode-mark";
import { PanelNav } from "../../components/navigation/panel-nav";

export const dynamic = "force-dynamic";

const navigation = [
  { href: "/dashboard", label: "Dashboard", meta: "Visao operacional do modo legado." },
  { href: "/instances", label: "Instancias", meta: "Grid legado de operacao multi-instancia." }
];

export default function DashboardLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <main className="theme-tenant min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-[1700px] gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="control-sidebar control-sidebar--tenant">
          <InfraCodeMark subtitle="Ops legado" />
          <div className="mt-8 space-y-4">
            <p className="control-kicker text-sky-700">Compatibilidade</p>
            <h1 className="text-4xl font-semibold leading-tight text-slate-950">Operacao multi-instancia ainda acessivel nas rotas antigas.</h1>
            <p className="text-sm leading-7 text-slate-600">Essas telas seguem no projeto para transicao gradual, mas agora no mesmo sistema visual do tenant.</p>
          </div>
          <div className="mt-8">
            <PanelNav items={navigation} tone="tenant" />
          </div>
        </aside>

        <section className="control-main control-main--tenant min-h-[calc(100vh-3rem)]">
          <div className="relative z-10">{children}</div>
        </section>
      </div>
    </main>
  );
}
