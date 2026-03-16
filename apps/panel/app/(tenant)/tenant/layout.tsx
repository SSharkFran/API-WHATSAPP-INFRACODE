import { InfraCodeMark } from "../../../components/branding/infracode-mark";
import { PanelNav } from "../../../components/navigation/panel-nav";

export const dynamic = "force-dynamic";

const navigation = [
  { href: "/tenant", label: "Dashboard", meta: "Visao geral de consumo, fila e capacidade." },
  { href: "/tenant/instances", label: "Instancias", meta: "Fleet, QR Code, uptime, risco e acoes operacionais." },
  { href: "/tenant/onboarding", label: "Onboarding", meta: "Senha, primeira instancia, QR e webhook." },
  { href: "/tenant/chatbot", label: "Chatbot", meta: "Regras por instancia, simulacao e respostas automaticas." },
  { href: "/tenant/api-keys", label: "API Keys", meta: "Integracoes, tokens e contexto do runtime." }
];

export default function TenantLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <main className="theme-tenant min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-[1700px] gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="control-sidebar control-sidebar--tenant">
          <InfraCodeMark subtitle="Tenant panel" tone="tenant" />

          <div className="mt-8 space-y-4">
            <p className="control-kicker text-sky-700">Cliente InfraCode</p>
            <h1 className="text-4xl font-semibold leading-tight text-slate-950">Sua operacao de WhatsApp com QR, webhook e observabilidade.</h1>
            <p className="text-sm leading-7 text-slate-600">
              Painel do cliente com um fluxo direto para colocar a primeira instancia no ar e manter a operacao rastreavel.
            </p>
          </div>

          <div className="mt-8">
            <PanelNav items={navigation} tone="tenant" />
          </div>

          <div className="mt-8 grid gap-3">
            <div className="rounded-[26px] border border-slate-200/90 bg-white/76 p-4">
              <p className="control-kicker text-slate-500">Boas praticas</p>
              <p className="mt-3 text-lg font-semibold text-slate-950">Use jitter, webhook ativo e monitoramento de QR pendente</p>
            </div>
            <div className="rounded-[26px] border border-slate-200/90 bg-white/76 p-4">
              <p className="control-kicker text-slate-500">Acesso</p>
              <p className="mt-3 text-lg font-semibold text-slate-950">JWT do painel e API Keys com contexto do tenant</p>
            </div>
          </div>
        </aside>

        <section className="control-main control-main--tenant min-h-[calc(100vh-3rem)]">
          <div className="relative z-10">
            <header className="mb-8 flex flex-col gap-6 border-b border-slate-200/80 pb-6 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-4xl space-y-3">
                <p className="control-kicker text-sky-700">Tenant workspace</p>
                <h2 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">Operacao diaria com menos atrito e mais contexto tecnico.</h2>
                <p className="text-sm leading-7 text-slate-600">
                  Cada tela foi redesenhada para destacar capacidade, risco, onboarding e acoes mais frequentes sem parecer um painel generico.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <span className="rounded-full border border-slate-200 bg-white/80 px-4 py-2 text-sm text-slate-600">QR em tempo real</span>
                <span className="rounded-full border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-800">Webhook por instancia</span>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">Chatbot nativo</span>
              </div>
            </header>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}
