"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";
import { Button } from "../../../../components/ui/Button";
import { requestClientApi } from "../../../../lib/client-api";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";

interface AlertConfig {
  adminAlertPhone: string | null;
  groqUsageLimit: number;
  alertInstanceDown: boolean;
  alertNewLead: boolean;
  alertHighTokens: boolean;
}

interface GlobalChatbotPromptConfig {
  systemPrompt: string | null;
}

export default function SuperAdminSettingsPage() {
  const [alertConfig, setAlertConfig] = useState<AlertConfig | null>(null);
  const [globalChatbotPromptConfig, setGlobalChatbotPromptConfig] = useState<GlobalChatbotPromptConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [phone, setPhone] = useState("");
  const [groqLimit, setGroqLimit] = useState(80);
  const [alertInstanceDown, setAlertInstanceDown] = useState(true);
  const [alertNewLead, setAlertNewLead] = useState(true);
  const [alertHighTokens, setAlertHighTokens] = useState(true);
  const [globalSystemPrompt, setGlobalSystemPrompt] = useState("");

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const [config, promptConfig] = await Promise.all([
        requestClientApi<AlertConfig>("/admin/alerts-config"),
        requestClientApi<GlobalChatbotPromptConfig>("/admin/chatbot-global-prompt")
      ]);
      setAlertConfig(config);
      setGlobalChatbotPromptConfig(promptConfig);
      setPhone(config.adminAlertPhone ?? "");
      setGroqLimit(config.groqUsageLimit);
      setAlertInstanceDown(config.alertInstanceDown);
      setAlertNewLead(config.alertNewLead);
      setAlertHighTokens(config.alertHighTokens);
      setGlobalSystemPrompt(promptConfig.systemPrompt ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar configuracao");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSaved(false);
      const [updated, updatedPromptConfig] = await Promise.all([
        requestClientApi<AlertConfig>("/admin/alerts-config", {
          method: "PATCH",
          body: {
            adminAlertPhone: phone || null,
            groqUsageLimit: groqLimit,
            alertInstanceDown,
            alertNewLead,
            alertHighTokens
          }
        }),
        requestClientApi<GlobalChatbotPromptConfig>("/admin/chatbot-global-prompt", {
          method: "PATCH",
          body: {
            systemPrompt: globalSystemPrompt.trim() || null
          }
        })
      ]);
      setAlertConfig(updated);
      setGlobalChatbotPromptConfig(updatedPromptConfig);
      setGlobalSystemPrompt(updatedPromptConfig.systemPrompt ?? "");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div className="max-w-3xl space-y-2">
          <p className="control-kicker text-slate-400">Settings</p>
          <h2 className="text-3xl font-semibold text-white">Guardrails globais do SaaS</h2>
        </div>
        <div className="flex items-center gap-3 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Carregando...</span>
        </div>
      </section>
    );
  }

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

      <Card className="surface-card-dark text-white max-w-2xl">
        <CardHeader className="border-b border-white/8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Alertas globais</CardDescription>
              <CardTitle className="mt-2 text-xl text-white">Notificacoes WhatsApp Admin</CardTitle>
            </div>
            <span className={`status-pill ${alertConfig?.adminAlertPhone ? "bg-green-400/12 text-green-100" : "bg-yellow-400/12 text-yellow-100"}`}>
              {alertConfig?.adminAlertPhone ? "Ativo" : "Nao configurado"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <p className="text-sm leading-7 text-slate-300">
            Configure um numero WhatsApp global para receber alertas de todas as instancias de todos os tenants.
            Receba notificacoes sobre instancias caídas, novos leads, uso alto de tokens e erros criticos de worker/log.
          </p>

          {error && (
            <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="adminPhone" className="block text-sm font-medium text-slate-300">
                Numero para alertas globais
              </label>
              <input
                id="adminPhone"
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="5568999999999"
                className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 h-11 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-blue)]"
              />
              <p className="text-xs text-slate-500">Formato internacional, apenas numeros. Ex: 5568999999999</p>
            </div>

            <div className="space-y-2">
              <label htmlFor="groqLimit" className="block text-sm font-medium text-slate-300">
                Alertar quando uso de tokens atingir {groqLimit}%
              </label>
              <div className="flex items-center gap-4">
                <input
                  id="groqLimit"
                  type="range"
                  min="50"
                  max="95"
                  value={groqLimit}
                  onChange={(e) => setGroqLimit(Number(e.target.value))}
                  className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <span className="w-12 text-sm font-mono text-slate-400 text-right">{groqLimit}%</span>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <p className="text-sm font-medium text-slate-300">Tipos de alertas a receber</p>

              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={alertInstanceDown}
                  onChange={(e) => setAlertInstanceDown(e.target.checked)}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                />
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-400" />
                  <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                    Receber alerta de instancia caída
                  </span>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={alertNewLead}
                  onChange={(e) => setAlertNewLead(e.target.checked)}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                />
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                    Receber alerta de novo lead em qualquer instancia
                  </span>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={alertHighTokens}
                  onChange={(e) => setAlertHighTokens(e.target.checked)}
                  className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                />
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                    Receber alerta de uso alto de tokens
                  </span>
                </div>
              </label>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Salvando...
                </>
              ) : (
                "Salvar configuracao"
              )}
            </Button>

            {saved && (
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <CheckCircle2 className="w-4 h-4" />
                Configuracao salva!
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="surface-card-dark text-white max-w-4xl">
        <CardHeader className="border-b border-white/8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Prompt global</CardDescription>
              <CardTitle className="mt-2 text-xl text-white">Guardrails universais do chatbot</CardTitle>
            </div>
            <span className={`status-pill ${globalChatbotPromptConfig?.systemPrompt ? "bg-green-400/12 text-green-100" : "bg-yellow-400/12 text-yellow-100"}`}>
              {globalChatbotPromptConfig?.systemPrompt ? "Configurado" : "Nao configurado"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <p className="text-sm leading-7 text-slate-300">
            Este prompt afeta todos os chatbots da plataforma. Use aqui regras universais como `|||`,
            tom institucional, limites de formato e instrucoes que precisam valer para qualquer tenant.
          </p>

          <div className="space-y-2">
            <label htmlFor="globalSystemPrompt" className="block text-sm font-medium text-slate-300">
              Prompt global do chatbot
            </label>
            <textarea
              id="globalSystemPrompt"
              value={globalSystemPrompt}
              onChange={(e) => setGlobalSystemPrompt(e.target.value)}
              placeholder={"Regras globais obrigatorias:\n- Se precisar dividir a resposta, use exatamente ||| entre os blocos.\n- Nunca exponha o separador ao cliente.\n- Seja direto e profissional."}
              className="min-h-[260px] w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-blue)]"
            />
            <p className="text-xs leading-relaxed text-slate-500">
              O prompt da instancia continua existindo no tenant, mas ele passa a complementar este prompt global.
              Em caso de conflito, as regras globais devem prevalecer.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
