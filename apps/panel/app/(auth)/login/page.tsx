import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { InfraCodeMark } from "../../../components/branding/infracode-mark";
import { LoginForm } from "../../../components/auth/login-form";

export default function LoginPage() {
  return (
    <main className="theme-auth relative min-h-screen overflow-hidden px-4 py-6 sm:px-6 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(125,211,252,0.18),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.22),transparent_30%)]" />
      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] max-w-7xl flex-col">
        <header className="flex items-center justify-between gap-4 pb-8">
          <InfraCodeMark className="auth-brand-chip" subtitle="WhatsApp API Cloud" tone="super" />
          <div className="hidden rounded-full border border-white/10 bg-white/5 px-4 py-2 font-[var(--font-mono)] text-[11px] uppercase tracking-[0.28em] text-slate-300 backdrop-blur md:block">
            Multi-tenant hospedado pela InfraCode
          </div>
        </header>

        <div className="grid flex-1 items-center gap-8 lg:grid-cols-[1.12fr_0.88fr]">
          <section className="space-y-8">
            <div className="max-w-3xl space-y-6">
              <p className="font-[var(--font-mono)] text-xs uppercase tracking-[0.34em] text-sky-300">
                Plataforma SaaS para operacao real de WhatsApp
              </p>
              <h1 className="max-w-4xl text-5xl font-semibold leading-[0.98] text-white sm:text-6xl">
                Venda acesso em minutos. Mantenha isolamento forte, onboarding simples e operacao centralizada.
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-slate-300">
                Painel super admin, tenant panel, billing interno, QR Code por instancia, webhook e observabilidade em uma unica plataforma hospedada pela InfraCode.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {[
                ["Schema por tenant", "Isolamento fisico em PostgreSQL com cache LRU de Prisma e trilha de auditoria consistente."],
                ["Provisionamento rapido", "Criacao de cliente, convite inicial e limites de plano sem intervencao tecnica manual."],
                ["Operacao rastreavel", "Logs, billing, rate limit por tenant e saude global na mesma camada operacional."]
              ].map(([title, text], index) => (
                <Card className="auth-metric-card border-white/10 bg-white/5 text-white shadow-none" key={title}>
                  <CardHeader className="space-y-3 border-b border-white/10">
                    <span className="font-[var(--font-mono)] text-xs uppercase tracking-[0.24em] text-sky-300/90">
                      0{index + 1}
                    </span>
                    <CardTitle className="text-xl text-white">{title}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm leading-7 text-slate-300">{text}</CardContent>
                </Card>
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="auth-outline-panel rounded-[28px] p-6">
                <p className="font-[var(--font-mono)] text-xs uppercase tracking-[0.28em] text-slate-400">Stack operacional</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {["Fastify + Baileys", "PostgreSQL schema-per-tenant", "Redis + BullMQ", "Next.js + shadcn/ui"].map((item) => (
                    <div className="rounded-2xl border border-white/8 bg-slate-950/45 px-4 py-3 text-sm text-slate-200" key={item}>
                      {item}
                    </div>
                  ))}
                </div>
              </div>

              <div className="auth-outline-panel rounded-[28px] p-6">
                <p className="font-[var(--font-mono)] text-xs uppercase tracking-[0.28em] text-slate-400">Fluxo comercial</p>
                <div className="mt-4 space-y-4">
                  {[
                    "InfraCode cria o tenant e envia o convite inicial.",
                    "O cliente define a senha, conecta o QR e configura o webhook.",
                    "A operacao segue isolada por tenant, com controle central no super admin."
                  ].map((item) => (
                    <div className="flex gap-3 text-sm leading-7 text-slate-200" key={item}>
                      <span className="mt-2 h-2.5 w-2.5 rounded-full bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.6)]" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="relative">
            <div className="absolute inset-6 -z-10 rounded-[36px] bg-sky-400/10 blur-3xl" />
            <div className="auth-login-shell rounded-[36px] p-1">
              <div className="auth-login-panel rounded-[32px] p-6 sm:p-8">
                <div className="space-y-4">
                  <div className="inline-flex items-center rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 font-[var(--font-mono)] text-[11px] uppercase tracking-[0.28em] text-sky-200">
                    Acesso seguro
                  </div>
                  <div className="space-y-3">
                    <h2 className="text-3xl font-semibold text-white">Entrar na plataforma</h2>
                    <p className="text-sm leading-7 text-slate-300">
                      A autenticacao conversa diretamente com a API real, persiste a sessao do painel e redireciona para o contexto correto de InfraCode ou do tenant.
                    </p>
                  </div>
                </div>

                <div className="mt-6 rounded-[28px] border border-white/8 bg-slate-950/40 p-5 sm:p-6">
                  <div className="mb-5">
                    <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Acesso real</CardDescription>
                    <CardTitle className="mt-2 text-2xl text-white">Super admin ou cliente</CardTitle>
                  </div>
                  <LoginForm />
                </div>

                <p className="mt-5 text-sm leading-7 text-slate-400">
                  Recebeu um convite? Abra o link enviado pela InfraCode ou use o fluxo de{" "}
                  <Link className="text-sky-300 underline underline-offset-4 transition hover:text-sky-200" href="/primeiro-acesso">
                    primeiro acesso
                  </Link>
                  .
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
