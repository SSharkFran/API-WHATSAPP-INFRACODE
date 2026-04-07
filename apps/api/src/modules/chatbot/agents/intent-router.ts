import { getAgendamentoAdminModuleConfig } from "../module-runtime.js";
import type { AgentContext, ChatIntent, RouterResult } from "./types.js";

/**
 * Modelo leve usado exclusivamente para classificação de intenção.
 * Alta disponibilidade (131.072 tokens/min no Groq free tier), latência ~80ms.
 * Prompt pequeno + temperatura 0 → classificação binária confiável mesmo com modelo menor.
 */
const ROUTER_MODEL = "llama-3.1-8b-instant";

const VALID_INTENTS: ChatIntent[] = ["GENERAL", "FAQ", "ESCALATE", "SCHEDULE", "HANDOFF"];

/**
 * Classifica a intenção da última mensagem do cliente usando uma chamada de IA
 * minimalista (prompt pequeno, temperatura 0, poucos tokens).
 * É a primeira etapa do OrchestratorAgent — roteia para o agent especializado certo.
 */
export class IntentRouter {
  public async classify(ctx: AgentContext): Promise<RouterResult> {
    const capabilities: string[] = [
      "- GENERAL: saudação, conversa casual, dúvida genérica que não se encaixa abaixo",
      "- FAQ: pergunta específica sobre produtos, serviços, preços, horários ou políticas da empresa"
    ];

    if (ctx.allowAdminEscalation) {
      capabilities.push("- ESCALATE: pergunta institucional específica (estoque, interno, valores exatos) que provavelmente precisa de verificação humana");
    }

    const agendamento = getAgendamentoAdminModuleConfig(ctx.modules);
    if (agendamento?.isEnabled) {
      capabilities.push("- SCHEDULE: cliente demonstra intenção de agendar reunião, visita ou encontro presencial");
    }

    capabilities.push("- HANDOFF: cliente pede EXPLICITAMENTE para falar com uma pessoa humana ou atendente");

    // Verifica se o assistente acabou de propor agendamento na ultima mensagem
    const lastAssistantMsg = [...ctx.history].reverse().find((m) => m.role === "assistant")?.content ?? "";
    const assistantJustProposedSchedule = agendamento?.isEnabled &&
      /\b(marcar|agendar|reunião|reuniao|conversa|horário|horario|disponibilidade|data e hora)\b/i.test(lastAssistantMsg);

    const systemPrompt = [
      "Você é um classificador de intenção para chatbot de WhatsApp.",
      "Analise as últimas mensagens e classifique a INTENÇÃO DA ÚLTIMA MENSAGEM do cliente.",
      "",
      "Intenções disponíveis:",
      ...capabilities,
      "",
      "Regras:",
      "- Prefira GENERAL quando houver dúvida entre FAQ e GENERAL.",
      "- ESCALATE só se o módulo estiver disponível e a pergunta for claramente institucional/interna.",
      "- SCHEDULE só se o módulo estiver disponível e o cliente demonstrar intenção clara de agendar.",
      ...(assistantJustProposedSchedule
        ? [
            "- IMPORTANTE: a última mensagem do assistente propôs um agendamento/reunião. Se o cliente CONFIRMOU (ex: 'sim', 'claro', 'com certeza', 'quero', 'pode ser', 'vamos', 'ok', 'combinado') → classifique como SCHEDULE.",
            "- Qualquer confirmação positiva após proposta de agendamento é SCHEDULE, não ESCALATE."
          ]
        : []),
      "",
      'Retorne APENAS JSON válido: {"intent":"GENERAL","confidence":0.9}'
    ].join("\n");

    // Usa apenas as últimas 6 mensagens para classificação (garante contexto de proposta anterior)
    const classifyMessages = ctx.history.slice(-6);

    try {
      const response = await ctx.callAi(systemPrompt, classifyMessages, { temperature: 0.0, model: ROUTER_MODEL });

      if (response) {
        const match = /\{[\s\S]*?\}/.exec(response);
        if (match) {
          const parsed = JSON.parse(match[0]) as { intent?: string; confidence?: number };
          const intent = parsed.intent as ChatIntent;

          if (VALID_INTENTS.includes(intent)) {
            // Valida que o intent é compatível com os módulos ativos
            const resolvedIntent: ChatIntent =
              intent === "ESCALATE" && !ctx.allowAdminEscalation ? "GENERAL"
              : intent === "SCHEDULE" && !agendamento?.isEnabled ? "GENERAL"
              : intent;

            return {
              intent: resolvedIntent,
              confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8
            };
          }
        }
      }
    } catch (err) {
      console.warn("[intent-router] falha na classificação:", err);
    }

    return { intent: "GENERAL", confidence: 0.5 };
  }
}
