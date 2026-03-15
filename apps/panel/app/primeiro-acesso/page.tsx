import Link from "next/link";
import { AcceptInvitationForm } from "../../components/auth/accept-invitation-form";
import { InfraCodeMark } from "../../components/branding/infracode-mark";

interface PrimeiroAcessoPageProps {
  searchParams?: {
    token?: string;
  };
}

export default function PrimeiroAcessoPage({ searchParams }: PrimeiroAcessoPageProps) {
  return (
    <main className="theme-auth min-h-screen px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-7xl items-center gap-8 lg:grid-cols-[1.08fr_0.92fr]">
        <section className="space-y-8">
          <InfraCodeMark className="auth-brand-chip" subtitle="Primeiro acesso do cliente" />
          <div className="max-w-3xl space-y-5">
            <p className="control-kicker text-sky-300">Onboarding guiado</p>
            <h1 className="text-5xl font-semibold leading-[1.02] text-white sm:text-6xl">Defina a senha e entre no tenant em poucos segundos.</h1>
            <p className="max-w-2xl text-lg leading-8 text-slate-300">
              O convite da InfraCode ja carrega o token do tenant. Ao concluir, a sessao e criada e o redirect segue direto para o onboarding.
            </p>
          </div>
        </section>

        <section className="auth-login-shell rounded-[36px] p-1">
          <div className="auth-login-panel rounded-[32px] p-6 sm:p-8">
            <div className="space-y-3">
              <p className="control-kicker text-slate-400">Primeiro acesso</p>
              <h2 className="text-3xl font-semibold text-white">Ativar conta do cliente</h2>
            </div>
            <div className="mt-6 rounded-[28px] border border-white/8 bg-slate-950/40 p-5 sm:p-6">
              <AcceptInvitationForm token={searchParams?.token} />
            </div>
            <p className="mt-5 text-sm text-slate-400">
              Ja definiu a senha?{" "}
              <Link className="text-sky-300 underline underline-offset-4 transition hover:text-sky-200" href="/login">
                Entrar no painel
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
