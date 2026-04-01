import type {
  AprendizadoContinuoModuleConfig,
  AgendaModuleConfig,
  AntiSpamModuleConfig,
  BlacklistModuleConfig,
  ChatbotModules,
  FaqModuleConfig,
  GoogleCalendarModuleConfig,
  HorarioAtendimentoModuleConfig,
  LimiteMensagensModuleConfig,
  ListaBrancaModuleConfig,
  MemoriaPersonalizadaModuleConfig,
  MultiIdiomaModuleConfig,
  PalavraPausaModuleConfig,
  ResumoDiarioModuleConfig,
  SessaoInatividadeModuleConfig
} from "@infracode/types";
import { CHATBOT_MODULE_CATALOG } from "@infracode/types";
import { z } from "zod";
import { normalizePhoneNumber } from "../../lib/phone.js";
import { googleCalendarModuleSchema } from "./schemas.js";

const faqModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  faqs: z.array(
    z.object({
      pergunta: z.string().min(1),
      resposta: z.string().min(1)
    })
  ).default([])
});

const horarioAtendimentoModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  horarioInicio: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  horarioFim: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
  diasSemana: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  mensagemForaHorario: z.string().min(1).default("Estamos fora do horário de atendimento no momento."),
  timezone: z.string().min(1).default("America/Sao_Paulo")
});

const antiSpamModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  intervaloMinutos: z.number().int().min(1).max(120).default(5),
  maxMensagens: z.number().int().min(1).max(50).default(3)
});

const multiIdiomaModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  idiomasPermitidos: z.array(z.string().min(2)).default(["pt-BR"]),
  idiomaPrincipal: z.string().min(2).default("pt-BR")
});

const agendaModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  horariosDisponiveis: z.array(z.string().regex(/^\d{2}:\d{2}$/)).default([]),
  duracaoMinutos: z.number().int().min(15).max(480).default(60),
  mensagemConfirmacao: z.string().min(1).default("Agendamento confirmado.")
});

const listaBrancaModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  numeros: z.array(z.string().min(8)).default([]),
  modo: z.enum(["permitir_todos", "permitir_lista"]).default("permitir_lista")
});

const blacklistModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  numeros: z.array(z.string().min(8)).default([])
});

const limiteMensagensModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  maxPorHora: z.number().int().min(1).max(10_000).default(20),
  maxPorDia: z.number().int().min(1).max(50_000).default(100)
});

const palavraPausaModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  palavras: z.array(z.string().min(1)).default(["sair", "parar", "atendente"]),
  mensagemPausa: z.string().min(1).default("Tudo bem. Vou pausar o atendimento automático por aqui.")
});

const memoriaPersonalizadaModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  fields: z.array(
    z.object({
      key: z.string().min(1).max(64),
      label: z.string().min(1).max(128),
      description: z.string().min(1).max(512)
    })
  ).default([])
});

const aprendizadoContinuoModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  verificationStatus: z.enum(["UNVERIFIED", "PENDING", "VERIFIED"]).default("UNVERIFIED"),
  configuredAdminPhone: z.string().min(8).nullable().optional().default(null),
  verifiedPhone: z.string().min(8).nullable().optional().default(null),
  pendingCode: z.string().regex(/^\d{6}$/).nullable().optional().default(null),
  pendingCodeExpiresAt: z.string().datetime().nullable().optional().default(null),
  lastVerificationRequestedAt: z.string().datetime().nullable().optional().default(null),
  verifiedAt: z.string().datetime().nullable().optional().default(null),
  challengeMessageId: z.string().min(1).nullable().optional().default(null),
  challengeRemoteJid: z.string().min(1).nullable().optional().default(null),
  verifiedPhones: z.array(z.string().min(8)).default([]),
  verifiedRemoteJids: z.array(z.string().min(1)).default([]),
  verifiedSenderJids: z.array(z.string().min(1)).default([])
});

const resumoDiarioModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  horaEnvioUtc: z.number().int().min(0).max(23).default(8)
});

const sessaoInatividadeModuleSchema = z.object({
  isEnabled: z.boolean().default(false),
  horasInatividade: z.number().int().min(1).max(720).default(8)
});

const moduleSchemas = {
  faq: faqModuleSchema,
  horarioAtendimento: horarioAtendimentoModuleSchema,
  antiSpam: antiSpamModuleSchema,
  multiIdioma: multiIdiomaModuleSchema,
  agenda: agendaModuleSchema,
  googleCalendar: googleCalendarModuleSchema,
  listaBranca: listaBrancaModuleSchema,
  blacklist: blacklistModuleSchema,
  limiteMensagens: limiteMensagensModuleSchema,
  palavraPausa: palavraPausaModuleSchema,
  aprendizadoContinuo: aprendizadoContinuoModuleSchema,
  memoriaPersonalizada: memoriaPersonalizadaModuleSchema,
  resumoDiario: resumoDiarioModuleSchema,
  sessaoInatividade: sessaoInatividadeModuleSchema
} satisfies Record<string, z.ZodTypeAny>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeLookupText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const parseConfiguredTime = (value: string): number => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const getParsedModuleConfig = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown
): z.output<TSchema> | null => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const sanitizeChatbotModules = (modules: unknown): ChatbotModules => {
  if (!isRecord(modules)) {
    return {};
  }

  const sanitizedModules: Record<string, unknown> = { ...modules };

  for (const [moduleKey, schema] of Object.entries(moduleSchemas)) {
    if (!(moduleKey in modules)) {
      continue;
    }

    const parsed = schema.safeParse(modules[moduleKey]);
    sanitizedModules[moduleKey] = parsed.success ? parsed.data : { isEnabled: false };
  }

  for (const moduleDefinition of CHATBOT_MODULE_CATALOG) {
    if (moduleDefinition.supportLevel !== "placeholder" || !(moduleDefinition.key in modules)) {
      continue;
    }

    const existingConfig = modules[moduleDefinition.key];
    sanitizedModules[moduleDefinition.key] = isRecord(existingConfig)
      ? {
          ...existingConfig,
          isEnabled: false
        }
      : {
          isEnabled: false
        };
  }

  return sanitizedModules as ChatbotModules;
};

export const getFaqModuleConfig = (modules: ChatbotModules | undefined): FaqModuleConfig | null =>
  getParsedModuleConfig(faqModuleSchema, modules?.faq);

export const getHorarioAtendimentoModuleConfig = (
  modules: ChatbotModules | undefined
): HorarioAtendimentoModuleConfig | null =>
  getParsedModuleConfig(horarioAtendimentoModuleSchema, modules?.horarioAtendimento);

export const getAntiSpamModuleConfig = (modules: ChatbotModules | undefined): AntiSpamModuleConfig | null =>
  getParsedModuleConfig(antiSpamModuleSchema, modules?.antiSpam);

export const getMultiIdiomaModuleConfig = (modules: ChatbotModules | undefined): MultiIdiomaModuleConfig | null =>
  getParsedModuleConfig(multiIdiomaModuleSchema, modules?.multiIdioma);

export const getAgendaModuleConfig = (modules: ChatbotModules | undefined): AgendaModuleConfig | null =>
  getParsedModuleConfig(agendaModuleSchema, modules?.agenda);

export const getGoogleCalendarModuleConfig = (
  modules: ChatbotModules | undefined
): GoogleCalendarModuleConfig | null =>
  getParsedModuleConfig(googleCalendarModuleSchema, modules?.googleCalendar);

export const getListaBrancaModuleConfig = (
  modules: ChatbotModules | undefined
): ListaBrancaModuleConfig | null =>
  getParsedModuleConfig(listaBrancaModuleSchema, modules?.listaBranca);

export const getBlacklistModuleConfig = (modules: ChatbotModules | undefined): BlacklistModuleConfig | null =>
  getParsedModuleConfig(blacklistModuleSchema, modules?.blacklist);

export const getLimiteMensagensModuleConfig = (
  modules: ChatbotModules | undefined
): LimiteMensagensModuleConfig | null =>
  getParsedModuleConfig(limiteMensagensModuleSchema, modules?.limiteMensagens);

export const getPalavraPausaModuleConfig = (
  modules: ChatbotModules | undefined
): PalavraPausaModuleConfig | null =>
  getParsedModuleConfig(palavraPausaModuleSchema, modules?.palavraPausa);

export const getAprendizadoContinuoModuleConfig = (
  modules: ChatbotModules | undefined
): AprendizadoContinuoModuleConfig | null =>
  getParsedModuleConfig(aprendizadoContinuoModuleSchema, modules?.aprendizadoContinuo);

export const getMemoriaPersonalizadaModuleConfig = (
  modules: ChatbotModules | undefined
): MemoriaPersonalizadaModuleConfig | null =>
  getParsedModuleConfig(memoriaPersonalizadaModuleSchema, modules?.memoriaPersonalizada);

export const getResumoDiarioModuleConfig = (
  modules: ChatbotModules | undefined
): ResumoDiarioModuleConfig | null =>
  getParsedModuleConfig(resumoDiarioModuleSchema, modules?.resumoDiario);

export const getSessaoInatividadeModuleConfig = (
  modules: ChatbotModules | undefined
): SessaoInatividadeModuleConfig | null =>
  getParsedModuleConfig(sessaoInatividadeModuleSchema, modules?.sessaoInatividade);

export const buildOperationalModuleInstructions = (modules: ChatbotModules | undefined): string[] => {
  const instructions: string[] = [];
  const faqModule = getFaqModuleConfig(modules);
  const multiIdiomaModule = getMultiIdiomaModuleConfig(modules);
  const agendaModule = getAgendaModuleConfig(modules);
  const googleCalendarModule = getGoogleCalendarModuleConfig(modules);

  if (faqModule?.isEnabled && faqModule.faqs.length > 0) {
    const faqLines = faqModule.faqs
      .slice(0, 20)
      .map((faq) => `- Pergunta: ${faq.pergunta}\n  Resposta: ${faq.resposta}`)
      .join("\n");

    instructions.push(
      "### FAQ AUTOMATICO ###",
      "Se a pergunta do cliente bater com um FAQ configurado, priorize a resposta cadastrada antes de improvisar.",
      faqLines
    );
  }

  if (multiIdiomaModule?.isEnabled) {
    instructions.push(
      "### MULTI-IDIOMA ###",
      `Idiomas permitidos: ${multiIdiomaModule.idiomasPermitidos.join(", ")}.`,
      `Idioma principal: ${multiIdiomaModule.idiomaPrincipal}.`,
      "Responda somente em um dos idiomas permitidos e acompanhe o idioma do cliente quando possivel."
    );
  }

  if (agendaModule?.isEnabled) {
    const horarios = agendaModule.horariosDisponiveis.length
      ? agendaModule.horariosDisponiveis.join(", ")
      : "sem horarios fixos configurados";

    instructions.push(
      "### AGENDA ###",
      `Duracao padrao: ${agendaModule.duracaoMinutos} minutos.`,
      `Horarios fixos disponiveis: ${horarios}.`,
      `Mensagem de confirmacao sugerida: ${agendaModule.mensagemConfirmacao}`
    );
  }

  if (googleCalendarModule?.isEnabled) {
    instructions.push(
      "### GOOGLE CALENDAR ###",
      "Antes de prometer disponibilidade real, use a tool checkAvailability.",
      "So use createEvent depois que o cliente confirmar claramente a data/horario escolhido."
    );
  }

  return instructions;
};

export const findFaqResponse = (modules: ChatbotModules | undefined, inputText: string): string | null => {
  const faqModule = getFaqModuleConfig(modules);

  if (!faqModule?.isEnabled || faqModule.faqs.length === 0) {
    return null;
  }

  const normalizedInput = normalizeLookupText(inputText);

  for (const faq of faqModule.faqs) {
    const normalizedQuestion = normalizeLookupText(faq.pergunta);

    if (!normalizedQuestion) {
      continue;
    }

    if (
      normalizedInput.includes(normalizedQuestion) ||
      normalizedQuestion.includes(normalizedInput)
    ) {
      return faq.resposta.trim();
    }
  }

  return null;
};

export const isWithinHorarioAtendimento = (
  config: HorarioAtendimentoModuleConfig,
  referenceDate = new Date()
): boolean => {
  let localizedDate: Date;

  try {
    localizedDate = new Date(referenceDate.toLocaleString("en-US", { timeZone: config.timezone }));
  } catch {
    return true;
  }

  if (Number.isNaN(localizedDate.getTime())) {
    return true;
  }

  const dayOfWeek = localizedDate.getDay();

  if (!config.diasSemana.includes(dayOfWeek)) {
    return false;
  }

  const minutesOfDay = localizedDate.getHours() * 60 + localizedDate.getMinutes();
  const startMinutes = parseConfiguredTime(config.horarioInicio);
  const endMinutes = parseConfiguredTime(config.horarioFim);

  return minutesOfDay >= startMinutes && minutesOfDay <= endMinutes;
};

const normalizeConfiguredNumbers = (numbers: string[]): Set<string> =>
  new Set(
    numbers
      .map((number) => normalizePhoneNumber(number))
      .filter(Boolean)
  );

export const isPhoneAllowedByListaBranca = (
  modules: ChatbotModules | undefined,
  phoneNumber: string
): boolean => {
  const listaBrancaModule = getListaBrancaModuleConfig(modules);

  if (!listaBrancaModule?.isEnabled || listaBrancaModule.modo === "permitir_todos") {
    return true;
  }

  const configuredNumbers = normalizeConfiguredNumbers(listaBrancaModule.numeros);
  if (configuredNumbers.size === 0) {
    return true;
  }
  return configuredNumbers.has(normalizePhoneNumber(phoneNumber));
};

export const isPhoneBlockedByBlacklist = (
  modules: ChatbotModules | undefined,
  phoneNumber: string
): boolean => {
  const blacklistModule = getBlacklistModuleConfig(modules);

  if (!blacklistModule?.isEnabled) {
    return false;
  }

  const configuredNumbers = normalizeConfiguredNumbers(blacklistModule.numeros);
  return configuredNumbers.has(normalizePhoneNumber(phoneNumber));
};

export const matchesPauseWord = (
  modules: ChatbotModules | undefined,
  inputText: string
): { matched: boolean; message: string | null } => {
  const palavraPausaModule = getPalavraPausaModuleConfig(modules);

  if (!palavraPausaModule?.isEnabled) {
    return { matched: false, message: null };
  }

  const normalizedInput = normalizeLookupText(inputText);
  const matched = palavraPausaModule.palavras.some((word) => normalizeLookupText(word) === normalizedInput);

  return {
    matched,
    message: matched ? palavraPausaModule.mensagemPausa : null
  };
};
