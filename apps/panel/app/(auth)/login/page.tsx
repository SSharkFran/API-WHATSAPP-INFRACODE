import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { InfraCodeMark } from "../../../components/branding/infracode-mark";
import { LoginForm } from "../../../components/auth/login-form";

export default function LoginPage() {
  return (
    <main className="theme-auth relative min-h-screen flex flex-col items-center justify-center">
      <div className="status-bar" />
      
      <div className="mx-auto w-full max-w-[1440px] px-[var(--fluid-p-side)]">
        <header className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-[var(--fluid-p-side)] py-6 border-bottom-[1px] border-white/5 backdrop-blur-md">
          <div className="flex items-center gap-3">
             <div className="bg-[#1e3a8a] rounded-md px-2.5 py-1.5 text-[11px] font-bold text-white tracking-widest">
               ADM
             </div>
             <div className="text-[13px] font-medium text-white/90">
               InfraCode <span className="mx-2 text-white/10">·</span> WhatsApp API
             </div>
          </div>
          <div className="hidden border border-white/5 rounded px-3 py-1 text-[10px] text-white/20 uppercase tracking-widest md:block">
            v2.4.1 · Cloud
          </div>
        </header>

        <div className="grid grid-cols-1 gap-[var(--fluid-gap)] ms:grid-cols-2 items-center pt-24 pb-12">
          <section className="space-y-12 ms:pr-12 separator-vertical">
            <div className="space-y-8">
              <h1 className="text-fluid-title">
                Venda acesso <br /> em minutos. <br /> 
                <span className="text-[#2563eb]">Operação centralizada.</span>
              </h1>
              
              <div className="separator-line" />

              <p className="max-w-md text-fluid-desc">
                Painel super admin, isolamento físico em PostgreSQL e onboarding automatizado na mesma camada operacional.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {[
                ["01", "Schema por tenant", "Isolamento físico em PostgreSQL com cache LRU de Prisma."],
                ["02", "Provisionamento", "Criação de cliente, convite inicial e limites sem intervenção manual."],
                ["03", "Rastreabilidade", "Logs, billing, rate limit e saúde global em tempo real."]
              ].map(([num, title, text]) => (
                <div className="card-vercel" key={title}>
                  <div className="text-[#2563eb] text-[11px] font-bold mb-4">{num}</div>
                  <h3 className="text-[14px] font-semibold text-white/85 mb-2">{title}</h3>
                  <p className="text-[12px] text-white/25 leading-relaxed">{text}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="flex justify-center ms:pl-12">
            <div className="w-full max-w-[400px]">
              <div className="mb-10 space-y-2">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-white/30">
                  <span className="w-1 h-1 rounded-full bg-white/20" />
                  Acesso Restrito
                </div>
                <h2 className="text-[28px] font-bold tracking-tight text-white/90">Entrar</h2>
              </div>

              <LoginForm />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
