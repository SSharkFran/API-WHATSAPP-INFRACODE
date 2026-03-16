"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { InstanceHealthReport, InstanceSummary, WebhookConfig } from "@infracode/types";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from "@infracode/ui";
import type { OnboardingSnapshot } from "../../lib/api";
import { requestClientApi } from "../../lib/client-api";
import { QrModal } from "../instances/qr-modal";

interface TenantOnboardingWorkbenchProps {
  initialInstances: InstanceSummary[];
  initialOnboarding: OnboardingSnapshot;
}

const defaultWebhookEvents = "message.received, message.sent, message.failed, instance.connected, instance.disconnected";

const selectClassName =
  "h-12 w-full rounded-2xl border border-slate-200/80 bg-white/92 px-4 text-sm text-slate-950 outline-none ring-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100";

const safeParseJsonObject = (value: string): Record<string, string> => {
  if (!value.trim()) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers precisam ser um JSON valido no formato chave/valor.");
  }

  return Object.entries(parsed).reduce<Record<string, string>>((accumulator, [key, entryValue]) => {
    accumulator[key] = String(entryValue);
    return accumulator;
  }, {});
};

const formatDateTime = (value?: string | null): string => (value ? new Date(value).toLocaleString("pt-BR") : "nao disponivel");

export const TenantOnboardingWorkbench = ({
  initialInstances,
  initialOnboarding
}: TenantOnboardingWorkbenchProps) => {
  const router = useRouter();
  const [instances, setInstances] = useState(initialInstances);
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const [selectedInstanceId, setSelectedInstanceId] = useState(initialInstances[0]?.id ?? "");
  const [health, setHealth] = useState<InstanceHealthReport | null>(null);
  const [webhookConfig, setWebhookConfig] = useState<WebhookConfig | null>(null);
  const [showQrFor, setShowQrFor] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    name: "",
    proxyUrl: "",
    autoStart: true
  });
  const [webhookForm, setWebhookForm] = useState({
    url: "",
    secret: "",
    headersJson: "{\n  \"x-source\": \"infracode\"\n}",
    subscribedEvents: defaultWebhookEvents,
    isActive: true
  });

  const selectedInstance = useMemo(
    () => instances.find((instance) => instance.id === selectedInstanceId) ?? null,
    [instances, selectedInstanceId]
  );

  const refreshOnboarding = async (): Promise<void> => {
    const snapshot = await requestClientApi<OnboardingSnapshot>("/tenant/onboarding/sync", {
      method: "POST"
    });
    setOnboarding(snapshot);
  };

  useEffect(() => {
    if (!selectedInstanceId) {
      setHealth(null);
      setWebhookConfig(null);
      return;
    }

    let active = true;

    const loadRuntime = async () => {
      try {
        const [nextHealth, nextWebhookConfig] = await Promise.all([
          requestClientApi<InstanceHealthReport>(`/instances/${selectedInstanceId}/health`),
          requestClientApi<WebhookConfig | null>(`/instances/${selectedInstanceId}/webhooks`)
        ]);

        if (!active) {
          return;
        }

        setHealth(nextHealth);
        setWebhookConfig(nextWebhookConfig);

        if (nextWebhookConfig) {
          setWebhookForm({
            url: nextWebhookConfig.url,
            secret: nextWebhookConfig.secret,
            headersJson: JSON.stringify(nextWebhookConfig.headers, null, 2),
            subscribedEvents: nextWebhookConfig.subscribedEvents.join(", "),
            isActive: nextWebhookConfig.isActive
          });
        } else {
          setWebhookForm({
            url: "",
            secret: "",
            headersJson: "{\n  \"x-source\": \"infracode\"\n}",
            subscribedEvents: defaultWebhookEvents,
            isActive: true
          });
        }
      } catch {
        if (active) {
          setHealth(null);
          setWebhookConfig(null);
        }
      }
    };

    void loadRuntime();

    return () => {
      active = false;
    };
  }, [selectedInstanceId]);

  const createInstance = async () => {
    setPendingAction("create-instance");
    setError(null);
    setSuccess(null);

    try {
      const created = await requestClientApi<InstanceSummary>("/instances", {
        method: "POST",
        body: {
          name: createForm.name,
          proxyUrl: createForm.proxyUrl || undefined,
          autoStart: createForm.autoStart
        }
      });

      setInstances((current) => [created, ...current]);
      setSelectedInstanceId(created.id);
      setCreateForm({
        name: "",
        proxyUrl: "",
        autoStart: true
      });
      await refreshOnboarding();
      setSuccess("Instancia criada. Abra o QR para concluir a conexao.");
      startTransition(() => {
        router.refresh();
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao criar a instancia.");
    } finally {
      setPendingAction(null);
    }
  };

  const runInstanceAction = async (action: "start" | "restart" | "pause") => {
    if (!selectedInstance) {
      return;
    }

    setPendingAction(action);
    setError(null);
    setSuccess(null);

    try {
      const updated = await requestClientApi<InstanceSummary>(`/instances/${selectedInstance.id}/${action}`, {
        method: "POST"
      });

      setInstances((current) => current.map((instance) => (instance.id === updated.id ? updated : instance)));
      const nextHealth = await requestClientApi<InstanceHealthReport>(`/instances/${selectedInstance.id}/health`);
      setHealth(nextHealth);
      await refreshOnboarding();
      setSuccess(`Instancia ${action === "start" ? "iniciada" : action === "restart" ? "reiniciada" : "pausada"} com sucesso.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao executar a acao.");
    } finally {
      setPendingAction(null);
    }
  };

  const saveWebhook = async () => {
    if (!selectedInstance) {
      return;
    }

    setPendingAction("save-webhook");
    setError(null);
    setSuccess(null);

    try {
      const nextWebhook = await requestClientApi<WebhookConfig>(`/instances/${selectedInstance.id}/webhooks`, {
        method: "POST",
        body: {
          url: webhookForm.url,
          secret: webhookForm.secret,
          headers: safeParseJsonObject(webhookForm.headersJson),
          subscribedEvents: webhookForm.subscribedEvents
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          isActive: webhookForm.isActive
        }
      });

      setWebhookConfig(nextWebhook);
      await refreshOnboarding();
      setSuccess("Webhook salvo. O tenant ja pode consumir eventos da instancia.");
      startTransition(() => {
        router.refresh();
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao salvar o webhook.");
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <>
      <section className="space-y-6">
        <div className="max-w-3xl space-y-2">
          <p className="control-kicker text-sky-700">Onboarding</p>
          <h2 className="text-3xl font-semibold text-slate-950">Primeira instancia, QR e webhook</h2>
          <p className="text-sm leading-7 text-slate-600">
            Fluxo guiado para colocar o tenant em producao sem depender de suporte da InfraCode.
          </p>
        </div>

        {error ? <p className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
        {success ? <p className="rounded-[20px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</p> : null}

        <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
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
                <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Criar instancia</CardDescription>
                <CardTitle className="text-2xl text-white">Passo 1 · Provisionar o canal</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Nome da instancia</span>
                  <Input
                    className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                    onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Comercial BR"
                    value={createForm.name}
                  />
                </label>
                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Proxy opcional</span>
                  <Input
                    className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                    onChange={(event) => setCreateForm((current) => ({ ...current, proxyUrl: event.target.value }))}
                    placeholder="http://user:pass@proxy:8080"
                    value={createForm.proxyUrl}
                  />
                </label>
                <label className="flex items-center gap-3 rounded-[20px] border border-white/8 bg-white/5 px-4 py-3 text-sm text-slate-300">
                  <input
                    checked={createForm.autoStart}
                    onChange={(event) => setCreateForm((current) => ({ ...current, autoStart: event.target.checked }))}
                    type="checkbox"
                  />
                  Iniciar automaticamente apos criar
                </label>
                <Button disabled={pendingAction !== null || !createForm.name.trim()} onClick={() => void createInstance()}>
                  {pendingAction === "create-instance" ? "Criando..." : "Criar primeira instancia"}
                </Button>
              </CardContent>
            </Card>

            <Card className="surface-card">
              <CardHeader>
                <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Runtime</CardDescription>
                <CardTitle className="text-2xl text-slate-950">Passo 2 · Conectar e acompanhar</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="space-y-2 text-sm">
                  <span className="text-slate-600">Instancia alvo</span>
                  <select className={selectClassName} onChange={(event) => setSelectedInstanceId(event.target.value)} value={selectedInstanceId}>
                    <option value="">Selecione uma instancia</option>
                    {instances.map((instance) => (
                      <option key={instance.id} value={instance.id}>
                        {instance.name} · {instance.status}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedInstance ? (
                  <>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="list-row-light rounded-[22px] p-4">
                        <p className="control-kicker text-slate-400">Status</p>
                        <p className="mt-2 text-lg font-semibold text-slate-950">{selectedInstance.status}</p>
                      </div>
                      <div className="list-row-light rounded-[22px] p-4">
                        <p className="control-kicker text-slate-400">Numero</p>
                        <p className="mt-2 text-lg font-semibold text-slate-950">{selectedInstance.phoneNumber ?? "Aguardando scan"}</p>
                      </div>
                    </div>

                    {health ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="list-row-light rounded-[22px] p-4">Uptime: {health.uptimeSeconds}s</div>
                        <div className="list-row-light rounded-[22px] p-4">Fila: {health.queueDepth}</div>
                        <div className="list-row-light rounded-[22px] p-4">Ultima atividade: {formatDateTime(health.lastActivityAt)}</div>
                        <div className="list-row-light rounded-[22px] p-4">QR expira em: {health.qrExpiresIn ?? 0}s</div>
                      </div>
                    ) : null}

                    {health?.lastError ? (
                      <div className="rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                        Ultimo erro do worker: {health.lastError}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-3">
                      <Button className="rounded-2xl" onClick={() => setShowQrFor(selectedInstance.id)} variant="secondary">
                        Abrir QR
                      </Button>
                      <Button className="rounded-2xl" disabled={pendingAction !== null} onClick={() => void runInstanceAction("start")} variant="ghost">
                        Iniciar
                      </Button>
                      <Button className="rounded-2xl" disabled={pendingAction !== null} onClick={() => void runInstanceAction("restart")} variant="ghost">
                        Reiniciar
                      </Button>
                      <Button className="rounded-2xl" disabled={pendingAction !== null} onClick={() => void runInstanceAction("pause")} variant="ghost">
                        Pausar
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="list-row-light rounded-[22px] p-4 text-sm text-slate-600">Crie a primeira instancia para liberar QR, health e webhook.</div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <Card className="surface-card">
          <CardHeader>
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Webhook</CardDescription>
            <CardTitle className="text-2xl text-slate-950">Passo 3 · Fechar o onboarding</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-4">
              <label className="space-y-2 text-sm">
                <span className="text-slate-600">URL do webhook</span>
                <Input
                  onChange={(event) => setWebhookForm((current) => ({ ...current, url: event.target.value }))}
                  placeholder="https://seu-sistema.com/webhook"
                  value={webhookForm.url}
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className="text-slate-600">Secret HMAC</span>
                <Input
                  onChange={(event) => setWebhookForm((current) => ({ ...current, secret: event.target.value }))}
                  placeholder="segredo-webhook-forte"
                  value={webhookForm.secret}
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className="text-slate-600">Eventos</span>
                <Input
                  onChange={(event) => setWebhookForm((current) => ({ ...current, subscribedEvents: event.target.value }))}
                  placeholder={defaultWebhookEvents}
                  value={webhookForm.subscribedEvents}
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className="text-slate-600">Headers em JSON</span>
                <textarea
                  className="min-h-[180px] w-full rounded-[24px] border border-slate-200/80 bg-white/92 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100"
                  onChange={(event) => setWebhookForm((current) => ({ ...current, headersJson: event.target.value }))}
                  value={webhookForm.headersJson}
                />
              </label>
              <label className="flex items-center gap-3 rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                <input
                  checked={webhookForm.isActive}
                  onChange={(event) => setWebhookForm((current) => ({ ...current, isActive: event.target.checked }))}
                  type="checkbox"
                />
                Webhook ativo
              </label>
              <Button disabled={pendingAction !== null || !selectedInstance} onClick={() => void saveWebhook()}>
                {pendingAction === "save-webhook" ? "Salvando..." : "Salvar webhook"}
              </Button>
            </div>

            <div className="space-y-4">
              <div className="list-row-light rounded-[24px] p-4">
                <p className="control-kicker text-slate-400">Config atual</p>
                <p className="mt-2 text-lg font-semibold text-slate-950">{webhookConfig ? webhookConfig.url : "Nenhum webhook configurado"}</p>
                <p className="mt-2 text-sm text-slate-600">
                  {webhookConfig ? `${webhookConfig.subscribedEvents.length} eventos ativos` : "Ao salvar, o checklist do onboarding sera atualizado."}
                </p>
              </div>

              <div className="list-row-dark rounded-[24px] p-4 text-sm leading-7 text-slate-300">
                1. Crie a instancia.
                <br />
                2. Abra o QR e confirme o scan no WhatsApp.
                <br />
                3. Salve o webhook com HMAC para receber `message.received`, `message.sent` e sinais de conexao.
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <QrModal instanceId={showQrFor} onClose={() => setShowQrFor(null)} open={Boolean(showQrFor)} />
    </>
  );
};
