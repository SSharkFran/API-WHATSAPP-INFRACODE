import { getAgendamentoAdminModuleConfig } from "../module-runtime.js";
import type { AgentContext, ChatIntent, RouterResult } from "./types.js";

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
      "",
      'Retorne APENAS JSON válido: {"intent":"GENERAL","confidence":0.9}'
    ].join("\n");

    // Usa apenas as últimas 4 mensagens para classificação (rápido e focado)
    const classifyMessages = ctx.history.slice(-4);

    try {
      const response = await ctx.callAi(systemPrompt, classifyMessages, { temperature: 0.0 });

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
