import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { InfraCodeMark } from "../../../components/branding/infracode-mark";
import { LoginForm } from "../../../components/auth/login-form";

export default function LoginPage() {
  return (
    <main className="theme-auth relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(125,211,252,0.14),transparent_35%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.12),transparent_35%)]" />
      
      <div className="relative mx-auto max-w-[1280px] px-6 py-20">
        <header className="mb-20 flex items-center justify-between gap-4">
          <InfraCodeMark className="auth-brand-chip" subtitle="WhatsApp API Cloud" tone="super" />
          <div className="hidden rounded-full border border-white/8 bg-white/5 px-5 py-2.5 font-[var(--font-mono)] text-[11px] uppercase tracking-[0.28em] text-slate-300 backdrop-blur md:block">
            Multi-tenant hospedado pela InfraCode
          </div>
        </header>

        <div className="grid grid-cols-1 gap-16 lg:grid-cols-12 lg:items-center">
          <section className="space-y-12 lg:col-span-7">
            <div className="space-y-6">
              <p className="font-[var(--font-mono)] text-xs uppercase tracking-[0.34em] text-sky-300">
                Plataforma SaaS para operação real de WhatsApp
              </p>
              <h1 className="text-hero text-white">
                Venda acesso em minutos. Mantenha isolamento forte, onboarding simples e operação centralizada.
              </h1>
              <p className="text-subtitle text-slate-300">
                Painel super admin, tenant panel, billing interno, QR Code por instância, webhook e observabilidade em uma única plataforma hospedada pela InfraCode.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
              {[
                ["Schema por tenant", "Isolamento físico em PostgreSQL com cache LRU de Prisma e trilha de auditoria consistente."],
                ["Provisionamento rápido", "Criação de cliente, convite inicial e limites de plano sem intervenção técnica manual."],
                ["Operação rastreável", "Logs, billing, rate limit por tenant e saúde global na mesma camada operacional."]
              ].map(([title, text], index) => (
                <Card className="feature-card-hover min-h-[280px] border-white/8 bg-white/5 p-8 text-white shadow-none transition-all duration-300" key={title}>
                  <div className="flex h-full flex-col justify-between space-y-6">
                    <div>
                      <span className="font-[var(--font-mono)] text-sm font-bold uppercase tracking-[0.24em] text-sky-300/90">
                        0{index + 1}
                      </span>
                      <h3 className="mt-4 text-[20px] font-bold text-white">{title}</h3>
                    </div>
                    <p className="text-sm leading-[1.6] text-slate-300 opacity-75">{text}</p>
                  </div>
                </Card>
              ))}
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div className="auth-outline-panel rounded-[28px] p-8">
                <p className="font-[var(--font-mono)] text-[10px] uppercase tracking-[0.28em] text-slate-400">Stack operacional</p>
                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  {["Fastify + Baileys", "PostgreSQL schema-per-tenant", "Redis + BullMQ", "Next.js + shadcn/ui"].map((item) => (
                    <div className="rounded-2xl border border-white/5 bg-slate-950/45 px-4 py-3 text-[13px] text-slate-200" key={item}>
                      {item}
                    </div>
                  ))}
                </div>
              </div>

              <div className="auth-outline-panel rounded-[28px] p-8">
                <p className="font-[var(--font-mono)] text-[10px] uppercase tracking-[0.28em] text-slate-400">Fluxo comercial</p>
                <div className="mt-6 space-y-4">
                  {[
                    "InfraCode cria o tenant e envia o convite inicial.",
                    "O cliente define a senha, conecta o QR e configura o webhook.",
                    "A operação segue isolada por tenant, com controle central no super admin."
                  ].map((item) => (
                    <div className="flex gap-3 text-[13px] leading-relaxed text-slate-200" key={item}>
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.6)]" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="relative lg:col-span-5">
            <div className="form-glow absolute inset-4 -z-10 rounded-[40px] opacity-60" />
            <div className="auth-login-shell rounded-[40px] p-1">
              <div className="auth-login-panel rounded-[38px] p-12">
                <div className="space-y-5">
                  <div className="inline-flex items-center rounded-full border border-sky-300/10 bg-sky-400/5 px-4 py-1.5 font-[var(--font-mono)] text-[10px] uppercase tracking-[0.28em] text-sky-200">
                    Acesso seguro
                  </div>
                  <div className="space-y-4">
                    <h2 className="text-4xl font-bold text-white tracking-tight">Entrar na plataforma</h2>
                    <p className="text-sm leading-relaxed text-slate-400 opacity-80">
                      A autenticação conversa diretamente com a API real, persiste a sessão do painel e redireciona para o contexto correto.
                    </p>
                  </div>
                </div>

                <div className="mt-10 rounded-[32px] border border-white/5 bg-slate-950/40 p-1">
                  <div className="p-7">
                    <div className="mb-6">
                      <p className="font-[var(--font-mono)] text-[10px] uppercase tracking-[0.24em] text-slate-500">Acesso real</p>
                      <h3 className="mt-2 text-xl font-semibold text-white">Super admin ou cliente</h3>
                    </div>
                    <LoginForm />
                  </div>
                </div>

                <p className="mt-8 text-xs leading-relaxed text-slate-500">
                  Recebeu um convite? Abra o link enviado pela InfraCode ou use o fluxo de{" "}
                  <Link className="text-sky-300 hover:text-sky-200 transition-colors" href="/primeiro-acesso">
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
