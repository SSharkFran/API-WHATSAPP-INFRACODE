export type InstanceStatus =
  | "INITIALIZING"
  | "QR_PENDING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "BANNED"
  | "PAUSED";

export type MessageDirection = "INBOUND" | "OUTBOUND";
export type MessageStatus = "QUEUED" | "SCHEDULED" | "SENT" | "DELIVERED" | "READ" | "FAILED";
export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "poll"
  | "reaction"
  | "list"
  | "buttons"
  | "template";

export interface PaginatedResult<TItem> {
  data: TItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface InstanceUsageReport {
  instanceId: string;
  messagesSent: number;
  messagesReceived: number;
  errors: number;
  uptimeSeconds: number;
  riskScore: number;
}

export interface InstanceHealthReport {
  instanceId: string;
  status: InstanceStatus;
  workerOnline: boolean;
  redisConnected: boolean;
  databaseConnected: boolean;
  qrExpiresIn?: number;
  lastActivityAt?: string | null;
  lastError?: string | null;
  reconnectAttempts: number;
  uptimeSeconds: number;
  queueDepth: number;
}

export interface InstanceSummary {
  id: string;
  tenantId: string;
  name: string;
  phoneNumber?: string | null;
  avatarUrl?: string | null;
  status: InstanceStatus;
  lastActivityAt?: string | null;
  lastError?: string | null;
  connectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  usage: InstanceUsageReport;
}

export interface WebhookConfig {
  id: string;
  instanceId: string;
  url: string;
  secret: string;
  headers: Record<string, string>;
  subscribedEvents: string[];
  isActive: boolean;
}

export interface BaseSendMessagePayload {
  to: string;
  targetJid?: string;
  replyToMessageId?: string;
  mentionNumbers?: string[];
  simulateTypingMs?: number;
  markAsRead?: boolean;
  scheduledAt?: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
}

export interface SendTextMessagePayload extends BaseSendMessagePayload {
  type: "text";
  text: string;
}

export interface MediaAttachment {
  mimeType: string;
  fileName?: string;
  url?: string;
  base64?: string;
  caption?: string;
  convertToVoiceNote?: boolean;
}

export interface SendImageMessagePayload extends BaseSendMessagePayload {
  type: "image";
  media: MediaAttachment;
}

export interface SendVideoMessagePayload extends BaseSendMessagePayload {
  type: "video";
  media: MediaAttachment;
}

export interface SendAudioMessagePayload extends BaseSendMessagePayload {
  type: "audio";
  media: MediaAttachment;
}

export interface SendDocumentMessagePayload extends BaseSendMessagePayload {
  type: "document";
  media: MediaAttachment;
}

export interface SendStickerMessagePayload extends BaseSendMessagePayload {
  type: "sticker";
  media: MediaAttachment;
  animated?: boolean;
}

export interface SendLocationMessagePayload extends BaseSendMessagePayload {
  type: "location";
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface SendContactMessagePayload extends BaseSendMessagePayload {
  type: "contact";
  displayName: string;
  vcard: string;
}

export interface SendPollMessagePayload extends BaseSendMessagePayload {
  type: "poll";
  title: string;
  options: string[];
  selectableCount?: number;
}

export interface SendReactionMessagePayload extends BaseSendMessagePayload {
  type: "reaction";
  emoji: string;
  targetMessageId: string;
  targetJid?: string;
  fromMe?: boolean;
  participant?: string;
}

export interface InteractiveListSection {
  title: string;
  rows: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
}

export interface SendListMessagePayload extends BaseSendMessagePayload {
  type: "list";
  title: string;
  description: string;
  buttonText: string;
  footerText?: string;
  sections: InteractiveListSection[];
}

export interface SendButtonsMessagePayload extends BaseSendMessagePayload {
  type: "buttons";
  text: string;
  footerText?: string;
  buttons: Array<{
    id: string;
    text: string;
  }>;
}

export interface SendTemplateMessagePayload extends BaseSendMessagePayload {
  type: "template";
  templateName: string;
  body: string;
  variables: Record<string, string>;
  footerText?: string;
}

export type SendMessagePayload =
  | SendTextMessagePayload
  | SendImageMessagePayload
  | SendVideoMessagePayload
  | SendAudioMessagePayload
  | SendDocumentMessagePayload
  | SendStickerMessagePayload
  | SendLocationMessagePayload
  | SendContactMessagePayload
  | SendPollMessagePayload
  | SendReactionMessagePayload
  | SendListMessagePayload
  | SendButtonsMessagePayload
  | SendTemplateMessagePayload;

export interface MessageRecord {
  id: string;
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  direction: MessageDirection;
  type: MessageType;
  status: MessageStatus;
  payload: Record<string, unknown>;
  traceId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QrCodeEvent {
  instanceId: string;
  qrCodeBase64: string;
  expiresInSeconds: number;
}

export interface InstanceLogEvent {
  instanceId: string;
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ChatbotTriggerType = "EXACT" | "CONTAINS" | "REGEX" | "FIRST_CONTACT";

export type ChatbotAiMode = "RULES_ONLY" | "RULES_THEN_AI" | "AI_ONLY";
export type ChatbotAiProvider = "GROQ" | "OPENAI_COMPATIBLE";

export interface ChatbotRule {
  id: string;
  name: string;
  triggerType: ChatbotTriggerType;
  matchValue?: string | null;
  responseText: string;
  isActive: boolean;
}

export interface ChatbotAiConfig {
  isEnabled: boolean;
  mode: ChatbotAiMode;
  provider: ChatbotAiProvider | null;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxContextMessages: number;
  isManagedByAdmin: boolean;
  isProviderConfigured: boolean;
  isProviderActive: boolean;
}

export interface TenantAiProviderConfig {
  tenantId: string;
  provider: ChatbotAiProvider;
  baseUrl: string;
  model: string;
  isActive: boolean;
  isConfigured: boolean;
  hasApiKey: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ChatbotConfig {
  id: string;
  instanceId: string;
  isEnabled: boolean;
  welcomeMessage?: string | null;
  fallbackMessage?: string | null;
  humanTakeoverStartMessage?: string | null;
  humanTakeoverEndMessage?: string | null;
  leadsGroupJid?: string | null;
  leadsGroupName?: string | null;
  leadsPhoneNumber?: string | null;
  leadsEnabled?: boolean;
  fiadoEnabled?: boolean;
  audioEnabled?: boolean;
  visionEnabled?: boolean;
  visionPrompt?: string | null;
  responseDelayMs?: number;
  leadAutoExtract?: boolean;
  leadVehicleTable?: Record<string, unknown>;
  leadPriceTable?: Record<string, unknown>;
  leadSurchargeTable?: Record<string, unknown>;
  modules?: ChatbotModules;
  rules: ChatbotRule[];
  ai: ChatbotAiConfig;
  aiFallbackProvider?: string | null;
  aiFallbackApiKey?: string | null;
  aiFallbackModel?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FiadoItem {
  description: string;
  value: number;
  addedAt: string;
}

export interface FiadoTab {
  id: string;
  instanceId: string;
  phoneNumber: string;
  displayName?: string | null;
  total: number;
  items: FiadoItem[];
  paidAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ClientMemoryStatus =
  | "lead_frio"
  | "lead_quente"
  | "cliente_ativo"
  | "projeto_encerrado"
  | "sem_interesse";

export type ClientMemoryTag =
  | "follow_up"
  | "cliente_antigo"
  | "sem_resposta"
  | "orcamento_enviado"
  | "fechado"
  | "paused_by_human";

export interface ClientMemory {
  id: string;
  phoneNumber: string;
  name?: string | null;
  isExistingClient: boolean;
  projectDescription?: string | null;
  serviceInterest?: string | null;
  status: ClientMemoryStatus;
  tags: ClientMemoryTag[];
  notes?: string | null;
  lastContactAt: string;
  scheduledAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatbotSimulationResult {
  action: "MATCHED" | "WELCOME" | "FALLBACK" | "AI" | "HUMAN_HANDOFF" | "ESCALATE_ADMIN" | "NO_MATCH";
  matchedRuleId?: string | null;
  matchedRuleName?: string | null;
  responseText?: string | null;
}

export interface ChatbotModules {
  faq?: FaqModuleConfig;
  horarioAtendimento?: HorarioAtendimentoModuleConfig;
  antiSpam?: AntiSpamModuleConfig;
  multiIdioma?: MultiIdiomaModuleConfig;
  agenda?: AgendaModuleConfig;
  lembrete?: LembreteModuleConfig;
  confirmacaoPresenca?: ConfirmacaoPresencaModuleConfig;
  cancelamentoReagendamento?: CancelamentoReagendamentoModuleConfig;
  cobrancaAutomatica?: CobrancaAutomaticaModuleConfig;
  notificacaoVencimento?: NotificacaoVencimentoModuleConfig;
  orcamentoRapido?: OrcamentoRapidoModuleConfig;
  catalogo?: CatalogoModuleConfig;
  pedidoWhatsApp?: PedidoWhatsAppModuleConfig;
  statusPedido?: StatusPedidoModuleConfig;
  envioMidia?: EnvioMidiaModuleConfig;
  capturaDados?: CapturaDadosModuleConfig;
  nps?: NpsModuleConfig;
  tagFollowUp?: TagFollowUpModuleConfig;
  exportarLeads?: ExportarLeadsModuleConfig;
  webhook?: WebhookModuleConfig;
  webhookBidirecional?: WebhookBidirecionalModuleConfig;
  googleCalendar?: GoogleCalendarModuleConfig;
  planilhaGoogle?: PlanilhaGoogleModuleConfig;
  listaBranca?: ListaBrancaModuleConfig;
  blacklist?: BlacklistModuleConfig;
  limiteMensagens?: LimiteMensagensModuleConfig;
  palavraPausa?: PalavraPausaModuleConfig;
  disparoMassa?: DisparoMassaModuleConfig;
  campanhaSegmento?: CampanhaSegmentoModuleConfig;
  reativacao?: ReativacaoModuleConfig;
  cupomPromocao?: CupomPromocaoModuleConfig;
}

export type ChatbotModuleKey = keyof ChatbotModules;
export type ChatbotModuleCategory =
  | "atendimento"
  | "agendamento"
  | "financeiro"
  | "catalogo"
  | "dados"
  | "integracoes"
  | "controle"
  | "marketing";
export type ChatbotModuleSupportLevel = "operational" | "placeholder";
export type ChatbotModuleExecutionMode = "runtime" | "prompt" | "tool" | "placeholder";

export interface ChatbotModuleCatalogItem {
  key: ChatbotModuleKey;
  label: string;
  description: string;
  category: ChatbotModuleCategory;
  supportLevel: ChatbotModuleSupportLevel;
  executionMode: ChatbotModuleExecutionMode;
  requiresConfig: boolean;
}

export const CHATBOT_MODULE_CATALOG: ChatbotModuleCatalogItem[] = [
  {
    key: "faq",
    label: "FAQ Automático",
    description: "Responde perguntas frequentes configuradas.",
    category: "atendimento",
    supportLevel: "operational",
    executionMode: "runtime",
    requiresConfig: true
  },
  {
    key: "horarioAtendimento",
    label: "Horário de Atendimento",
    description: "Mensagem automática fora do horário configurado.",
    category: "atendimento",
    supportLevel: "operational",
    executionMode: "runtime",
    requiresConfig: true
  },
  {
    key: "antiSpam",
    label: "Anti-spam",
    description: "Ignora repetição excessiva de mensagens em curto intervalo.",
    category: "atendimento",
    supportLevel: "operational",
    executionMode: "runtime",
    requiresConfig: true
  },
  {
    key: "multiIdioma",
    label: "Multi-idioma",
    description: "Orienta a IA a responder nos idiomas permitidos; depende da aderência do modelo.",
    category: "atendimento",
    supportLevel: "operational",
    executionMode: "prompt",
    requiresConfig: true
  },
  {
    key: "agenda",
    label: "Agenda Inteligente",
    description: "Define duração e horários-base da agenda; com Google Calendar ativo, consulta a disponibilidade real.",
    category: "agendamento",
    supportLevel: "operational",
    executionMode: "prompt",
    requiresConfig: true
  },
  {
    key: "lembrete",
    label: "Lembrete Automático",
    description: "Placeholder visual; ainda não agenda envios automáticos no backend.",
    category: "agendamento",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "confirmacaoPresenca",
    label: "Confirmação de Presença",
    description: "Placeholder visual; ainda não executa follow-up automático.",
    category: "agendamento",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "cancelamentoReagendamento",
    label: "Cancel./Reagendamento",
    description: "Placeholder visual; ainda não remarca/cancela eventos automaticamente.",
    category: "agendamento",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "cobrancaAutomatica",
    label: "Cobrança Automática",
    description: "Placeholder visual; ainda não integra cobrança/PIX automaticamente.",
    category: "financeiro",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "notificacaoVencimento",
    label: "Notificação de Vencimento",
    description: "Placeholder visual; ainda não agenda notificações automáticas.",
    category: "financeiro",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "orcamentoRapido",
    label: "Orçamento Rápido",
    description: "Placeholder visual; ainda não calcula orçamento automaticamente no runtime.",
    category: "financeiro",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "catalogo",
    label: "Cardápio/Catálogo",
    description: "Placeholder visual; ainda não publica catálogo no fluxo de conversa.",
    category: "catalogo",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "pedidoWhatsApp",
    label: "Pedido pelo WhatsApp",
    description: "Placeholder visual; ainda não possui motor de carrinho/pedido.",
    category: "catalogo",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "statusPedido",
    label: "Status do Pedido",
    description: "Placeholder visual; ainda não consulta status externo.",
    category: "catalogo",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "envioMidia",
    label: "Envio de Mídia",
    description: "Placeholder visual; ainda não envia mídia por gatilho automaticamente.",
    category: "catalogo",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "capturaDados",
    label: "Captura de Dados",
    description: "Placeholder visual; ainda não mantém uma esteira dedicada de coleta estruturada.",
    category: "dados",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "nps",
    label: "NPS",
    description: "Placeholder visual; ainda não dispara pesquisa pós-atendimento automaticamente.",
    category: "dados",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "tagFollowUp",
    label: "Tag de Follow-up",
    description: "Placeholder visual; ainda não gera follow-up automatizado por tag.",
    category: "dados",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "exportarLeads",
    label: "Exportar Leads",
    description: "Placeholder visual; ainda não cria exportações dedicadas por módulo.",
    category: "dados",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "webhook",
    label: "Webhook de Saída",
    description: "Placeholder na aba de módulos; a integração webhook real vive na área de webhooks da instância.",
    category: "integracoes",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "webhookBidirecional",
    label: "Webhook Bidirecional",
    description: "Placeholder visual; ainda não possui runtime bidirecional no chatbot.",
    category: "integracoes",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "googleCalendar",
    label: "Google Calendar",
    description: "Consulta disponibilidade real e cria eventos usando as credenciais configuradas.",
    category: "integracoes",
    supportLevel: "operational",
    executionMode: "tool",
    requiresConfig: true
  },
  {
    key: "planilhaGoogle",
    label: "Planilha Google",
    description: "Placeholder visual; ainda não grava leads/pedidos em planilha automaticamente.",
    category: "integracoes",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "listaBranca",
    label: "Lista Branca",
    description: "Responde apenas para números permitidos quando ativado.",
    category: "controle",
    supportLevel: "operational",
    executionMode: "runtime",
    requiresConfig: true
  },
  {
    key: "blacklist",
    label: "Blacklist",
    description: "Bloqueia respostas automáticas para números específicos.",
    category: "controle",
    supportLevel: "operational",
    executionMode: "runtime",
    requiresConfig: true
  },
  {
    key: "limiteMensagens",
    label: "Limite de Mensagens",
    description: "Corta respostas quando o contato ultrapassa o limite configurado.",
    category: "controle",
    supportLevel: "operational",
    executionMode: "runtime",
    requiresConfig: true
  },
  {
    key: "palavraPausa",
    label: "Palavra de Pausa",
    description: "Pausa o bot quando o cliente envia uma palavra-chave configurada.",
    category: "controle",
    supportLevel: "operational",
    executionMode: "runtime",
    requiresConfig: true
  },
  {
    key: "disparoMassa",
    label: "Disparo em Massa",
    description: "Placeholder visual; ainda não possui motor de campanha/envio em lote aqui.",
    category: "marketing",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "campanhaSegmento",
    label: "Campanha por Segmento",
    description: "Placeholder visual; ainda não dispara campanhas segmentadas no chatbot.",
    category: "marketing",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "reativacao",
    label: "Reativação Automática",
    description: "Placeholder visual; ainda não agenda retomadas automáticas.",
    category: "marketing",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  },
  {
    key: "cupomPromocao",
    label: "Cupom/Promoção",
    description: "Placeholder visual; ainda não entrega cupons por gatilho automaticamente.",
    category: "marketing",
    supportLevel: "placeholder",
    executionMode: "placeholder",
    requiresConfig: true
  }
];

export interface BaseModuleConfig {
  isEnabled: boolean;
}

export interface FaqModuleConfig extends BaseModuleConfig {
  faqs: Array<{ pergunta: string; resposta: string }>;
}

export interface HorarioAtendimentoModuleConfig extends BaseModuleConfig {
  horarioInicio: string;
  horarioFim: string;
  diasSemana: number[];
  mensagemForaHorario: string;
  timezone: string;
}

export interface AntiSpamModuleConfig extends BaseModuleConfig {
  intervaloMinutos: number;
  maxMensagens: number;
}

export interface MultiIdiomaModuleConfig extends BaseModuleConfig {
  idiomasPermitidos: string[];
  idiomaPrincipal: string;
}

export interface AgendaModuleConfig extends BaseModuleConfig {
  horariosDisponiveis: string[];
  duracaoMinutos: number;
  mensagemConfirmacao: string;
}

export interface LembreteModuleConfig extends BaseModuleConfig {
  horasAntes: number;
  mensagemLembrete: string;
}

export interface ConfirmacaoPresencaModuleConfig extends BaseModuleConfig {
  mensagemConfirmacao: string;
  prazoConfirmacaoHoras: number;
}

export interface CancelamentoReagendamentoModuleConfig extends BaseModuleConfig {
  permiteCancelamento: boolean;
  permiteReagendamento: boolean;
  prazoCancelamentoHoras: number;
}

export interface CobrancaAutomaticaModuleConfig extends BaseModuleConfig {
  extratoMessage: string;
  chavePix: string;
  tipoChavePix: string;
  mensagemConfirmacao: string;
}

export interface NotificacaoVencimentoModuleConfig extends BaseModuleConfig {
  diasAntes: number;
  mensagemVencimento: string;
}

export interface OrcamentoRapidoModuleConfig extends BaseModuleConfig {
  tabelaPrecos: Array<{ servico: string; preco: number; descricao?: string }>;
  mensagemOrcamento: string;
}

export interface CatalogoModuleConfig extends BaseModuleConfig {
  produtos: Array<{ id: string; nome: string; preco: number; descricao?: string; imagemUrl?: string }>;
}

export interface PedidoWhatsAppModuleConfig extends BaseModuleConfig {
  produtos: string[];
  mostrarPreco: boolean;
  mensagemPedido: string;
}

export interface StatusPedidoModuleConfig extends BaseModuleConfig {
  statusDisponiveis: Array<{ id: string; label: string; emoji: string }>;
}

export interface EnvioMidiaModuleConfig extends BaseModuleConfig {
  gatilhos: Array<{ palavra: string; tipo: "image" | "video" | "audio" | "document"; url: string; caption?: string }>;
}

export interface CapturaDadosModuleConfig extends BaseModuleConfig {
  campos: Array<{ key: string; label: string; obrigatorio: boolean; tipo: "text" | "email" | "phone" | "select" }>;
  mensagemAgradecimento: string;
}

export interface NpsModuleConfig extends BaseModuleConfig {
  perguntas: string[];
  notaMinima: number;
  mensagemAgradecimento: string;
}

export interface TagFollowUpModuleConfig extends BaseModuleConfig {
  tags: string[];
  diasInatividade: number;
}

export interface ExportarLeadsModuleConfig extends BaseModuleConfig {
  formato: "csv" | "xlsx";
  campos: string[];
}

export interface WebhookModuleConfig extends BaseModuleConfig {
  url: string;
  secret: string;
  eventos: string[];
}

export interface WebhookBidirecionalModuleConfig extends BaseModuleConfig {
  url: string;
  secret: string;
}

export interface GoogleCalendarModuleConfig extends BaseModuleConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
}

export interface PlanilhaGoogleModuleConfig extends BaseModuleConfig {
  spreadsheetId: string;
  sheetName: string;
}

export interface ListaBrancaModuleConfig extends BaseModuleConfig {
  numeros: string[];
  modo: "permitir_todos" | "permitir_lista";
}

export interface BlacklistModuleConfig extends BaseModuleConfig {
  numeros: string[];
}

export interface LimiteMensagensModuleConfig extends BaseModuleConfig {
  maxPorHora: number;
  maxPorDia: number;
}

export interface PalavraPausaModuleConfig extends BaseModuleConfig {
  palavras: string[];
  mensagemPausa: string;
}

export interface DisparoMassaModuleConfig extends BaseModuleConfig {
  modeloMensagem: string;
  agendamentoPadrao: string;
}

export interface CampanhaSegmentoModuleConfig extends BaseModuleConfig {
  segmentoTags: string[];
  modeloMensagem: string;
}

export interface ReativacaoModuleConfig extends BaseModuleConfig {
  diasInatividade: number;
  modeloMensagem: string;
  maxPorMes: number;
}

export interface CupomPromocaoModuleConfig extends BaseModuleConfig {
  cupons: Array<{ codigo: string; desconto: number; tipo: "percentual" | "fixo"; validade: string }>;
  palavrasGatilho: string[];
}
