import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { InfraCodeMark } from "../../../components/branding/infracode-mark";
import { LoginForm } from "../../../components/auth/login-form";

export default function LoginPage() {
  return (
    <main className="theme-auth relative min-h-screen">
      <div className="mx-auto w-full px-[var(--fluid-p-side)] py-[var(--fluid-p-vert)]">
        <header className="mb-[var(--fluid-gap)] flex items-center justify-between">
          <InfraCodeMark className="opacity-80 grayscale" subtitle="WhatsApp API Cloud" tone="super" />
          <div className="hidden text-[10px] uppercase tracking-[0.2em] text-[#2e3d58] md:block">
            Multi-tenant / InfraCode
          </div>
        </header>

        <div className="grid grid-cols-1 gap-[var(--fluid-gap)] ms:grid-cols-2 lg:items-center">
          <section className="space-y-[var(--fluid-gap)]">
            <div className="space-y-6">
              <div className="badge-dot">
                Plataforma SaaS / Operação Real
              </div>
              <h1 className="text-fluid-title text-white">
                Venda acesso em minutos. Isolamento forte, onboarding simples e operação centralizada.
              </h1>
              <p className="max-w-xl text-fluid-desc text-[#2e3d58] hover:text-white/60 transition-colors">
                Painel super admin, tenant panel, billing interno, QR Code por instância, webhook e observabilidade em uma única plataforma.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              {[
                ["Schema por tenant", "Isolamento físico em PostgreSQL com cache LRU de Prisma."],
                ["Provisionamento", "Criação de cliente, convite inicial e limites sem intervenção manual."],
                ["Rastreabilidade", "Logs, billing, rate limit e saúde global na mesma camada operacional."]
              ].map(([title, text]) => (
                <Card className="card-minimal flex flex-col justify-between p-8" key={title}>
                  <h3 className="text-[15px] font-bold text-white tracking-tight">{title}</h3>
                  <p className="mt-4 text-[13px] font-light leading-relaxed text-[#2e3d58]">{text}</p>
                </Card>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-6 xs:grid-cols-2">
              <div className="minimalist-border p-8">
                <p className="label-minimal">Stack operacional</p>
                <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {["Fastify + Baileys", "PostgreSQL", "Redis + BullMQ", "Next.js"].map((item) => (
                    <div className="text-[12px] font-light text-[#2e3d58]" key={item}>
                      {item}
                    </div>
                  ))}
                </div>
              </div>

              <div className="minimalist-border p-8">
                <p className="label-minimal">Fluxo comercial</p>
                <div className="mt-6 space-y-3">
                  {[
                    "Criação de tenant e convite imediato.",
                    "Configuração de senha e QR Code.",
                    "Operação isolada com controle central."
                  ].map((item) => (
                    <div className="flex gap-3 text-[12px] font-light text-[#2e3d58]" key={item}>
                      <span>—</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="flex justify-center lg:justify-end">
            <div className="w-full max-w-[480px]">
              <div className="mb-6 space-y-2">
                <div className="badge-dot">Acesso seguro</div>
                <h2 className="text-[28px] font-bold tracking-tight text-white">Entrar</h2>
              </div>

              <div className="minimalist-border p-8 md:p-12">
                <LoginForm />
              </div>

              <p className="mt-8 text-[12px] font-light text-[#2e3d58]">
                Link enviado pela InfraCode? Use o fluxo de{" "}
                <Link className="text-white/40 hover:text-white transition-colors underline underline-offset-4" href="/primeiro-acesso">
                  primeiro acesso
                </Link>
                .
              </p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
