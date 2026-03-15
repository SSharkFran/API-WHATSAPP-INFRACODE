import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { getServerPanelConfig } from "../../../../lib/api";

export default function TenantApiKeysPage() {
  const panelConfig = getServerPanelConfig();

  return (
    <section className="space-y-6">
      <div className="max-w-3xl space-y-2">
        <p className="control-kicker text-sky-700">API Keys</p>
        <h2 className="text-3xl font-semibold text-slate-950">Integracoes do tenant</h2>
        <p className="text-sm leading-7 text-slate-600">Contexto tecnico para SDK, automacoes e emissoes futuras de chaves seguras.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <Card className="surface-card">
          <CardHeader>
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Configuracao</CardDescription>
            <CardTitle className="text-2xl text-slate-950">Runtime do painel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-7 text-slate-600">
            <div className="list-row-light rounded-[22px] p-4">
              <p className="control-kicker text-slate-400">Base URL</p>
              <p className="mt-2 text-slate-950">{panelConfig.apiBaseUrl}</p>
            </div>
            <div className="list-row-light rounded-[22px] p-4">
              <p className="control-kicker text-slate-400">Tenant slug</p>
              <p className="mt-2 text-slate-950">{panelConfig.tenantSlug}</p>
            </div>
            <div className="list-row-light rounded-[22px] p-4">
              <p className="control-kicker text-slate-400">Auth atual</p>
              <p className="mt-2 text-slate-950">
                {panelConfig.tenantAccessToken ? "Bearer token" : panelConfig.tenantApiKey ? "API key" : "demo fallback"}
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-5">
          <Card className="surface-card-dark text-white">
            <CardHeader className="border-b border-white/8">
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Exemplo</CardDescription>
              <CardTitle className="text-2xl text-white">Payload para integracao</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto rounded-[22px] border border-white/8 bg-slate-950/70 p-4 text-xs leading-6 text-slate-300">
{`{
  "baseUrl": "${panelConfig.apiBaseUrl}",
  "tenantSlug": "${panelConfig.tenantSlug}",
  "auth": "${panelConfig.tenantAccessToken ? "bearer" : panelConfig.tenantApiKey ? "apiKey" : "none"}"
}`}
              </pre>
            </CardContent>
          </Card>

          <Card className="surface-card">
            <CardHeader>
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Integracoes</CardDescription>
              <CardTitle className="text-2xl text-slate-950">n8n, Make e SDK</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-600">
              <div className="list-row-light rounded-[22px] p-4">Use a emissao e revogacao centralizada no backend do tenant.</div>
              <div className="list-row-light rounded-[22px] p-4">Webhooks assinados e trace ID ajudam no rastreamento ponta a ponta.</div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
