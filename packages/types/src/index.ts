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
export type ChatbotAiProvider = "GROQ" | "OPENAI_COMPATIBLE" | "ANTHROPIC";

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
  leadsGroupJid?: string | null;
  leadsGroupName?: string | null;
  leadsPhoneNumber?: string | null;
  leadsEnabled?: boolean;
  fiadoEnabled?: boolean;
  rules: ChatbotRule[];
  ai: ChatbotAiConfig;
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
  | "fechado";

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
  action: "MATCHED" | "WELCOME" | "FALLBACK" | "AI" | "NO_MATCH";
  matchedRuleId?: string | null;
  matchedRuleName?: string | null;
  responseText?: string | null;
}
