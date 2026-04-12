import { InfraCodeMark } from "../../../components/branding/infracode-mark";
import { LoginForm } from "../../../components/auth/login-form";

export default function LoginPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#0a0a0a] text-white">
      <div className="relative isolate min-h-screen">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.16),_transparent_38%),radial-gradient(circle_at_bottom_right,_rgba(15,23,42,0.9),_transparent_42%)]" />
        <div className="absolute inset-x-0 top-0 h-px bg-white/6" />

        <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-8 lg:px-10">
          <header className="flex items-center justify-between gap-4">
            <InfraCodeMark
              className="border border-white/8 bg-white/[0.02] px-4 py-3"
              subtitle="Workspace"
              tone="tenant"
            />
          </header>

          <div className="grid flex-1 items-center gap-16 py-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,460px)]">
            <section className="max-w-2xl space-y-8">
              <div className="space-y-6">
                <p className="text-[11px] font-medium uppercase tracking-[0.32em] text-[#93c5fd]">
                  InfraCode Platform
                </p>
                <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl lg:text-6xl">
                  Venda acesso em minutos.
                  <br />
                  <span className="text-[#3b82f6]">Operacao centralizada.</span>
                </h1>
                <div className="h-px w-24 bg-gradient-to-r from-[#60a5fa] via-[#3b82f6] to-transparent" />
                <p className="max-w-xl text-base leading-8 text-white/62 sm:text-lg">
                  Painel, onboarding e operacao multi-tenant no mesmo fluxo. Menos atrito no acesso,
                  mais clareza para administrar clientes e instancias.
                </p>
              </div>
            </section>

            <section className="w-full">
              <div className="mb-6 space-y-3">
                <h2 className="text-3xl font-semibold tracking-[-0.03em] text-white">
                  Entrar
                </h2>
                <p className="text-sm leading-7 text-white/50">
                  Acesse com email e senha. O sistema identifica seu acesso automaticamente.
                </p>
              </div>

              <LoginForm />
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
