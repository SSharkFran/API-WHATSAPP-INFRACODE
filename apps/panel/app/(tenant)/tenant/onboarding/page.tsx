import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { getTenantOnboarding } from "../../../../lib/api";

export default async function TenantOnboardingPage() {
  const onboarding = await getTenantOnboarding();

  return (
    <section className="space-y-6">
      <div className="max-w-3xl space-y-2">
        <p className="control-kicker text-sky-700">Onboarding</p>
        <h2 className="text-3xl font-semibold text-slate-950">Primeira instancia, QR e webhook</h2>
        <p className="text-sm leading-7 text-slate-600">Fluxo guiado para colocar o tenant em producao sem precisar de suporte tecnico.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.12fr_0.88fr]">
        <Card className="surface-card">
          <CardHeader>
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Checklist</CardDescription>
            <CardTitle className="text-2xl text-slate-950">Estado atual do tenant</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {onboarding.steps.map((step, index) => (
              <div className="list-row-light rounded-[24px] p-4" key={step.code}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex gap-4">
                    <div className={`mt-1 flex h-10 w-10 items-center justify-center rounded-2xl ${step.completed ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                      {index + 1}
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-slate-950">{step.label}</p>
                      <p className="mt-1 font-[var(--font-mono)] text-[11px] uppercase tracking-[0.24em] text-slate-500">{step.code}</p>
                    </div>
                  </div>
                  <span className={`status-pill ${step.completed ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"}`}>
                    {step.completed ? "Concluido" : "Pendente"}
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="grid gap-5">
          <Card className="surface-card-dark text-white">
            <CardHeader className="border-b border-white/8">
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Proximo passo</CardDescription>
              <CardTitle className="text-2xl text-white">{onboarding.currentStep}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-7 text-slate-300">
              <div className="list-row-dark rounded-[22px] p-4">1. Criar a primeira instancia do tenant.</div>
              <div className="list-row-dark rounded-[22px] p-4">2. Abrir o modal de QR com countdown de 60 segundos.</div>
              <div className="list-row-dark rounded-[22px] p-4">3. Configurar o webhook para fechar o onboarding.</div>
            </CardContent>
          </Card>

          <Card className="surface-card">
            <CardHeader>
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Docs inline</CardDescription>
              <CardTitle className="text-2xl text-slate-950">O que valida a conclusao</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-600">
              <div className="list-row-light rounded-[22px] p-4">Senha definida com sucesso e sessao ativa do painel.</div>
              <div className="list-row-light rounded-[22px] p-4">Instancia criada e conectada com QR confirmado.</div>
              <div className="list-row-light rounded-[22px] p-4">Webhook salvo e pronto para trafego real.</div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
