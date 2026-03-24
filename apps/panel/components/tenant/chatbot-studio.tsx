"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ChatbotAiMode,
  ChatbotConfig,
  ChatbotModules,
  ChatbotRule,
  ChatbotSimulationResult,
  ChatbotTriggerType,
  FiadoTab,
  InstanceSummary
} from "@infracode/types";
import { requestClientApi } from "../../lib/client-api";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Bot, Save, RotateCcw, Play, Plus, Trash2, Server } from "lucide-react";

interface ChatbotStudioProps {
  initialInstances: InstanceSummary[];
}

interface ChatbotFormState {
  isEnabled: boolean;
  welcomeMessage: string;
  fallbackMessage: string;
  humanTakeoverStartMessage: string;
  humanTakeoverEndMessage: string;
  leadsPhoneNumber: string;
  leadsEnabled: boolean;
  fiadoEnabled: boolean;
  audioEnabled: boolean;
  visionEnabled: boolean;
  visionPrompt: string;
  leadAutoExtract: boolean;
  leadVehicleTable: string;
  leadPriceTable: string;
  leadSurchargeTable: string;
  rules: ChatbotRule[];
  ai: {
    isEnabled: boolean;
    mode: ChatbotAiMode;
    provider: "GROQ" | "OPENAI_COMPATIBLE" | null;
    model: string;
    systemPrompt: string;
    temperature: number;
    maxContextMessages: number;
    isManagedByAdmin: boolean;
    isProviderConfigured: boolean;
    isProviderActive: boolean;
  };
  aiFallbackProvider: string;
  aiFallbackApiKey: string;
  aiFallbackModel: string;
  modules: ChatbotModules;
}

interface SimulationFormState {
  text: string;
  isFirstContact: boolean;
  contactName: string;
  phoneNumber: string;
}

type StudioTab = "geral" | "prompt" | "leads" | "fiado" | "modulos" | "ia-reserva" | "estado";

const triggerTypeLabels: Record<ChatbotTriggerType, string> = {
  EXACT: "Exato",
  CONTAINS: "Contém",
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
  humanTakeoverStartMessage: "",
  humanTakeoverEndMessage: "",
  leadsPhoneNumber: "",
  leadsEnabled: true,
  fiadoEnabled: false,
  audioEnabled: false,
  visionEnabled: false,
  visionPrompt: "",
  leadAutoExtract: false,
  leadVehicleTable: "",
  leadPriceTable: "",
  leadSurchargeTable: "",
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
  },
  aiFallbackProvider: "",
  aiFallbackApiKey: "",
  aiFallbackModel: "",
  modules: {}
});

const buildSimulationFormState = (): SimulationFormState => ({
  text: "",
  isFirstContact: false,
  contactName: "Cliente InfraCode",
  phoneNumber: "5511999999999"
});

const formatJsonTextarea = (value?: Record<string, unknown>): string => {
  if (!value || Object.keys(value).length === 0) {
    return "";
  }

  return JSON.stringify(value, null, 2);
};

const parseJsonTextarea = (value: string, label: string): Record<string, unknown> => {
  const trimmed = value.trim();

  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} deve ser um objeto JSON válido.`);
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes("deve ser um objeto JSON válido")) {
      throw error;
    }

    throw new Error(`${label} deve ser um objeto JSON válido.`);
  }
};

const mapConfigToFormState = (config: ChatbotConfig): ChatbotFormState => ({
  isEnabled: config.isEnabled,
  welcomeMessage: config.welcomeMessage ?? "",
  fallbackMessage: config.fallbackMessage ?? "",
  humanTakeoverStartMessage: config.humanTakeoverStartMessage ?? "",
  humanTakeoverEndMessage: config.humanTakeoverEndMessage ?? "",
  leadsPhoneNumber: config.leadsPhoneNumber ?? "",
  leadsEnabled: config.leadsEnabled ?? true,
  fiadoEnabled: config.fiadoEnabled ?? false,
  audioEnabled: config.audioEnabled ?? false,
  visionEnabled: config.visionEnabled ?? false,
  visionPrompt: config.visionPrompt ?? "",
  leadAutoExtract: config.leadAutoExtract ?? false,
  leadVehicleTable: formatJsonTextarea(config.leadVehicleTable),
  leadPriceTable: formatJsonTextarea(config.leadPriceTable),
  leadSurchargeTable: formatJsonTextarea(config.leadSurchargeTable),
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
  },
  aiFallbackProvider: config.aiFallbackProvider ?? "",
  aiFallbackApiKey: config.aiFallbackApiKey ?? "",
  aiFallbackModel: config.aiFallbackModel ?? "",
  modules: config.modules ?? {}
});

const formatDateTime = (value?: string | null): string =>
  value ? new Date(value).toLocaleString("pt-BR") : "Não salvo";

/* ─── Shared input styles ───────────────────────────────────────────── */
const fieldClass = [
  "w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)]",
  "px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
  "transition-[border-color] duration-150",
  "focus:outline-none focus:border-[var(--accent-blue)]"
].join(" ");

const selectClass = [fieldClass, "h-11 cursor-pointer"].join(" ");

const textareaClass = [
  fieldClass,
  "py-3 resize-y font-mono text-xs leading-relaxed",
  "bg-[#0d1117]" // code-editor feel
].join(" ");

/* ─── Tab list ──────────────────────────────────────────────────────── */
const tabs: { id: StudioTab; label: string }[] = [
  { id: "geral", label: "Geral" },
  { id: "prompt", label: "Prompt IA" },
  { id: "leads", label: "Leads" },
  { id: "fiado", label: "Fiado" },
  { id: "modulos", label: "Módulos" },
  { id: "ia-reserva", label: "IA Reserva" },
  { id: "estado", label: "Estado" }
];

/* ─── Main component ────────────────────────────────────────────────── */
export const ChatbotStudio = ({ initialInstances }: ChatbotStudioProps) => {
  const router = useRouter();
  const [instances] = useState(initialInstances);
  const [selectedInstanceId, setSelectedInstanceId] = useState(initialInstances[0]?.id ?? "");
  const [formState, setFormState] = useState<ChatbotFormState>(buildDefaultFormState);
  const [simulationForm, setSimulationForm] = useState<SimulationFormState>(buildSimulationFormState);
  const [lastSavedConfig, setLastSavedConfig] = useState<ChatbotConfig | null>(null);
  const [simulationResult, setSimulationResult] = useState<ChatbotSimulationResult | null>(null);
  const [pendingAction, setPendingAction] = useState<"load" | "save" | "simulate" | "save-leads-phone" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fiadoTabs, setFiadoTabs] = useState<FiadoTab[]>([]);
  const [activeTab, setActiveTab] = useState<StudioTab>("geral");

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
        if (!active) return;
        setLastSavedConfig(config);
        setFormState(mapConfigToFormState(config));
        setSimulationResult(null);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Falha ao carregar o chatbot da instancia.");
        setFormState(buildDefaultFormState());
        setLastSavedConfig(null);
      } finally {
        if (active) setPendingAction(null);
      }
    };

    void loadConfig();
    return () => { active = false; };
  }, [selectedInstanceId]);

  useEffect(() => {
    if (!selectedInstanceId || !formState.fiadoEnabled) {
      setFiadoTabs([]);
      return;
    }

    let active = true;
    requestClientApi<FiadoTab[]>(`/instances/${selectedInstanceId}/fiado`)
      .then((tabs) => { if (active) setFiadoTabs(tabs); })
      .catch(() => { if (active) setFiadoTabs([]); });

    return () => { active = false; };
  }, [selectedInstanceId, formState.fiadoEnabled]);

  const updateRule = (ruleId: string, patch: Partial<ChatbotRule>) => {
    setFormState((current) => ({
      ...current,
      rules: current.rules.map((rule) =>
        rule.id === ruleId
          ? {
            ...rule, ...patch,
            matchValue:
              patch.triggerType === "FIRST_CONTACT" ? null
                : patch.matchValue !== undefined ? patch.matchValue
                  : rule.matchValue
          }
          : rule
      )
    }));
  };

  const addRule = () => setFormState((c) => ({ ...c, rules: [...c.rules, buildEmptyRule()] }));
  const removeRule = (ruleId: string) => setFormState((c) => ({ ...c, rules: c.rules.filter((r) => r.id !== ruleId) }));

  const saveConfig = async () => {
    if (!selectedInstance) return;
    setPendingAction("save"); setError(null); setSuccess(null);
    try {
      const leadVehicleTable = parseJsonTextarea(formState.leadVehicleTable, "Tabela de Veículos (JSON)");
      const leadPriceTable = parseJsonTextarea(formState.leadPriceTable, "Tabela de Preços (JSON)");
      const leadSurchargeTable = parseJsonTextarea(formState.leadSurchargeTable, "Tabela de Acréscimos por Sujeira (JSON)");

      const saved = await requestClientApi<ChatbotConfig>(`/instances/${selectedInstance.id}/chatbot`, {
        method: "PUT",
        body: {
          isEnabled: formState.isEnabled,
          welcomeMessage: formState.welcomeMessage.trim() || null,
          fallbackMessage: formState.fallbackMessage.trim() || null,
          humanTakeoverStartMessage: formState.humanTakeoverStartMessage.trim() || null,
          humanTakeoverEndMessage: formState.humanTakeoverEndMessage.trim() || null,
          leadsPhoneNumber: formState.leadsPhoneNumber.trim() || null,
          leadsEnabled: formState.leadsEnabled,
          fiadoEnabled: formState.fiadoEnabled,
          audioEnabled: formState.audioEnabled,
          visionEnabled: formState.visionEnabled,
          visionPrompt: formState.visionPrompt.trim() || null,
          leadAutoExtract: formState.leadAutoExtract,
          leadVehicleTable,
          leadPriceTable,
          leadSurchargeTable,
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
          },
          aiFallbackProvider: formState.aiFallbackProvider || null,
          aiFallbackApiKey: formState.aiFallbackApiKey.trim() || null,
          aiFallbackModel: formState.aiFallbackModel.trim() || null,
          modules: formState.modules
        }
      });
      setLastSavedConfig(saved);
      setFormState(mapConfigToFormState(saved));
      setSuccess("Chatbot salvo com sucesso.");
      startTransition(() => { router.refresh(); });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao salvar o chatbot.");
    } finally {
      setPendingAction(null);
    }
  };

  const clearFiado = async (phoneNumber: string) => {
    if (!selectedInstance) return;
    try {
      await requestClientApi(`/instances/${selectedInstance.id}/fiado/${phoneNumber}`, { method: "DELETE" });
      setFiadoTabs((current) => current.filter((t) => t.phoneNumber !== phoneNumber));
      setSuccess("Fiado limpo.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao limpar fiado.");
    }
  };

  const runSimulation = async () => {
    if (!selectedInstance) return;
    setPendingAction("simulate"); setError(null); setSuccess(null);
    try {
      const result = await requestClientApi<ChatbotSimulationResult>(`/instances/${selectedInstance.id}/chatbot/simulate`, {
        method: "POST",
        body: { text: simulationForm.text, isFirstContact: simulationForm.isFirstContact, contactName: simulationForm.contactName || undefined, phoneNumber: simulationForm.phoneNumber }
      });
      setSimulationResult(result); setSuccess("Simulação executada.");
    } catch (caught) {

      setError(caught instanceof Error ? caught.message : "Falha ao simular o chatbot.");
    } finally {
      setPendingAction(null);
    }
  };

  if (instances.length === 0) {
    return (
      <EmptyState
        icon={Server}
        label="Conecte uma instância para configurar o chatbot"
        action={{ label: "Ver instâncias", onClick: () => { } }}
      />
    );
  }

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Instance selector + enable toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="text-[10px] uppercase tracking-widest text-[var(--text-tertiary)] font-mono mb-1.5 block">
            Instância
          </label>
          <select
            className={selectClass}
            value={selectedInstanceId}
            onChange={(e) => setSelectedInstanceId(e.target.value)}
          >
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name} — {instance.status}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2.5 cursor-pointer group mt-5">
          <span className="relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors duration-200"
            style={{ background: formState.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
            <input type="checkbox" className="sr-only" checked={formState.isEnabled}
              onChange={(e) => setFormState((c) => ({ ...c, isEnabled: e.target.checked }))} />
            <span className={["inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
              formState.isEnabled ? "translate-x-6" : "translate-x-1"].join(" ")} />
          </span>
          <span className="text-sm text-[var(--text-secondary)] select-none">Chatbot ativo</span>
        </label>
      </div>

      {/* Alert banners */}
      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--accent-red)]/20 bg-[var(--accent-red)]/8 px-4 py-3 text-sm text-[var(--accent-red)]" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-[var(--radius-md)] border border-[var(--accent-green)]/20 bg-[var(--accent-green)]/8 px-4 py-3 text-sm text-[var(--accent-green)]">
          {success}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-0 border-b border-[var(--border-subtle)]" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              "px-4 py-2.5 text-sm font-medium transition-colors duration-150 cursor-pointer",
              "border-b-2 -mb-px focus-visible:outline-none",
              activeTab === tab.id
                ? "border-[var(--accent-blue)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            ].join(" ")}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div role="tabpanel" className="animate-fade-in">

        {/* ── GERAL ─────────────────────────────────────────────────────── */}
        {activeTab === "geral" && (
          <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
            {/* Builder card */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
                <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Builder</p>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Mensagens e regras</h2>
              </div>
              <div className="p-5 space-y-5">
                {/* Welcome */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--text-secondary)]">Boas-vindas</label>
                  <textarea
                    className={[textareaClass, "min-h-[120px]"].join(" ")}
                    value={formState.welcomeMessage}
                    onChange={(e) => setFormState((c) => ({ ...c, welcomeMessage: e.target.value }))}
                    placeholder={`Olá {{nome}}, bem-vindo ao atendimento.`}
                  />
                </div>

                {/* Fallback */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--text-secondary)]">Fallback</label>
                  <textarea
                    className={[textareaClass, "min-h-[100px]"].join(" ")}
                    value={formState.fallbackMessage}
                    onChange={(e) => setFormState((c) => ({ ...c, fallbackMessage: e.target.value }))}
                    placeholder="Não encontrei resposta. Digite suporte para falar com o time."
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--text-secondary)]">
                    Mensagem ao ativar atendimento humano
                  </label>
                  <textarea
                    className={[textareaClass, "min-h-[100px]"].join(" ")}
                    value={formState.humanTakeoverStartMessage}
                    onChange={(e) => setFormState((c) => ({ ...c, humanTakeoverStartMessage: e.target.value }))}
                    placeholder="A partir de agora, seu atendimento será realizado por um especialista da sua empresa..."
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--text-secondary)]">
                    Mensagem ao reativar o bot
                  </label>
                  <textarea
                    className={[textareaClass, "min-h-[100px]"].join(" ")}
                    value={formState.humanTakeoverEndMessage}
                    onChange={(e) => setFormState((c) => ({ ...c, humanTakeoverEndMessage: e.target.value }))}
                    placeholder="Olá! Estou de volta para te ajudar. Como posso te atender?"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <span className="relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors duration-200"
                      style={{ background: formState.audioEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                      <input type="checkbox" className="sr-only" checked={formState.audioEnabled}
                        onChange={(e) => setFormState((c) => ({ ...c, audioEnabled: e.target.checked }))} />
                      <span className={["inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
                        formState.audioEnabled ? "translate-x-6" : "translate-x-1"].join(" ")} />
                    </span>
                    <span className="text-sm text-[var(--text-secondary)] select-none">Transcrição de áudio</span>
                  </label>

                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <span className="relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors duration-200"
                      style={{ background: formState.visionEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                      <input type="checkbox" className="sr-only" checked={formState.visionEnabled}
                        onChange={(e) => setFormState((c) => ({ ...c, visionEnabled: e.target.checked }))} />
                      <span className={["inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
                        formState.visionEnabled ? "translate-x-6" : "translate-x-1"].join(" ")} />
                    </span>
                    <span className="text-sm text-[var(--text-secondary)] select-none">Análise de imagem (visão)</span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--text-secondary)]">
                    Prompt de visão (opcional)
                  </label>
                  <input
                    type="text"
                    className={[fieldClass, "h-11"].join(" ")}
                    placeholder="Descreva o que vê na imagem focando em..."
                    value={formState.visionPrompt}
                    onChange={(e) => setFormState((c) => ({ ...c, visionPrompt: e.target.value }))}
                  />
                </div>

                {/* Rules */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">
                      Regras <span className="text-[var(--text-tertiary)] font-normal">({formState.rules.length})</span>
                    </p>
                    <Button variant="secondary" size="sm" onClick={addRule}>
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" /> Nova regra
                    </Button>
                  </div>

                  {formState.rules.length === 0 ? (
                    <p className="text-xs text-[var(--text-tertiary)] px-1">Nenhuma regra cadastrada ainda.</p>
                  ) : (
                    <div className="grid gap-3">
                      {formState.rules.map((rule, idx) => (
                        <div key={rule.id} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-4 space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] uppercase tracking-widest text-[var(--text-tertiary)] font-mono">
                              Regra {idx + 1}
                            </span>
                            <div className="flex items-center gap-2">
                              <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
                                <input type="checkbox" checked={rule.isActive}
                                  onChange={(e) => updateRule(rule.id, { isActive: e.target.checked })}
                                  className="accent-[var(--accent-blue)]" />
                                Ativa
                              </label>
                              <button onClick={() => removeRule(rule.id)} aria-label="Remover regra"
                                className="text-[var(--text-tertiary)] hover:text-[var(--accent-red)] transition-colors cursor-pointer">
                                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <div>
                              <label className="text-xs text-[var(--text-secondary)] mb-1 block">Nome</label>
                              <input type="text" className={[fieldClass, "h-9"].join(" ")} value={rule.name}
                                onChange={(e) => updateRule(rule.id, { name: e.target.value })} />
                            </div>
                            <div>
                              <label className="text-xs text-[var(--text-secondary)] mb-1 block">Trigger</label>
                              <select className={[selectClass, "h-9"].join(" ")} value={rule.triggerType}
                                onChange={(e) => updateRule(rule.id, {
                                  triggerType: e.target.value as ChatbotTriggerType,
                                  matchValue: e.target.value === "FIRST_CONTACT" ? null : rule.matchValue ?? ""
                                })}>
                                {Object.entries(triggerTypeLabels).map(([v, l]) => (
                                  <option key={v} value={v}>{l}</option>
                                ))}
                              </select>
                            </div>
                          </div>

                          {rule.triggerType !== "FIRST_CONTACT" && (
                            <div>
                              <label className="text-xs text-[var(--text-secondary)] mb-1 block">Match</label>
                              <input type="text" className={[fieldClass, "h-9"].join(" ")} value={rule.matchValue ?? ""}
                                placeholder={rule.triggerType === "REGEX" ? "^preco|valor$" : "preco"}
                                onChange={(e) => updateRule(rule.id, { matchValue: e.target.value })} />
                            </div>
                          )}

                          <div>
                            <label className="text-xs text-[var(--text-secondary)] mb-1 block">Resposta</label>
                            <textarea className={[textareaClass, "min-h-[80px]"].join(" ")} value={rule.responseText}
                              placeholder="Nosso plano parte de R$ 99/mês."
                              onChange={(e) => updateRule(rule.id, { responseText: e.target.value })} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Sticky save bar */}
              <div className="sticky bottom-0 px-5 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-center gap-3">
                <Button variant="primary" size="md" loading={pendingAction === "save"} disabled={pendingAction !== null || !selectedInstance} onClick={() => void saveConfig()}>
                  <Save aria-hidden="true" className="h-3.5 w-3.5" /> Salvar chatbot
                </Button>
                <Button variant="ghost" size="md" disabled={pendingAction !== null}
                  onClick={() => { setFormState(lastSavedConfig ? mapConfigToFormState(lastSavedConfig) : buildDefaultFormState()); setError(null); setSuccess(null); }}>
                  <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /> Reverter
                </Button>
              </div>
            </div>

            {/* Simulation card */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
                <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Simulação</p>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Teste antes de ativar</h2>
              </div>
              <div className="p-5 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-[var(--text-secondary)]">Texto de entrada</label>
                  <textarea
                    className={[textareaClass, "min-h-[100px]"].join(" ")}
                    value={simulationForm.text}
                    onChange={(e) => setSimulationForm((c) => ({ ...c, text: e.target.value }))}
                    placeholder="Quero saber o preço do plano"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Nome</label>
                    <input type="text" className={[fieldClass, "h-9"].join(" ")} value={simulationForm.contactName}
                      onChange={(e) => setSimulationForm((c) => ({ ...c, contactName: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Número</label>
                    <input type="text" className={[fieldClass, "h-9"].join(" ")} value={simulationForm.phoneNumber}
                      onChange={(e) => setSimulationForm((c) => ({ ...c, phoneNumber: e.target.value }))} />
                  </div>
                </div>
                <label className="flex items-center gap-2.5 text-xs text-[var(--text-secondary)] cursor-pointer">
                  <input type="checkbox" className="accent-[var(--accent-blue)]" checked={simulationForm.isFirstContact}
                    onChange={(e) => setSimulationForm((c) => ({ ...c, isFirstContact: e.target.checked }))} />
                  Simular como primeiro contato
                </label>
                <Button variant="secondary" size="md" loading={pendingAction === "simulate"}
                  disabled={pendingAction !== null || !selectedInstance} onClick={() => void runSimulation()}>
                  <Play aria-hidden="true" className="h-3.5 w-3.5" /> Executar simulação
                </Button>

                {/* Variables */}
                <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-widest text-[var(--text-tertiary)] font-mono mb-2">Variáveis</p>
                  <p className="font-mono text-xs text-[var(--text-secondary)]">{`{{nome}} {{numero}} {{data}} {{hora}} {{input}}`}</p>
                </div>

                {/* Result */}
                <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-widest text-[var(--text-tertiary)] font-mono mb-2">Resultado</p>
                  {simulationResult ? (
                    <div className="space-y-2 text-xs">
                      <p className="text-[var(--text-secondary)]">Ação: <span className="text-[var(--text-primary)]">{simulationResult.action}</span></p>
                      <p className="text-[var(--text-secondary)]">Regra: <span className="text-[var(--text-primary)]">{simulationResult.matchedRuleName ?? "Nenhuma"}</span></p>
                      <pre className="mt-2 whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[#0d1117] p-3 text-xs text-[var(--text-primary)] font-mono leading-relaxed overflow-auto">
                        {simulationResult.responseText ?? "Sem resposta"}
                      </pre>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--text-tertiary)]">Execute a simulação para ver o resultado.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── PROMPT IA ─────────────────────────────────────────────────── */}
        {activeTab === "prompt" && (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden max-w-3xl">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">IA gerenciada</p>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Prompt do sistema</h2>
            </div>
            <div className="p-5 space-y-5">
              {/* AI status info row */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Provedor", value: formState.ai.provider ?? "Não configurado" },
                  { label: "Modelo", value: formState.ai.model || "Gerenciado pelo admin" },
                  { label: "Status", value: formState.ai.isProviderConfigured ? (formState.ai.isProviderActive ? "Ativo" : "Inativo") : "Aguardando admin" }
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-4 py-3">
                    <p className="text-[10px] uppercase tracking-widest text-[var(--text-tertiary)] font-mono">{label}</p>
                    <p className="text-sm font-semibold text-[var(--text-primary)] mt-1 truncate">{value}</p>
                  </div>
                ))}
              </div>

              {!formState.ai.isProviderConfigured && (
                <div className="rounded-[var(--radius-md)] border border-[var(--accent-yellow)]/20 bg-[var(--accent-yellow)]/8 px-4 py-3 text-sm text-[var(--accent-yellow)]">
                  A InfraCode ainda não vinculou um provedor de IA. Salve o prompt para quando ficar disponível.
                </div>
              )}

              {/* Enable AI toggle */}
              <label className="flex items-center gap-3 cursor-pointer">
                <span className="relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors duration-200"
                  style={{ background: formState.ai.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                  <input type="checkbox" className="sr-only" checked={formState.ai.isEnabled}
                    onChange={(e) => setFormState((c) => ({ ...c, ai: { ...c.ai, isEnabled: e.target.checked } }))} />
                  <span className={["inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
                    formState.ai.isEnabled ? "translate-x-6" : "translate-x-1"].join(" ")} />
                </span>
                <span className="text-sm text-[var(--text-secondary)] select-none">Responder com IA</span>
              </label>

              {/* Mode + params */}
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Modo</label>
                  <select className={selectClass} value={formState.ai.mode}
                    onChange={(e) => setFormState((c) => ({ ...c, ai: { ...c.ai, mode: e.target.value as ChatbotAiMode } }))}>
                    <option value="RULES_ONLY">Somente regras</option>
                    <option value="RULES_THEN_AI">Regras → IA</option>
                    <option value="AI_ONLY">Somente IA</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Temperatura</label>
                  <input type="number" step="0.1" min="0" max="2" className={[fieldClass, "h-11"].join(" ")}
                    value={formState.ai.temperature}
                    onChange={(e) => setFormState((c) => ({ ...c, ai: { ...c.ai, temperature: Number(e.target.value || 0) } }))} />
                </div>
                <div>
                  <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Contexto máx.</label>
                  <input type="number" min="1" className={[fieldClass, "h-11"].join(" ")}
                    value={formState.ai.maxContextMessages}
                    onChange={(e) => setFormState((c) => ({ ...c, ai: { ...c.ai, maxContextMessages: Number(e.target.value || 1) } }))} />
                </div>
              </div>

              {/* System prompt */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-[var(--text-secondary)]">System prompt</label>
                  <span className="text-[10px] font-mono text-[var(--text-tertiary)]">{formState.ai.systemPrompt.length} chars</span>
                </div>
                <textarea
                  className={[textareaClass, "min-h-[200px]"].join(" ")}
                  value={formState.ai.systemPrompt}
                  placeholder="Você é um assistente virtual comercial..."
                  onChange={(e) => setFormState((c) => ({ ...c, ai: { ...c.ai, systemPrompt: e.target.value } }))}
                />
              </div>

              <div className="flex gap-3 pt-1">
                <Button variant="primary" size="md" loading={pendingAction === "save"}
                  disabled={pendingAction !== null || !selectedInstance} onClick={() => void saveConfig()}>
                  <Save aria-hidden="true" className="h-3.5 w-3.5" /> Salvar
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── LEADS ─────────────────────────────────────────────────────── */}
        {activeTab === "leads" && (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden max-w-xl">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Leads</p>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Notificações de lead</h2>
            </div>
            <div className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Número para alertas</label>
                <input type="text" className={[fieldClass, "h-11"].join(" ")} placeholder="5511999999999"
                  value={formState.leadsPhoneNumber}
                  onChange={(e) => setFormState((c) => ({ ...c, leadsPhoneNumber: e.target.value }))} />
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer">
                <span className="relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors duration-200"
                  style={{ background: formState.leadsEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                  <input type="checkbox" className="sr-only" checked={formState.leadsEnabled}
                    onChange={(e) => setFormState((c) => ({ ...c, leadsEnabled: e.target.checked }))} />
                  <span className={["inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
                    formState.leadsEnabled ? "translate-x-6" : "translate-x-1"].join(" ")} />
                </span>
                <span className="text-sm text-[var(--text-secondary)] select-none">Enviar resumo de leads</span>
              </label>

              <div className="space-y-2">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <span className="relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors duration-200"
                    style={{ background: formState.leadAutoExtract ? "var(--accent-green)" : "var(--bg-active)" }}>
                    <input type="checkbox" className="sr-only" checked={formState.leadAutoExtract}
                      onChange={(e) => setFormState((c) => ({ ...c, leadAutoExtract: e.target.checked }))} />
                    <span className={["inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
                      formState.leadAutoExtract ? "translate-x-6" : "translate-x-1"].join(" ")} />
                  </span>
                  <span className="text-sm text-[var(--text-secondary)] select-none">Extração automática de lead</span>
                </label>
                <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                  O sistema detecta automaticamente Nome, Veículo e Serviço na conversa e envia o lead sem depender da IA gerar o bloco
                </p>
              </div>

              {formState.leadAutoExtract && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-[var(--text-secondary)]">Tabela de Veículos (JSON)</label>
                    <textarea
                      className={[textareaClass, "min-h-[180px]"].join(" ")}
                      placeholder='{"civic": "Médio", "hilux": "Grande", "onix": "Pequeno"}'
                      value={formState.leadVehicleTable}
                      onChange={(e) => setFormState((c) => ({ ...c, leadVehicleTable: e.target.value }))}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-[var(--text-secondary)]">Tabela de Preços (JSON)</label>
                    <textarea
                      className={[textareaClass, "min-h-[180px]"].join(" ")}
                      placeholder='{"Pequeno": {"Essencial": 120, "Completa": 150, "Detalhada": 360}, "Médio": {...}}'
                      value={formState.leadPriceTable}
                      onChange={(e) => setFormState((c) => ({ ...c, leadPriceTable: e.target.value }))}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-[var(--text-secondary)]">Tabela de Acréscimos por Sujeira (JSON)</label>
                    <textarea
                      className={[textareaClass, "min-h-[180px]"].join(" ")}
                      placeholder='{"Pequeno": {"Média": 30, "Pesada": 60}, "Médio": {"Média": 50, "Pesada": 100}}'
                      value={formState.leadSurchargeTable}
                      onChange={(e) => setFormState((c) => ({ ...c, leadSurchargeTable: e.target.value }))}
                    />
                  </div>
                </>
              )}

              <label className="flex items-center gap-2.5 cursor-pointer">
                <span className="relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors duration-200"
                  style={{ background: formState.fiadoEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                  <input type="checkbox" className="sr-only" checked={formState.fiadoEnabled}
                    onChange={(e) => setFormState((c) => ({ ...c, fiadoEnabled: e.target.checked }))} />
                  <span className={["inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
                    formState.fiadoEnabled ? "translate-x-6" : "translate-x-1"].join(" ")} />
                </span>
                <span className="text-sm text-[var(--text-secondary)] select-none">Ativar controle de fiado</span>
              </label>

              <Button variant="primary" size="md" loading={pendingAction === "save"}
                disabled={pendingAction !== null || !selectedInstance} onClick={() => void saveConfig()}>
                <Save aria-hidden="true" className="h-3.5 w-3.5" /> Salvar configuração de leads
              </Button>
            </div>
          </div>
        )}

        {/* ── FIADO ─────────────────────────────────────────────────────── */}
        {activeTab === "fiado" && (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden max-w-xl">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Fiado</p>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Contas em aberto</h2>
            </div>
            <div className="p-5 space-y-3">
              {!formState.fiadoEnabled ? (
                <p className="text-sm text-[var(--text-tertiary)]">Ative o controle de fiado na aba Leads para ver as contas.</p>
              ) : fiadoTabs.length === 0 ? (
                <p className="text-sm text-[var(--text-tertiary)]">Nenhuma conta em aberto.</p>
              ) : (
                fiadoTabs.map((tab) => (
                  <div key={tab.phoneNumber}
                    className="flex items-center justify-between gap-4 px-4 py-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] hover:border-[var(--border-default)] transition-colors">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{tab.displayName ?? tab.phoneNumber}</p>
                      <p className="text-xs text-[var(--text-tertiary)] font-mono">{tab.phoneNumber} · {tab.items.length} item(s)</p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">
                        R$ {tab.total.toFixed(2).replace(".", ",")}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => void clearFiado(tab.phoneNumber)}>
                        Pago
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ── IA RESERVA ────────────────────────────────────────────────── */}
        {activeTab === "ia-reserva" && (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden max-w-xl">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Fallback de IA</p>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Provider reserva</h2>
            </div>
            <div className="p-5 space-y-5">
              <div className="rounded-[var(--radius-md)] border border-[var(--accent-blue)]/20 bg-[var(--accent-blue)]/8 px-4 py-3 text-sm text-[var(--text-secondary)]">
                Usado automaticamente se o provider principal configurado no painel admin falhar com erro 429 (rate limit) ou 5xx.
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Provider reserva</label>
                <select
                  className={selectClass}
                  value={formState.aiFallbackProvider}
                  onChange={(e) => setFormState((c) => ({ ...c, aiFallbackProvider: e.target.value }))}
                >
                  <option value="">Nenhum</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                  <option value="ollama">Ollama</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">API Key do provider reserva</label>
                <input
                  type="password"
                  className={[fieldClass, "h-11"].join(" ")}
                  placeholder={formState.aiFallbackProvider === "ollama" ? "Nao se aplica para Ollama" : "sk-..."}
                  value={formState.aiFallbackApiKey}
                  onChange={(e) => setFormState((c) => ({ ...c, aiFallbackApiKey: e.target.value }))}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Modelo reserva</label>
                <input
                  type="text"
                  className={[fieldClass, "h-11"].join(" ")}
                  placeholder={
                    formState.aiFallbackProvider === "gemini"
                        ? "gemini-2.0-flash"
                        : formState.aiFallbackProvider === "ollama"
                          ? "llama3.1:8b"
                          : "gpt-4o-mini"
                  }
                  value={formState.aiFallbackModel}
                  onChange={(e) => setFormState((c) => ({ ...c, aiFallbackModel: e.target.value }))}
                />
                <p className="text-[10px] text-[var(--text-tertiary)]">
                  {formState.aiFallbackProvider === "gemini"
                      ? "Ex: gemini-2.0-flash, gemini-1.5-flash"
                      : formState.aiFallbackProvider === "ollama"
                        ? "Ex: llama3.1:8b, qwen2.5:7b. Usa OLLAMA_HOST no backend."
                        : "Ex: gpt-4o-mini, gpt-4o"}
                </p>
              </div>

              <div className="flex gap-3 pt-1">
                <Button variant="primary" size="md" loading={pendingAction === "save"}
                  disabled={pendingAction !== null || !selectedInstance} onClick={() => void saveConfig()}>
                  <Save aria-hidden="true" className="h-3.5 w-3.5" /> Salvar
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── MÓDULOS ───────────────────────────────────────────────────── */}
        {activeTab === "modulos" && (
          <div className="space-y-5 max-w-4xl">
            {/* 💬 Atendimento */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <span className="text-lg">💬</span>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Atendimento</h2>
              </div>
              <div className="p-5 grid gap-4 sm:grid-cols-2">
                {[
                  { key: "faq", label: "FAQ Automático", desc: "Responde perguntas frequentes configuradas" },
                  { key: "horarioAtendimento", label: "Horário de Atendimento", desc: "Mensagem automática fora do horário" },
                  { key: "antiSpam", label: "Anti-spam", desc: "Ignora mensagens repetidas" },
                  { key: "multiIdioma", label: "Multi-idioma", desc: "Detecta e responde no mesmo idioma" }
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-start justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{desc}</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
                        style={{ background: formState.modules[key as keyof ChatbotModules]?.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                        <input type="checkbox" className="sr-only"
                          checked={formState.modules[key as keyof ChatbotModules]?.isEnabled ?? false}
                          onChange={(e) => setFormState((c) => ({
                            ...c,
                            modules: { ...c.modules, [key]: { ...c.modules[key as keyof ChatbotModules], isEnabled: e.target.checked } }
                          }))} />
                        <span className={["inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                          formState.modules[key as keyof ChatbotModules]?.isEnabled ? "translate-x-5" : "translate-x-1"].join(" ")} />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* 📅 Agendamento */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <span className="text-lg">📅</span>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Agendamento</h2>
              </div>
              <div className="p-5 grid gap-4 sm:grid-cols-2">
                {[
                  { key: "agenda", label: "Agenda Inteligente", desc: "Horários disponíveis sem duplo agendamento" },
                  { key: "lembrete", label: "Lembrete Automático", desc: "Envia lembrete X horas antes" },
                  { key: "confirmacaoPresenca", label: "Confirmação de Presença", desc: "Pergunta se vai comparecer" },
                  { key: "cancelamentoReagendamento", label: "Cancel./Reagendamento", desc: "Cliente muda pelo WhatsApp" }
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-start justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{desc}</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
                        style={{ background: formState.modules[key as keyof ChatbotModules]?.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                        <input type="checkbox" className="sr-only"
                          checked={formState.modules[key as keyof ChatbotModules]?.isEnabled ?? false}
                          onChange={(e) => setFormState((c) => ({
                            ...c,
                            modules: { ...c.modules, [key]: { ...c.modules[key as keyof ChatbotModules], isEnabled: e.target.checked } }
                          }))} />
                        <span className={["inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                          formState.modules[key as keyof ChatbotModules]?.isEnabled ? "translate-x-5" : "translate-x-1"].join(" ")} />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* 💰 Financeiro */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <span className="text-lg">💰</span>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Financeiro</h2>
              </div>
              <div className="p-5 grid gap-4 sm:grid-cols-2">
                {[
                  { key: "cobrancaAutomatica", label: "Cobrança Automática", desc: "Extrato → PIX → confirma pagamento" },
                  { key: "notificacaoVencimento", label: "Notificação de Vencimento", desc: "Lembra cliente de dívida próxima" },
                  { key: "orcamentoRapido", label: "Orçamento Rápido", desc: "Gera orçamento baseado em tabela" }
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-start justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{desc}</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
                        style={{ background: formState.modules[key as keyof ChatbotModules]?.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                        <input type="checkbox" className="sr-only"
                          checked={formState.modules[key as keyof ChatbotModules]?.isEnabled ?? false}
                          onChange={(e) => setFormState((c) => ({
                            ...c,
                            modules: { ...c.modules, [key]: { ...c.modules[key as keyof ChatbotModules], isEnabled: e.target.checked } }
                          }))} />
                        <span className={["inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                          formState.modules[key as keyof ChatbotModules]?.isEnabled ? "translate-x-5" : "translate-x-1"].join(" ")} />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* 📦 Catálogo & Pedidos */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <span className="text-lg">📦</span>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Catálogo & Pedidos</h2>
              </div>
              <div className="p-5 grid gap-4 sm:grid-cols-2">
                {[
                  { key: "catalogo", label: "Cardápio/Catálogo", desc: "Mostra produtos configurados" },
                  { key: "pedidoWhatsApp", label: "Pedido pelo WhatsApp", desc: "Cliente monta pedido" },
                  { key: "statusPedido", label: "Status do Pedido", desc: "Cliente consulta status" },
                  { key: "envioMidia", label: "Envio de Mídia", desc: "PDF, imagem, áudio por gatilho" }
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-start justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{desc}</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
                        style={{ background: formState.modules[key as keyof ChatbotModules]?.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                        <input type="checkbox" className="sr-only"
                          checked={formState.modules[key as keyof ChatbotModules]?.isEnabled ?? false}
                          onChange={(e) => setFormState((c) => ({
                            ...c,
                            modules: { ...c.modules, [key]: { ...c.modules[key as keyof ChatbotModules], isEnabled: e.target.checked } }
                          }))} />
                        <span className={["inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                          formState.modules[key as keyof ChatbotModules]?.isEnabled ? "translate-x-5" : "translate-x-1"].join(" ")} />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* 📊 Dados & CRM */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <span className="text-lg">📊</span>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Dados & CRM</h2>
              </div>
              <div className="p-5 grid gap-4 sm:grid-cols-2">
                {[
                  { key: "capturaDados", label: "Captura de Dados", desc: "Coleta nome, email, interesse" },
                  { key: "nps", label: "NPS", desc: "Pesquisa de satisfação pós-atendimento" },
                  { key: "tagFollowUp", label: "Tag de Follow-up", desc: "Salva quem não fechou" },
                  { key: "exportarLeads", label: "Exportar Leads", desc: "Exporta base pelo painel" }
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-start justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{desc}</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
                        style={{ background: formState.modules[key as keyof ChatbotModules]?.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                        <input type="checkbox" className="sr-only"
                          checked={formState.modules[key as keyof ChatbotModules]?.isEnabled ?? false}
                          onChange={(e) => setFormState((c) => ({
                            ...c,
                            modules: { ...c.modules, [key]: { ...c.modules[key as keyof ChatbotModules], isEnabled: e.target.checked } }
                          }))} />
                        <span className={["inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                          formState.modules[key as keyof ChatbotModules]?.isEnabled ? "translate-x-5" : "translate-x-1"].join(" ")} />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* 🔗 Integrações */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <span className="text-lg">🔗</span>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Integrações</h2>
              </div>
              <div className="p-5 grid gap-4 sm:grid-cols-2">
                {[
                  { key: "webhook", label: "Webhook de Saída", desc: "Dispara evento para sistema externo" },
                  { key: "webhookBidirecional", label: "Webhook Bidirecional", desc: "Sistema externo responde" },
                  { key: "googleCalendar", label: "Google Calendar", desc: "Cria evento ao agendar" },
                  { key: "planilhaGoogle", label: "Planilha Google", desc: "Registra leads/pedidos" }
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-start justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{desc}</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
                        style={{ background: formState.modules[key as keyof ChatbotModules]?.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                        <input type="checkbox" className="sr-only"
                          checked={formState.modules[key as keyof ChatbotModules]?.isEnabled ?? false}
                          onChange={(e) => setFormState((c) => ({
                            ...c,
                            modules: { ...c.modules, [key]: { ...c.modules[key as keyof ChatbotModules], isEnabled: e.target.checked } }
                          }))} />
                        <span className={["inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                          formState.modules[key as keyof ChatbotModules]?.isEnabled ? "translate-x-5" : "translate-x-1"].join(" ")} />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* 🛡️ Controle */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <span className="text-lg">🛡️</span>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Controle</h2>
              </div>
              <div className="p-5 grid gap-4 sm:grid-cols-2">
                {[
                  { key: "listaBranca", label: "Lista Branca", desc: "Só responde para números cadastrados" },
                  { key: "blacklist", label: "Blacklist", desc: "Bloqueia números específicos" },
                  { key: "limiteMensagens", label: "Limite de Mensagens", desc: "Evita flood por contato" },
                  { key: "palavraPausa", label: "Palavra de Pausa", desc: "Cliente digita 'sair' e para" }
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-start justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{desc}</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
                        style={{ background: formState.modules[key as keyof ChatbotModules]?.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                        <input type="checkbox" className="sr-only"
                          checked={formState.modules[key as keyof ChatbotModules]?.isEnabled ?? false}
                          onChange={(e) => setFormState((c) => ({
                            ...c,
                            modules: { ...c.modules, [key]: { ...c.modules[key as keyof ChatbotModules], isEnabled: e.target.checked } }
                          }))} />
                        <span className={["inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                          formState.modules[key as keyof ChatbotModules]?.isEnabled ? "translate-x-5" : "translate-x-1"].join(" ")} />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* 🎯 Marketing */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2">
                <span className="text-lg">🎯</span>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">Marketing</h2>
              </div>
              <div className="p-5 grid gap-4 sm:grid-cols-2">
                {[
                  { key: "disparoMassa", label: "Disparo em Massa", desc: "Envia para lista de contatos" },
                  { key: "campanhaSegmento", label: "Campanha por Segmento", desc: "Dispara para clientes com tag" },
                  { key: "reativacao", label: "Reativação Automática", desc: "Mensagem para cliente inativo" },
                  { key: "cupomPromocao", label: "Cupom/Promoção", desc: "Envia desconto por gatilho" }
                ].map(({ key, label, desc }) => (
                  <div key={key} className="flex items-start justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{desc}</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
                      <span className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
                        style={{ background: formState.modules[key as keyof ChatbotModules]?.isEnabled ? "var(--accent-green)" : "var(--bg-active)" }}>
                        <input type="checkbox" className="sr-only"
                          checked={formState.modules[key as keyof ChatbotModules]?.isEnabled ?? false}
                          onChange={(e) => setFormState((c) => ({
                            ...c,
                            modules: { ...c.modules, [key]: { ...c.modules[key as keyof ChatbotModules], isEnabled: e.target.checked } }
                          }))} />
                        <span className={["inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                          formState.modules[key as keyof ChatbotModules]?.isEnabled ? "translate-x-5" : "translate-x-1"].join(" ")} />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Save button */}
            <div className="flex gap-3">
              <Button variant="primary" size="md" loading={pendingAction === "save"}
                disabled={pendingAction !== null || !selectedInstance} onClick={() => void saveConfig()}>
                <Save aria-hidden="true" className="h-3.5 w-3.5" /> Salvar módulos
              </Button>
            </div>
          </div>
        )}

        {/* ── ESTADO ────────────────────────────────────────────────────── */}
        {activeTab === "estado" && (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-hidden max-w-xl">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
              <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-tertiary)] mb-1">Estado publicado</p>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">Configuração salva</h2>
            </div>
            <div className="p-5 space-y-2 text-sm">
                {[
                { label: "Instância", value: selectedInstance ? `${selectedInstance.name} — ${selectedInstance.status}` : "—" },
                { label: "Última gravação", value: formatDateTime(lastSavedConfig?.updatedAt) },
                { label: "Regras", value: String(formState.rules.length) },
                { label: "Chatbot", value: formState.isEnabled ? "Habilitado" : "Desabilitado" },
                { label: "IA", value: formState.ai.isEnabled ? `${formState.ai.mode} · ${formState.ai.provider ?? "aguardando admin"}` : "Desabilitada" },
                { label: "IA Reserva", value: lastSavedConfig?.aiFallbackProvider ? `${lastSavedConfig.aiFallbackProvider} · ${lastSavedConfig.aiFallbackModel || "padrão"}` : "Não configurado" },
                { label: "Alertas lead", value: lastSavedConfig?.leadsPhoneNumber || "Não configurado" },
                { label: "Resumo leads", value: lastSavedConfig?.leadsEnabled !== false ? "Ativo" : "Inativo" },
                { label: "Fiado", value: lastSavedConfig?.fiadoEnabled ? "Ativo" : "Inativo" },
                { label: "Áudio", value: lastSavedConfig?.audioEnabled ? "Ativo" : "Inativo" },
                { label: "Visão (imagem)", value: lastSavedConfig?.visionEnabled ? "Ativo" : "Inativo" },
                { label: "Módulos ativos", value: String(Object.values(formState.modules).filter(m => m?.isEnabled).length) }
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between px-4 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                  <span className="text-[var(--text-tertiary)] text-xs font-mono uppercase tracking-wide">{label}</span>
                  <span className="text-[var(--text-primary)] text-xs font-semibold text-right truncate ml-4 max-w-[60%]">{value}</span>
                </div>
              ))}

              {/* Badge summary */}
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge variant={formState.isEnabled ? "success" : "neutral"}>
                  {formState.isEnabled ? "Chatbot ON" : "Chatbot OFF"}
                </Badge>
                <Badge variant={formState.ai.isEnabled ? "info" : "neutral"}>
                  {formState.ai.isEnabled ? "IA ON" : "IA OFF"}
                </Badge>
                <Badge variant={formState.aiFallbackProvider ? "warning" : "neutral"}>
                  {formState.aiFallbackProvider ? `IA Reserva: ${formState.aiFallbackProvider}` : "IA Reserva OFF"}
                </Badge>
                <Badge variant={formState.leadsEnabled ? "success" : "neutral"}>
                  {formState.leadsEnabled ? "Leads ON" : "Leads OFF"}
                </Badge>
                <Badge variant={formState.fiadoEnabled ? "warning" : "neutral"}>
                  {formState.fiadoEnabled ? "Fiado ON" : "Fiado OFF"}
                </Badge>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

