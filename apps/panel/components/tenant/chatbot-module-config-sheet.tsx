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

type ChatbotModuleConfigByKey = {
  [TKey in ChatbotModuleKey]-?: NonNullable<ChatbotModules[TKey]>;
};

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

const defaultChatbotModuleConfigs: ChatbotModuleConfigByKey = {
  faq: { isEnabled: false, faqs: [] },
  horarioAtendimento: {
    isEnabled: false,
    horarioInicio: "09:00",
    horarioFim: "18:00",
    diasSemana: [1, 2, 3, 4, 5],
    mensagemForaHorario: "Estamos fora do horário de atendimento no momento.",
    timezone: "America/Sao_Paulo"
  },
  antiSpam: { isEnabled: false, intervaloMinutos: 5, maxMensagens: 3 },
  multiIdioma: { isEnabled: false, idiomasPermitidos: ["pt-BR"], idiomaPrincipal: "pt-BR" },
  agenda: {
    isEnabled: false,
    horariosDisponiveis: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
    duracaoMinutos: 60,
    mensagemConfirmacao: "Agendamento confirmado."
  },
  lembrete: {
    isEnabled: false,
    horasAntes: 24,
    mensagemLembrete: "Lembrete: seu compromisso se aproxima."
  },
  confirmacaoPresenca: {
    isEnabled: false,
    mensagemConfirmacao: "Você confirma sua presença?",
    prazoConfirmacaoHoras: 24
  },
  cancelamentoReagendamento: {
    isEnabled: false,
    permiteCancelamento: true,
    permiteReagendamento: true,
    prazoCancelamentoHoras: 24
  },
  cobrancaAutomatica: {
    isEnabled: false,
    extratoMessage: "Segue o resumo em aberto.",
    chavePix: "",
    tipoChavePix: "cpf",
    mensagemConfirmacao: "Pagamento identificado com sucesso."
  },
  notificacaoVencimento: {
    isEnabled: false,
    diasAntes: 3,
    mensagemVencimento: "Seu vencimento está próximo."
  },
  orcamentoRapido: {
    isEnabled: false,
    tabelaPrecos: [],
    mensagemOrcamento: "Segue o orçamento solicitado."
  },
  catalogo: {
    isEnabled: false,
    produtos: []
  },
  pedidoWhatsApp: {
    isEnabled: false,
    produtos: [],
    mostrarPreco: true,
    mensagemPedido: "Perfeito, vou registrar seu pedido."
  },
  statusPedido: {
    isEnabled: false,
    statusDisponiveis: []
  },
  envioMidia: {
    isEnabled: false,
    gatilhos: []
  },
  capturaDados: {
    isEnabled: false,
    campos: [],
    mensagemAgradecimento: "Obrigado pelos dados enviados."
  },
  nps: {
    isEnabled: false,
    perguntas: ["Como você avalia seu atendimento de 0 a 10?"],
    notaMinima: 8,
    mensagemAgradecimento: "Obrigado pelo seu feedback."
  },
  tagFollowUp: {
    isEnabled: false,
    tags: [],
    diasInatividade: 7
  },
  exportarLeads: {
    isEnabled: false,
    formato: "csv",
    campos: ["nome", "telefone", "servico"]
  },
  webhook: {
    isEnabled: false,
    url: "",
    secret: "",
    eventos: []
  },
  webhookBidirecional: {
    isEnabled: false,
    url: "",
    secret: ""
  },
  googleCalendar: {
    isEnabled: false,
    clientId: "",
    clientSecret: "",
    refreshToken: "",
    calendarId: ""
  },
  planilhaGoogle: {
    isEnabled: false,
    spreadsheetId: "",
    sheetName: ""
  },
  listaBranca: { isEnabled: false, numeros: [], modo: "permitir_lista" },
  blacklist: { isEnabled: false, numeros: [] },
  limiteMensagens: { isEnabled: false, maxPorHora: 20, maxPorDia: 100 },
  palavraPausa: {
    isEnabled: false,
    palavras: ["sair", "parar", "atendente"],
    mensagemPausa: "Tudo bem. Vou pausar o atendimento automático por aqui."
  },
  aprendizadoContinuo: {
    isEnabled: false,
    verificationStatus: "UNVERIFIED",
    configuredAdminPhone: null,
    verifiedPhone: null,
    pendingCode: null,
    pendingCodeExpiresAt: null,
    lastVerificationRequestedAt: null,
    verifiedAt: null,
    challengeMessageId: null,
    challengeRemoteJid: null,
    verifiedPhones: [],
    verifiedRemoteJids: [],
    verifiedSenderJids: []
  },
  memoriaPersonalizada: {
    isEnabled: false,
    fields: []
  },
  disparoMassa: {
    isEnabled: false,
    modeloMensagem: "",
    agendamentoPadrao: ""
  },
  campanhaSegmento: {
    isEnabled: false,
    segmentoTags: [],
    modeloMensagem: ""
  },
  reativacao: {
    isEnabled: false,
    diasInatividade: 30,
    modeloMensagem: "",
    maxPorMes: 1
  },
  cupomPromocao: {
    isEnabled: false,
    cupons: [],
    palavrasGatilho: []
  },
  resumoDiario: {
    isEnabled: false,
    horaEnvioUtc: 8
  },
  sessaoInatividade: {
    isEnabled: false,
    horasInatividade: 8
  }
};

export const buildDefaultChatbotModuleConfig = <TKey extends ChatbotModuleKey>(
  moduleKey: TKey
): ChatbotModuleConfigByKey[TKey] => defaultChatbotModuleConfigs[moduleKey];

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

      case "aprendizadoContinuo": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["aprendizadoContinuo"]>;
        const statusLabel =
          moduleConfig.verificationStatus === "VERIFIED"
            ? "Verificado"
            : moduleConfig.verificationStatus === "PENDING"
              ? "Pendente"
              : "Nao verificado";

        return (
          <div className="space-y-4">
            <div className="rounded-[18px] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-4">
              <p className="text-sm font-medium text-[var(--text-primary)]">Vinculo do admin</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Este modulo usa o numero do admin/leads configurado na instancia. Ao salvar com o modulo ativo,
                o sistema envia uma mensagem pedindo a confirmacao do codigo exibido aqui no painel.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className={checkboxPillClass}>
                  <span className="text-[var(--text-tertiary)]">Status</span>
                  <strong className="text-[var(--text-primary)]">{statusLabel}</strong>
                </div>
                <div className={checkboxPillClass}>
                  <span className="text-[var(--text-tertiary)]">Admin configurado</span>
                  <strong className="text-[var(--text-primary)]">{moduleConfig.configuredAdminPhone || "Nao definido"}</strong>
                </div>
                <div className={checkboxPillClass}>
                  <span className="text-[var(--text-tertiary)]">Admin validado</span>
                  <strong className="text-[var(--text-primary)]">{moduleConfig.verifiedPhone || "Aguardando"}</strong>
                </div>
                <div className={checkboxPillClass}>
                  <span className="text-[var(--text-tertiary)]">Confirmado em</span>
                  <strong className="text-[var(--text-primary)]">{moduleConfig.verifiedAt || "Ainda nao"}</strong>
                </div>
              </div>
            </div>

            <div className="rounded-[18px] border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-4">
              <p className="text-sm font-medium text-[var(--text-primary)]">Codigo do painel</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Responda no WhatsApp da instancia com este codigo para vincular esse chat como admin verificado.
              </p>
              <div className="mt-4 rounded-[16px] border border-dashed border-[var(--border-default)] bg-[var(--bg-primary)] px-4 py-5">
                <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--text-tertiary)]">Codigo atual</p>
                <p className="mt-2 font-mono text-3xl font-semibold tracking-[0.3em] text-[var(--text-primary)]">
                  {moduleConfig.pendingCode || "------"}
                </p>
                <p className="mt-3 text-xs text-[var(--text-secondary)]">
                  Expira em: {moduleConfig.pendingCodeExpiresAt || "sem verificacao pendente"}
                </p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  Ultima solicitacao: {moduleConfig.lastVerificationRequestedAt || "nunca"}
                </p>
              </div>
            </div>
          </div>
        );
      }

      case "memoriaPersonalizada": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["memoriaPersonalizada"]>;
        return (
          <div className="space-y-3">
            <p className="text-xs text-[var(--text-secondary)]">
              Digite o nome de cada informação que a IA deve memorizar sobre o cliente (ex: "nome do pet", "raça", "serviço preferido"). A IA extrai automaticamente esses dados durante as conversas.
            </p>
            {moduleConfig.fields.map((field, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  className={[fieldClass, "h-11 flex-1"].join(" ")}
                  placeholder='Ex: "nome do pet", "raça", "serviço preferido"'
                  value={field.label}
                  onChange={(e) =>
                    updateConfig({
                      ...moduleConfig,
                      fields: moduleConfig.fields.map((f, i) => i === index ? { ...f, label: e.target.value } : f)
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    updateConfig({
                      ...moduleConfig,
                      fields: moduleConfig.fields.filter((_, i) => i !== index)
                    })
                  }
                >
                  Remover
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                updateConfig({
                  ...moduleConfig,
                  fields: [...moduleConfig.fields, { key: "", label: "", description: "" }]
                })
              }
            >
              Adicionar campo
            </Button>
          </div>
        );
      }

      case "resumoDiario": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["resumoDiario"]>;
        // horaEnvioUtc armazenado em UTC; exibir em horario de Brasilia (UTC-3)
        const horasBrasilia = Array.from({ length: 24 }, (_, i) => i);
        const utcParaBrasilia = (utc: number) => ((utc - 3 + 24) % 24);
        const brasiliaParaUtc = (br: number) => ((br + 3) % 24);
        const horaBrasilia = utcParaBrasilia(moduleConfig.horaEnvioUtc);
        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Horário de envio (Brasília)</label>
              <select
                className={[fieldClass, "h-11"].join(" ")}
                value={horaBrasilia}
                onChange={(e) => updateConfig({ ...moduleConfig, horaEnvioUtc: brasiliaParaUtc(Number(e.target.value)) })}
              >
                {horasBrasilia.map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
              <p className="text-xs text-[var(--text-tertiary)]">O resumo será enviado para o admin verificado nesse horário, todos os dias.</p>
            </div>
          </div>
        );
      }

      case "sessaoInatividade": {
        const moduleConfig = currentConfig as NonNullable<ChatbotModules["sessaoInatividade"]>;
        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--text-secondary)]">Horas de inatividade</label>
              <input
                type="number"
                min={1}
                max={720}
                className={[fieldClass, "h-11"].join(" ")}
                value={moduleConfig.horasInatividade}
                onChange={(e) => updateConfig({ ...moduleConfig, horasInatividade: Math.min(720, Math.max(1, Number(e.target.value || 1))) })}
              />
              <p className="text-xs text-[var(--text-tertiary)]">Se o cliente ficar inativo por esse período, o histórico da conversa é reiniciado na próxima mensagem. Mínimo: 1h, máximo: 720h (30 dias).</p>
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
