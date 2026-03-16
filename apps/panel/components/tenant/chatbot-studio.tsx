"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ChatbotAiMode,
  ChatbotConfig,
  ChatbotRule,
  ChatbotSimulationResult,
  ChatbotTriggerType,
  InstanceSummary
} from "@infracode/types";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from "@infracode/ui";
import { requestClientApi } from "../../lib/client-api";

interface ChatbotStudioProps {
  initialInstances: InstanceSummary[];
}

interface ChatbotFormState {
  isEnabled: boolean;
  welcomeMessage: string;
  fallbackMessage: string;
  rules: ChatbotRule[];
  ai: {
    isEnabled: boolean;
    mode: ChatbotAiMode;
    provider: "GROQ" | "OPENAI_COMPATIBLE" | "ANTHROPIC" | null;
    model: string;
    systemPrompt: string;
    temperature: number;
    maxContextMessages: number;
    isManagedByAdmin: boolean;
    isProviderConfigured: boolean;
    isProviderActive: boolean;
  };
}

interface SimulationFormState {
  text: string;
  isFirstContact: boolean;
  contactName: string;
  phoneNumber: string;
}

const selectClassName =
  "h-12 w-full rounded-2xl border border-slate-200/80 bg-white/92 px-4 text-sm text-slate-950 outline-none ring-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100";

const triggerTypeLabels: Record<ChatbotTriggerType, string> = {
  EXACT: "Texto exato",
  CONTAINS: "Contem termo",
  REGEX: "Regex",
  FIRST_CONTACT: "Primeiro contato"
};

const createRuleId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `rule-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const buildEmptyRule = (): ChatbotRule => ({
  id: createRuleId(),
  name: "Nova regra",
  triggerType: "CONTAINS",
  matchValue: "",
  responseText: "",
  isActive: true
});

const buildDefaultFormState = (): ChatbotFormState => ({
  isEnabled: false,
  welcomeMessage: "",
  fallbackMessage: "",
  rules: [],
  ai: {
    isEnabled: false,
    mode: "RULES_THEN_AI",
    provider: null,
    model: "",
    systemPrompt:
      "Voce e um assistente virtual comercial no WhatsApp. Responda sempre em portugues do Brasil, com clareza, objetividade e tom profissional.",
    temperature: 0.4,
    maxContextMessages: 12,
    isManagedByAdmin: true,
    isProviderConfigured: false,
    isProviderActive: false
  }
});

const buildSimulationFormState = (): SimulationFormState => ({
  text: "",
  isFirstContact: false,
  contactName: "Cliente InfraCode",
  phoneNumber: "5511999999999"
});

const mapConfigToFormState = (config: ChatbotConfig): ChatbotFormState => ({
  isEnabled: config.isEnabled,
  welcomeMessage: config.welcomeMessage ?? "",
  fallbackMessage: config.fallbackMessage ?? "",
  rules: config.rules,
  ai: {
    isEnabled: config.ai.isEnabled,
    mode: config.ai.mode,
    provider: config.ai.provider,
    model: config.ai.model,
    systemPrompt: config.ai.systemPrompt,
    temperature: config.ai.temperature,
    maxContextMessages: config.ai.maxContextMessages,
    isManagedByAdmin: config.ai.isManagedByAdmin,
    isProviderConfigured: config.ai.isProviderConfigured,
    isProviderActive: config.ai.isProviderActive
  }
});

const formatDateTime = (value?: string | null): string =>
  value ? new Date(value).toLocaleString("pt-BR") : "Nao salvo ainda";

export const ChatbotStudio = ({ initialInstances }: ChatbotStudioProps) => {
  const router = useRouter();
  const [instances] = useState(initialInstances);
  const [selectedInstanceId, setSelectedInstanceId] = useState(initialInstances[0]?.id ?? "");
  const [formState, setFormState] = useState<ChatbotFormState>(buildDefaultFormState);
  const [simulationForm, setSimulationForm] = useState<SimulationFormState>(buildSimulationFormState);
  const [lastSavedConfig, setLastSavedConfig] = useState<ChatbotConfig | null>(null);
  const [simulationResult, setSimulationResult] = useState<ChatbotSimulationResult | null>(null);
  const [pendingAction, setPendingAction] = useState<"load" | "save" | "simulate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedInstance = useMemo(
    () => instances.find((instance) => instance.id === selectedInstanceId) ?? null,
    [instances, selectedInstanceId]
  );

  useEffect(() => {
    if (!selectedInstanceId) {
      setFormState(buildDefaultFormState());
      setLastSavedConfig(null);
      setSimulationResult(null);
      return;
    }

    let active = true;
    setPendingAction("load");
    setError(null);
    setSuccess(null);

    const loadConfig = async () => {
      try {
        const config = await requestClientApi<ChatbotConfig>(`/instances/${selectedInstanceId}/chatbot`);

        if (!active) {
          return;
        }

        setLastSavedConfig(config);
        setFormState(mapConfigToFormState(config));
        setSimulationResult(null);
      } catch (caught) {
        if (!active) {
          return;
        }

        setError(caught instanceof Error ? caught.message : "Falha ao carregar o chatbot da instancia.");
        setFormState(buildDefaultFormState());
        setLastSavedConfig(null);
      } finally {
        if (active) {
          setPendingAction(null);
        }
      }
    };

    void loadConfig();

    return () => {
      active = false;
    };
  }, [selectedInstanceId]);

  const updateRule = (ruleId: string, patch: Partial<ChatbotRule>) => {
    setFormState((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === ruleId
          ? {
              ...rule,
              ...patch,
              matchValue:
                patch.triggerType === "FIRST_CONTACT"
                  ? null
                  : patch.matchValue !== undefined
                    ? patch.matchValue
                    : rule.matchValue
            }
          : rule
      )
    }));
  };

  const addRule = () => {
    setFormState((current) => ({
      ...current,
      rules: [...current.rules, buildEmptyRule()]
    }));
  };

  const removeRule = (ruleId: string) => {
    setFormState((current) => ({
      ...current,
      rules: current.rules.filter((rule) => rule.id !== ruleId)
    }));
  };

  const saveConfig = async () => {
    if (!selectedInstance) {
      return;
    }

    setPendingAction("save");
    setError(null);
    setSuccess(null);

    try {
      const saved = await requestClientApi<ChatbotConfig>(`/instances/${selectedInstance.id}/chatbot`, {
        method: "PUT",
        body: {
          isEnabled: formState.isEnabled,
          welcomeMessage: formState.welcomeMessage.trim() || null,
          fallbackMessage: formState.fallbackMessage.trim() || null,
          rules: formState.rules.map((rule) => ({
            ...rule,
            matchValue: rule.triggerType === "FIRST_CONTACT" ? null : rule.matchValue?.trim() || null,
            responseText: rule.responseText.trim()
          })),
          ai: {
            isEnabled: formState.ai.isEnabled,
            mode: formState.ai.mode,
            systemPrompt: formState.ai.systemPrompt.trim(),
            temperature: formState.ai.temperature,
            maxContextMessages: formState.ai.maxContextMessages
          }
        }
      });

      setLastSavedConfig(saved);
      setFormState(mapConfigToFormState(saved));
      setSuccess("Chatbot salvo. As respostas automaticas da instancia ja foram atualizadas.");
      startTransition(() => {
        router.refresh();
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao salvar o chatbot.");
    } finally {
      setPendingAction(null);
    }
  };

  const runSimulation = async () => {
    if (!selectedInstance) {
      return;
    }

    setPendingAction("simulate");
    setError(null);
    setSuccess(null);

    try {
      const result = await requestClientApi<ChatbotSimulationResult>(`/instances/${selectedInstance.id}/chatbot/simulate`, {
        method: "POST",
        body: {
          text: simulationForm.text,
          isFirstContact: simulationForm.isFirstContact,
          contactName: simulationForm.contactName || undefined,
          phoneNumber: simulationForm.phoneNumber
        }
      });

      setSimulationResult(result);
      setSuccess("Simulacao executada com a configuracao persistida da instancia.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao simular o chatbot.");
    } finally {
      setPendingAction(null);
    }
  };

  if (instances.length === 0) {
    return (
      <section className="space-y-6">
        <div className="max-w-3xl space-y-2">
          <p className="control-kicker text-sky-700">Chatbot nativo</p>
          <h2 className="text-3xl font-semibold text-slate-950">Configure automacao por instancia</h2>
          <p className="text-sm leading-7 text-slate-600">
            O builder basico do tenant libera respostas automaticas, fallback e simulacao antes mesmo de abrir a primeira conversa.
          </p>
        </div>

        <Card className="surface-card">
          <CardHeader>
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Prerequisito</CardDescription>
            <CardTitle className="text-2xl text-slate-950">Crie uma instancia primeiro</CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-7 text-slate-600">
            O chatbot eh configurado por instancia. Conclua o onboarding, gere o QR Code e depois volte para montar as regras de atendimento.
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="max-w-4xl space-y-2">
        <p className="control-kicker text-sky-700">Chatbot nativo</p>
        <h2 className="text-3xl font-semibold text-slate-950">Regras textuais por instancia com simulacao imediata</h2>
        <p className="text-sm leading-7 text-slate-600">
          Ative respostas automaticas por canal, monte regras simples e valide o comportamento antes de colocar o atendimento no ar.
        </p>
      </div>

      {error ? <p className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
      {success ? <p className="rounded-[20px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</p> : null}

      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="surface-card">
          <CardHeader>
            <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Builder</CardDescription>
            <CardTitle className="text-2xl text-slate-950">Regras e mensagens base</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <label className="space-y-2 text-sm">
              <span className="text-slate-600">Instancia alvo</span>
              <select className={selectClassName} onChange={(event) => setSelectedInstanceId(event.target.value)} value={selectedInstanceId}>
                {instances.map((instance) => (
                  <option key={instance.id} value={instance.id}>
                    {instance.name} / {instance.status}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-3 rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <input
                checked={formState.isEnabled}
                onChange={(event) => setFormState((current) => ({ ...current, isEnabled: event.target.checked }))}
                type="checkbox"
              />
              Chatbot habilitado para a instancia
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-slate-600">Mensagem de boas-vindas</span>
              <textarea
                className="min-h-[130px] w-full rounded-[24px] border border-slate-200/80 bg-white/92 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100"
                onChange={(event) => setFormState((current) => ({ ...current, welcomeMessage: event.target.value }))}
                placeholder="Ola {{nome}}, bem-vindo ao atendimento da InfraCode."
                value={formState.welcomeMessage}
              />
            </label>

            <label className="space-y-2 text-sm">
              <span className="text-slate-600">Fallback</span>
              <textarea
                className="min-h-[130px] w-full rounded-[24px] border border-slate-200/80 bg-white/92 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100"
                onChange={(event) => setFormState((current) => ({ ...current, fallbackMessage: event.target.value }))}
                placeholder="Nao encontrei uma resposta pronta para isso. Digite suporte para falar com o time."
                value={formState.fallbackMessage}
              />
            </label>

            <div className="space-y-4 rounded-[24px] border border-slate-200 bg-slate-50/70 p-4">
              <div>
                <p className="text-lg font-semibold text-slate-950">Modo IA gerenciado pela InfraCode</p>
                <p className="text-sm text-slate-600">
                  O tenant escolhe como a IA participa do atendimento. Provedor, modelo e chave ficam no painel do super admin.
                </p>
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                <div className="rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Provedor</p>
                  <p className="mt-2 font-semibold text-slate-950">{formState.ai.provider ?? "Nao configurado"}</p>
                </div>
                <div className="rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Modelo</p>
                  <p className="mt-2 font-semibold text-slate-950">{formState.ai.model || "Definido pela InfraCode"}</p>
                </div>
                <div className="rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Status</p>
                  <p className="mt-2 font-semibold text-slate-950">
                    {formState.ai.isProviderConfigured
                      ? formState.ai.isProviderActive
                        ? "Ativo"
                        : "Configurado, mas inativo"
                      : "Aguardando configuracao do admin"}
                  </p>
                </div>
              </div>

              <label className="flex items-center gap-3 rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                <input
                  checked={formState.ai.isEnabled}
                  onChange={(event) =>
                    setFormState((current) => ({
                      ...current,
                      ai: {
                        ...current.ai,
                        isEnabled: event.target.checked
                      }
                    }))
                  }
                  type="checkbox"
                />
                Responder com IA quando aplicavel
              </label>

              {!formState.ai.isProviderConfigured ? (
                <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  A InfraCode ainda nao vinculou um provedor de IA para este tenant. Voce ja pode deixar o modo pronto e salvar.
                </div>
              ) : null}

              <div className="grid gap-4 lg:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="text-slate-600">Modo</span>
                  <select
                    className={selectClassName}
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        ai: {
                          ...current.ai,
                          mode: event.target.value as ChatbotAiMode
                        }
                      }))
                    }
                    value={formState.ai.mode}
                  >
                    <option value="RULES_ONLY">Somente regras</option>
                    <option value="RULES_THEN_AI">Regras e depois IA</option>
                    <option value="AI_ONLY">Somente IA</option>
                  </select>
                </label>
                <div className="rounded-[20px] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Gestao</p>
                  <p className="mt-2">As credenciais desta IA ficam bloqueadas no control plane da InfraCode.</p>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="text-slate-600">Temperatura</span>
                  <Input
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        ai: {
                          ...current.ai,
                          temperature: Number(event.target.value || 0)
                        }
                      }))
                    }
                    type="number"
                    value={formState.ai.temperature}
                  />
                </label>
                <label className="space-y-2 text-sm">
                  <span className="text-slate-600">Contexto maximo</span>
                  <Input
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        ai: {
                          ...current.ai,
                          maxContextMessages: Number(event.target.value || 1)
                        }
                      }))
                    }
                    type="number"
                    value={formState.ai.maxContextMessages}
                  />
                </label>
              </div>

              <label className="space-y-2 text-sm">
                <span className="text-slate-600">Prompt do sistema</span>
                <textarea
                  className="min-h-[140px] w-full rounded-[24px] border border-slate-200/80 bg-white/92 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100"
                  onChange={(event) =>
                    setFormState((current) => ({
                      ...current,
                      ai: {
                        ...current.ai,
                        systemPrompt: event.target.value
                      }
                    }))
                  }
                  placeholder="Voce e um assistente comercial..."
                  value={formState.ai.systemPrompt}
                />
              </label>
            </div>

            <div className="space-y-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-lg font-semibold text-slate-950">Regras ativas</p>
                  <p className="text-sm text-slate-600">Cada regra responde em cima do texto recebido pela instancia selecionada.</p>
                </div>
                <Button className="rounded-2xl" onClick={addRule} variant="secondary">
                  Nova regra
                </Button>
              </div>

              {formState.rules.length === 0 ? (
                <div className="list-row-light rounded-[24px] p-4 text-sm text-slate-600">
                  Nenhuma regra cadastrada ainda. Use a mensagem de boas-vindas e o fallback ou adicione regras especificas para preco,
                  suporte e cancelamento.
                </div>
              ) : null}

              <div className="grid gap-4">
                {formState.rules.map((rule, index) => (
                  <div className="list-row-light rounded-[24px] p-4" key={rule.id}>
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <p className="control-kicker text-slate-400">Regra {index + 1}</p>
                          <p className="mt-2 text-lg font-semibold text-slate-950">{rule.name || "Sem nome"}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                            <input
                              checked={rule.isActive}
                              onChange={(event) => updateRule(rule.id, { isActive: event.target.checked })}
                              type="checkbox"
                            />
                            Ativa
                          </label>
                          <Button className="rounded-2xl" onClick={() => removeRule(rule.id)} variant="ghost">
                            Remover
                          </Button>
                        </div>
                      </div>

                      <div className="grid gap-4 lg:grid-cols-2">
                        <label className="space-y-2 text-sm">
                          <span className="text-slate-600">Nome</span>
                          <Input onChange={(event) => updateRule(rule.id, { name: event.target.value })} value={rule.name} />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span className="text-slate-600">Trigger</span>
                          <select
                            className={selectClassName}
                            onChange={(event) =>
                              updateRule(rule.id, {
                                triggerType: event.target.value as ChatbotTriggerType,
                                matchValue: event.target.value === "FIRST_CONTACT" ? null : rule.matchValue ?? ""
                              })
                            }
                            value={rule.triggerType}
                          >
                            {Object.entries(triggerTypeLabels).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      {rule.triggerType !== "FIRST_CONTACT" ? (
                        <label className="space-y-2 text-sm">
                          <span className="text-slate-600">Valor de match</span>
                          <Input
                            onChange={(event) => updateRule(rule.id, { matchValue: event.target.value })}
                            placeholder={rule.triggerType === "REGEX" ? "^preco|valor$" : "preco"}
                            value={rule.matchValue ?? ""}
                          />
                        </label>
                      ) : (
                        <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                          Esta regra dispara no primeiro contato, sem depender de match textual.
                        </div>
                      )}

                      <label className="space-y-2 text-sm">
                        <span className="text-slate-600">Resposta</span>
                        <textarea
                          className="min-h-[120px] w-full rounded-[24px] border border-slate-200/80 bg-white/92 px-4 py-3 text-sm text-slate-950 outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-100"
                          onChange={(event) => updateRule(rule.id, { responseText: event.target.value })}
                          placeholder="Nosso plano de entrada custa a partir de R$ 99 por mes."
                          value={rule.responseText}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button disabled={pendingAction !== null || !selectedInstance} onClick={() => void saveConfig()}>
                {pendingAction === "save" ? "Salvando..." : "Salvar chatbot"}
              </Button>
              <Button
                className="rounded-2xl"
                disabled={pendingAction !== null}
                onClick={() => {
                  setFormState(lastSavedConfig ? mapConfigToFormState(lastSavedConfig) : buildDefaultFormState());
                  setSuccess(null);
                  setError(null);
                }}
                variant="ghost"
              >
                Reverter para a ultima versao salva
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-5">
          <Card className="surface-card-dark text-white">
            <CardHeader className="border-b border-white/8">
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-400">Simulacao</CardDescription>
              <CardTitle className="text-2xl text-white">Teste antes de ativar</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="space-y-2 text-sm">
                <span className="text-slate-300">Texto de entrada</span>
                <textarea
                  className="min-h-[130px] w-full rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-4 focus:ring-sky-400/20"
                  onChange={(event) => setSimulationForm((current) => ({ ...current, text: event.target.value }))}
                  placeholder="Quero saber o preco do plano"
                  value={simulationForm.text}
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className="text-slate-300">Nome do contato</span>
                <Input
                  className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                  onChange={(event) => setSimulationForm((current) => ({ ...current, contactName: event.target.value }))}
                  value={simulationForm.contactName}
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className="text-slate-300">Numero</span>
                <Input
                  className="border-white/10 bg-white/5 text-white placeholder:text-slate-500"
                  onChange={(event) => setSimulationForm((current) => ({ ...current, phoneNumber: event.target.value }))}
                  value={simulationForm.phoneNumber}
                />
              </label>
              <label className="flex items-center gap-3 rounded-[20px] border border-white/8 bg-white/5 px-4 py-3 text-sm text-slate-300">
                <input
                  checked={simulationForm.isFirstContact}
                  onChange={(event) => setSimulationForm((current) => ({ ...current, isFirstContact: event.target.checked }))}
                  type="checkbox"
                />
                Simular como primeiro contato
              </label>

              <Button disabled={pendingAction !== null || !selectedInstance} onClick={() => void runSimulation()} variant="secondary">
                {pendingAction === "simulate" ? "Simulando..." : "Executar simulacao"}
              </Button>

              <div className="list-row-dark rounded-[24px] p-4 text-sm leading-7 text-slate-300">
                <p className="control-kicker text-slate-400">Variaveis disponiveis</p>
                <p className="mt-3">{`{{nome}} {{numero}} {{data}} {{hora}} {{input}}`}</p>
              </div>

              <div className="list-row-dark rounded-[24px] p-4 text-sm leading-7 text-slate-300">
                <p className="control-kicker text-slate-400">Resultado</p>
                {simulationResult ? (
                  <>
                    <p className="mt-3 text-white">Acao: {simulationResult.action}</p>
                    <p className="mt-2">Regra: {simulationResult.matchedRuleName ?? "Nenhuma regra"}</p>
                    <p className="mt-3 whitespace-pre-wrap rounded-[20px] border border-white/8 bg-black/20 px-4 py-3 text-slate-100">
                      {simulationResult.responseText ?? "Sem resposta"}
                    </p>
                  </>
                ) : (
                  <p className="mt-3">Rode a simulacao para validar a resposta atual da instancia.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="surface-card">
            <CardHeader>
              <CardDescription className="font-[var(--font-mono)] uppercase tracking-[0.24em] text-slate-500">Resumo</CardDescription>
              <CardTitle className="text-2xl text-slate-950">Estado publicado</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-7 text-slate-600">
              <div className="list-row-light rounded-[22px] p-4">
                <p className="control-kicker text-slate-400">Instancia</p>
                <p className="mt-2 text-lg font-semibold text-slate-950">
                  {selectedInstance ? `${selectedInstance.name} / ${selectedInstance.status}` : "Nenhuma instancia selecionada"}
                </p>
              </div>
              <div className="grid gap-3">
                <div className="list-row-light rounded-[22px] p-4">Ultima gravacao: {formatDateTime(lastSavedConfig?.updatedAt)}</div>
                <div className="list-row-light rounded-[22px] p-4">Regras cadastradas: {formState.rules.length}</div>
                <div className="list-row-light rounded-[22px] p-4">
                  Chatbot: {formState.isEnabled ? "habilitado e pronto para responder" : "desabilitado"}
                </div>
                <div className="list-row-light rounded-[22px] p-4">
                  IA:{" "}
                  {formState.ai.isEnabled
                    ? `${formState.ai.mode} / ${formState.ai.provider ?? "aguardando admin"} / ${formState.ai.model || "modelo nao definido"}`
                    : "desabilitada"}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
};
