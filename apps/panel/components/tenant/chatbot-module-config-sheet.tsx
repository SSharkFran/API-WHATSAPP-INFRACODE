"use client";

import type { ChatbotModuleKey, ChatbotModules } from "@infracode/types";
import { CHATBOT_MODULE_CATALOG } from "@infracode/types";
import { X } from "lucide-react";
import { Button } from "../ui/Button";

const fieldClass = [
  "w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)]",
  "px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
  "transition-[border-color] duration-150",
  "focus:outline-none focus:border-[var(--accent-blue)]"
].join(" ");

const textareaClass = [
  fieldClass,
  "min-h-[120px] py-3 resize-y font-mono text-xs leading-relaxed",
  "bg-[#0d1117]"
].join(" ");

const checkboxPillClass =
  "flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-secondary)]";

const parseLines = (value: string): string[] =>
  value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

const joinLines = (value?: string[]): string => (value ?? []).join("\n");

const executionModeMeta = {
  runtime: {
    badge: "Runtime",
    tone: "success" as const,
    description: "Executa diretamente no backend durante o fluxo da conversa."
  },
  prompt: {
    badge: "Prompt IA",
    tone: "info" as const,
    description: "Injeta instruções no prompt da IA. O efeito depende do modelo respeitar essas instruções."
  },
  tool: {
    badge: "Tool",
    tone: "info" as const,
    description: "Expõe uma integração real para a IA usar. Exige credenciais válidas e contexto suficiente."
  },
  placeholder: {
    badge: "Placeholder",
    tone: "warning" as const,
    description: "Ainda não possui execução funcional no runtime do chatbot."
  }
};

export const buildDefaultChatbotModuleConfig = (moduleKey: ChatbotModuleKey): NonNullable<ChatbotModules[ChatbotModuleKey]> => {
  switch (moduleKey) {
    case "faq":
      return { isEnabled: false, faqs: [] };
    case "horarioAtendimento":
      return {
        isEnabled: false,
        horarioInicio: "09:00",
        horarioFim: "18:00",
        diasSemana: [1, 2, 3, 4, 5],
        mensagemForaHorario: "Estamos fora do horário de atendimento no momento.",
        timezone: "America/Sao_Paulo"
      };
    case "antiSpam":
      return { isEnabled: false, intervaloMinutos: 5, maxMensagens: 3 };
    case "multiIdioma":
      return { isEnabled: false, idiomasPermitidos: ["pt-BR"], idiomaPrincipal: "pt-BR" };
    case "agenda":
      return {
        isEnabled: false,
        horariosDisponiveis: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
        duracaoMinutos: 60,
        mensagemConfirmacao: "Agendamento confirmado."
      };
    case "googleCalendar":
      return { isEnabled: false, clientId: "", clientSecret: "", refreshToken: "", calendarId: "" };
    case "listaBranca":
      return { isEnabled: false, numeros: [], modo: "permitir_lista" };
    case "blacklist":
      return { isEnabled: false, numeros: [] };
    case "limiteMensagens":
      return { isEnabled: false, maxPorHora: 20, maxPorDia: 100 };
    case "palavraPausa":
      return { isEnabled: false, palavras: ["sair", "parar", "atendente"], mensagemPausa: "Tudo bem. Vou pausar o atendimento automático por aqui." };
    default:
      return { isEnabled: false };
  }
};

interface ChatbotModuleConfigSheetProps {
  moduleKey: ChatbotModuleKey | null;
  modules: ChatbotModules;
  onChange: (moduleKey: ChatbotModuleKey, nextValue: NonNullable<ChatbotModules[ChatbotModuleKey]>) => void;
  onClose: () => void;
}

export const ChatbotModuleConfigSheet = ({
  moduleKey,
  modules,
  onChange,
  onClose
}: ChatbotModuleConfigSheetProps) => {
  if (!moduleKey) {
    return null;
  }

  const moduleDefinition = CHATBOT_MODULE_CATALOG.find((module) => module.key === moduleKey);

  if (!moduleDefinition) {
    return null;
  }

  const currentConfig = {
    ...buildDefaultChatbotModuleConfig(moduleKey),
    ...((modules[moduleKey] as Record<string, unknown> | undefined) ?? {})
  } as NonNullable<ChatbotModules[ChatbotModuleKey]>;

  const updateConfig = (nextValue: NonNullable<ChatbotModules[ChatbotModuleKey]>) => {
    onChange(moduleKey, nextValue);
  };
  const executionModeInfo = executionModeMeta[moduleDefinition.executionMode];

  const renderOperationalForm = () => {
    switch (moduleKey) {
      case "faq": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["faq"]>;

        return (
          <div className="space-y-3">
            {moduleConfig.faqs.map((faq, index) => (
              <div key={`${faq.pergunta}-${index}`} className="space-y-2 rounded-[18px] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-4">
                <input
                  className={[fieldClass, "h-11"].join(" ")}
                  placeholder="Pergunta"
                  value={faq.pergunta}
                  onChange={(event) =>
                    updateConfig({
                      ...moduleConfig,
                      faqs: moduleConfig.faqs.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, pergunta: event.target.value } : item
                      )
                    })
                  }
                />
                <textarea
                  className={textareaClass}
                  placeholder="Resposta"
                  value={faq.resposta}
                  onChange={(event) =>
                    updateConfig({
                      ...moduleConfig,
                      faqs: moduleConfig.faqs.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, resposta: event.target.value } : item
                      )
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    updateConfig({
                      ...moduleConfig,
                      faqs: moduleConfig.faqs.filter((_, itemIndex) => itemIndex !== index)
                    })
                  }
                >
                  Remover FAQ
                </Button>
              </div>
            ))}

            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                updateConfig({
                  ...moduleConfig,
                  faqs: [...moduleConfig.faqs, { pergunta: "", resposta: "" }]
                })
              }
            >
              Adicionar FAQ
            </Button>
          </div>
        );
      }

      case "horarioAtendimento": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["horarioAtendimento"]>;
        const weekDays = [
          { value: 0, label: "Dom" },
          { value: 1, label: "Seg" },
          { value: 2, label: "Ter" },
          { value: 3, label: "Qua" },
          { value: 4, label: "Qui" },
          { value: 5, label: "Sex" },
          { value: 6, label: "Sáb" }
        ];

        return (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Início</label>
                <input
                  type="time"
                  className={[fieldClass, "h-11"].join(" ")}
                  value={moduleConfig.horarioInicio}
                  onChange={(event) => updateConfig({ ...moduleConfig, horarioInicio: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Fim</label>
                <input
                  type="time"
                  className={[fieldClass, "h-11"].join(" ")}
                  value={moduleConfig.horarioFim}
                  onChange={(event) => updateConfig({ ...moduleConfig, horarioFim: event.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-[var(--text-secondary)]">Dias da semana</p>
              <div className="flex flex-wrap gap-2">
                {weekDays.map((day) => (
                  <label key={day.value} className={checkboxPillClass}>
                    <input
                      type="checkbox"
                      checked={moduleConfig.diasSemana.includes(day.value)}
                      onChange={(event) =>
                        updateConfig({
                          ...moduleConfig,
                          diasSemana: event.target.checked
                            ? [...moduleConfig.diasSemana, day.value].sort((left, right) => left - right)
                            : moduleConfig.diasSemana.filter((value) => value !== day.value)
                        })
                      }
                    />
                    {day.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Timezone</label>
              <input
                className={[fieldClass, "h-11"].join(" ")}
                value={moduleConfig.timezone}
                onChange={(event) => updateConfig({ ...moduleConfig, timezone: event.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Mensagem fora do horário</label>
              <textarea
                className={textareaClass}
                value={moduleConfig.mensagemForaHorario}
                onChange={(event) => updateConfig({ ...moduleConfig, mensagemForaHorario: event.target.value })}
              />
            </div>
          </div>
        );
      }

      case "antiSpam": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["antiSpam"]>;

        return (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Intervalo (min)</label>
              <input
                type="number"
                min={1}
                className={[fieldClass, "h-11"].join(" ")}
                value={moduleConfig.intervaloMinutos}
                onChange={(event) => updateConfig({ ...moduleConfig, intervaloMinutos: Number(event.target.value || 1) })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Máx. mensagens iguais</label>
              <input
                type="number"
                min={1}
                className={[fieldClass, "h-11"].join(" ")}
                value={moduleConfig.maxMensagens}
                onChange={(event) => updateConfig({ ...moduleConfig, maxMensagens: Number(event.target.value || 1) })}
              />
            </div>
          </div>
        );
      }

      case "multiIdioma": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["multiIdioma"]>;

        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Idiomas permitidos</label>
              <textarea
                className={textareaClass}
                value={joinLines(moduleConfig.idiomasPermitidos)}
                onChange={(event) => updateConfig({ ...moduleConfig, idiomasPermitidos: parseLines(event.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Idioma principal</label>
              <input
                className={[fieldClass, "h-11"].join(" ")}
                value={moduleConfig.idiomaPrincipal}
                onChange={(event) => updateConfig({ ...moduleConfig, idiomaPrincipal: event.target.value })}
              />
            </div>
          </div>
        );
      }

      case "agenda": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["agenda"]>;

        return (
          <div className="space-y-4">
            <div className="rounded-[18px] border border-blue-500/20 bg-blue-500/10 p-4 text-sm text-blue-100">
              Sem o Google Calendar ativo, esta agenda serve como orientação para a IA responder disponibilidade.
              Para evitar conflito real de horários e criar eventos, ative também o módulo Google Calendar.
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Horários disponíveis</label>
              <textarea
                className={textareaClass}
                placeholder={"09:00\n10:00\n14:00"}
                value={joinLines(moduleConfig.horariosDisponiveis)}
                onChange={(event) => updateConfig({ ...moduleConfig, horariosDisponiveis: parseLines(event.target.value) })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Duração (min)</label>
                <input
                  type="number"
                  min={15}
                  className={[fieldClass, "h-11"].join(" ")}
                  value={moduleConfig.duracaoMinutos}
                  onChange={(event) => updateConfig({ ...moduleConfig, duracaoMinutos: Number(event.target.value || 15) })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text-secondary)]">Mensagem de confirmação</label>
                <input
                  className={[fieldClass, "h-11"].join(" ")}
                  value={moduleConfig.mensagemConfirmacao}
                  onChange={(event) => updateConfig({ ...moduleConfig, mensagemConfirmacao: event.target.value })}
                />
              </div>
            </div>
          </div>
        );
      }

      case "googleCalendar": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["googleCalendar"]>;

        return (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Client ID</label>
              <input className={[fieldClass, "h-11"].join(" ")} value={moduleConfig.clientId} onChange={(event) => updateConfig({ ...moduleConfig, clientId: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Client Secret</label>
              <input type="password" className={[fieldClass, "h-11"].join(" ")} value={moduleConfig.clientSecret} onChange={(event) => updateConfig({ ...moduleConfig, clientSecret: event.target.value })} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Refresh Token</label>
              <textarea className={textareaClass} value={moduleConfig.refreshToken} onChange={(event) => updateConfig({ ...moduleConfig, refreshToken: event.target.value })} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Calendar ID</label>
              <input className={[fieldClass, "h-11"].join(" ")} value={moduleConfig.calendarId} onChange={(event) => updateConfig({ ...moduleConfig, calendarId: event.target.value })} />
            </div>
          </div>
        );
      }

      case "listaBranca": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["listaBranca"]>;

        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Modo</label>
              <select
                className={[fieldClass, "h-11"].join(" ")}
                value={moduleConfig.modo}
                onChange={(event) => updateConfig({ ...moduleConfig, modo: event.target.value as "permitir_todos" | "permitir_lista" })}
              >
                <option value="permitir_lista">Responder apenas para a lista</option>
                <option value="permitir_todos">Permitir todos</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Números permitidos</label>
              <textarea
                className={textareaClass}
                value={joinLines(moduleConfig.numeros)}
                onChange={(event) => updateConfig({ ...moduleConfig, numeros: parseLines(event.target.value) })}
              />
            </div>
          </div>
        );
      }

      case "blacklist": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["blacklist"]>;

        return (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)]">Números bloqueados</label>
            <textarea
              className={textareaClass}
              value={joinLines(moduleConfig.numeros)}
              onChange={(event) => updateConfig({ ...moduleConfig, numeros: parseLines(event.target.value) })}
            />
          </div>
        );
      }

      case "limiteMensagens": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["limiteMensagens"]>;

        return (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Máx. por hora</label>
              <input
                type="number"
                min={1}
                className={[fieldClass, "h-11"].join(" ")}
                value={moduleConfig.maxPorHora}
                onChange={(event) => updateConfig({ ...moduleConfig, maxPorHora: Number(event.target.value || 1) })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Máx. por dia</label>
              <input
                type="number"
                min={1}
                className={[fieldClass, "h-11"].join(" ")}
                value={moduleConfig.maxPorDia}
                onChange={(event) => updateConfig({ ...moduleConfig, maxPorDia: Number(event.target.value || 1) })}
              />
            </div>
          </div>
        );
      }

      case "palavraPausa": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["palavraPausa"]>;

        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Palavras</label>
              <textarea
                className={textareaClass}
                value={joinLines(moduleConfig.palavras)}
                onChange={(event) => updateConfig({ ...moduleConfig, palavras: parseLines(event.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Mensagem de pausa</label>
              <textarea
                className={textareaClass}
                value={moduleConfig.mensagemPausa}
                onChange={(event) => updateConfig({ ...moduleConfig, mensagemPausa: event.target.value })}
              />
            </div>
          </div>
        );
      }

      default:
        return (
          <div className="rounded-[18px] border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
            Este módulo ainda não possui formulário operacional. A configuração será exibida aqui quando o runtime correspondente estiver pronto.
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/65 backdrop-blur-sm">
      <div className="h-full w-full max-w-xl overflow-y-auto border-l border-white/10 bg-[var(--bg-secondary)] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-5 py-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-[var(--text-tertiary)]">Configuração do módulo</p>
            <h3 className="mt-1 text-lg font-semibold text-[var(--text-primary)]">{moduleDefinition.label}</h3>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{moduleDefinition.description}</p>
            <div className="mt-3">
              <span
                className={[
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tracking-wide",
                  executionModeInfo.tone === "success"
                    ? "border-emerald-500/20 bg-emerald-500/12 text-emerald-400"
                    : executionModeInfo.tone === "info"
                      ? "border-blue-500/20 bg-blue-500/12 text-blue-400"
                      : "border-yellow-500/20 bg-yellow-500/12 text-yellow-400"
                ].join(" ")}
              >
                {executionModeInfo.badge}
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label="Fechar configurações do módulo"
            className="rounded-full border border-[var(--border-subtle)] p-2 text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {moduleDefinition.supportLevel === "placeholder" ? (
            <div className="rounded-[18px] border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
              Este módulo ainda é um placeholder de produto. A configuração pode ser preparada na interface, mas o backend não executa esse fluxo no runtime do chatbot.
            </div>
          ) : (
            <div className="rounded-[18px] border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">
              Módulo operacional no runtime. Salve a configuração e deixe o toggle ativo para ele entrar no fluxo.
            </div>
          )}

          <div className="rounded-[18px] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-4 text-sm text-[var(--text-secondary)]">
            {executionModeInfo.description}
          </div>

          {renderOperationalForm()}

          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Fechar
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
