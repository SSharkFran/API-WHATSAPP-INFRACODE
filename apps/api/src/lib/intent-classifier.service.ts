import type { AiCaller } from "../modules/chatbot/agents/types.js";

// ---------------------------------------------------------------------------
// IA-01: LLM-based intent pre-pass classifier for Brazilian Portuguese
// Replaces the static recognizeCloseIntent regex stub from session-intents.ts
// ---------------------------------------------------------------------------

const CLASSIFIER_MODEL = "llama-3.1-8b-instant";

export type IntentLabel =
  | "ENCERRAMENTO"
  | "URGENCIA_ALTA"
  | "TRANSFERENCIA_HUMANO"
  | "PERGUNTA"
  | "CONTINUACAO"
  | "OUTRO";

export const VALID_INTENT_LABELS: IntentLabel[] = [
  "ENCERRAMENTO",
  "URGENCIA_ALTA",
  "TRANSFERENCIA_HUMANO",
  "PERGUNTA",
  "CONTINUACAO",
  "OUTRO",
];

export interface IntentClassification {
  label: IntentLabel;
  confidence: number;
}

const FALLBACK: IntentClassification = { label: "OUTRO", confidence: 0.5 };

const SYSTEM_PROMPT = `Você é um classificador de intenção para chatbot de WhatsApp em português do Brasil.
Analise a ÚLTIMA mensagem do cliente considerando o contexto das mensagens anteriores.
Classifique em EXATAMENTE uma das categorias:
- ENCERRAMENTO: cliente quer encerrar (obrigado/tchau/era só isso/pode fechar/finalizado)
- URGENCIA_ALTA: situação urgente, pressão de tempo, problema crítico
- TRANSFERENCIA_HUMANO: cliente pede explicitamente para falar com humano/atendente
- PERGUNTA: dúvida ou pergunta sobre produto/serviço
- CONTINUACAO: resposta a uma pergunta anterior, confirmação ou continuação natural
- OUTRO: qualquer outra coisa

REGRAS:
- 'obrigado' isolado no meio de conversa ativa → CONTINUACAO, não ENCERRAMENTO
- 'obrigado' após resolver o que o cliente veio buscar → ENCERRAMENTO
- Use o contexto das últimas mensagens para decidir

Retorne APENAS JSON válido: {"label":"ENCERRAMENTO","confidence":0.92}`;

/**
 * Classifies the intent of a client message using an LLM pre-pass.
 *
 * Security:
 * - T-5-01: Client text is wrapped in <message> delimiters (not interpolated raw into the system prompt)
 * - T-5-02: LLM response label is validated against VALID_INTENT_LABELS whitelist
 *
 * Reliability:
 * - T-5-05: Entire function is wrapped in try/catch — always returns FALLBACK on any failure, never throws
 *
 * @param text - The client's latest message text
 * @param callAi - Injected AiCaller (same GroqKeyRotator-backed caller used by IntentRouter)
 * @param recentHistory - Optional recent conversation history for context (last 3 exchanges used)
 */
export async function classifyIntent(
  text: string,
  callAi: AiCaller,
  recentHistory?: Array<{ role: "user" | "assistant"; content: string }>
): Promise<IntentClassification> {
  try {
    // T-5-01: Wrap client text in delimiters — never interpolate rawTextInput directly into system prompt
    const userContent = `<message>${text}</message>`;

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      ...(recentHistory?.slice(-3) ?? []),
      { role: "user", content: userContent },
    ];

    const response = await callAi(SYSTEM_PROMPT, messages, {
      temperature: 0,
      model: CLASSIFIER_MODEL,
    });

    if (!response) {
      return FALLBACK;
    }

    // JSON extraction — same pattern as IntentRouter
    const match = /\{[\s\S]*?\}/.exec(response);
    if (!match) {
      return FALLBACK;
    }

    const parsed = JSON.parse(match[0]) as { label?: string; confidence?: number };

    // T-5-02: Validate label against VALID_INTENT_LABELS whitelist — prevents hallucinated labels
    if (!VALID_INTENT_LABELS.includes(parsed.label as IntentLabel)) {
      return FALLBACK;
    }

    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;

    return {
      label: parsed.label as IntentLabel,
      confidence,
    };
  } catch {
    // T-5-05: Any failure (network, JSON parse, etc.) returns FALLBACK — never throws
    return FALLBACK;
  }
}
