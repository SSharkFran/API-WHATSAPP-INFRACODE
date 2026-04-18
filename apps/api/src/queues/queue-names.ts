export const QUEUE_NAMES = {
  SEND_MESSAGE: "send-message",
  WEBHOOK_DISPATCH: "webhook-dispatch",
  SESSION_TIMEOUT: "session-timeout",   // Plan 4.3
  KNOWLEDGE_SYNTHESIS: "knowledge-synthesis",  // Phase 5 — replaces fire-and-forget
} as const;
