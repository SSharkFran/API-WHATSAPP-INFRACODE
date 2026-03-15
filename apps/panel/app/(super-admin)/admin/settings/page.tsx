import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";

export default function SuperAdminSettingsPage() {
  return (
    <section className="space-y-6">
      <div className="max-w-3xl space-y-2">
        <p className="control-kicker text-slate-400">Settings</p>
        <h2 className="text-3xl font-semibold text-white">Guardrails globais do SaaS</h2>
        <p className="text-sm leading-7 text-slate-300">Defaults operacionais que afetam toda a plataforma hospedada da InfraCode.</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        {[
          ["Rate limit", "Ativo", "Limite global do Fastify complementado pelo Nginx por host e IP."],
          ["Blacklist global", "Sincronizada", "Lista central para bloqueios operacionais e compliance."],
          ["Modo manutencao", "Pronto", "Resposta unica da InfraCode para indisponibilidade planejada."]
        ].map(([title, status, text]) => (
          <Card className="surface-card-dark text-white" key={title}>
            <CardHeader className="border-b border-white/8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Configuracao global</CardDescription>
                  <CardTitle className="mt-2 text-xl text-white">{title}</CardTitle>
                </div>
                <span className="status-pill bg-sky-400/12 text-sky-100">{status}</span>
              </div>
            </CardHeader>
            <CardContent className="text-sm leading-7 text-slate-300">{text}</CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
