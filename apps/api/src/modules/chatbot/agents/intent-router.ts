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

    // Detecta se o assistente CONFIRMOU/CONCLUIU um agendamento — ou seja, já disse algo como
    // "tudo certo", "agendado", "confirmado", "marcado", "especialista vai entrar em contato".
    // Nesse caso, qualquer confirmação do cliente ("correto", "ok", "sim") é GENERAL, não SCHEDULE.
    const assistantJustConfirmedSchedule = agendamento?.isEnabled &&
      /\b(tudo certo|agendado|confirmado|marcado|registrad[oa]|entrar em contato|verificando a disponibilidade|Estou verificando)\b/i.test(lastAssistantMsg);

    // Proposta de agendamento: bot OFERECEU agendar mas ainda NÃO confirmou
    const assistantJustProposedSchedule = agendamento?.isEnabled &&
      !assistantJustConfirmedSchedule &&
      /\b(marcar|agendar|reunião|reuniao|conversa|horário|horario|disponibilidade|data e hora)\b/i.test(lastAssistantMsg);

    // Detecta se a última mensagem do assistente fez uma pergunta de confirmação (sim/não)
    const assistantJustAskedConfirmation = /\?(\s*)$/.test(lastAssistantMsg.trim()) ||
      /\b(é isso|correto|certo|confirma|confirmar|pode ser|tá certo|está certo)\b\s*[\?]?\s*$/i.test(lastAssistantMsg.trim());

    const systemPrompt = [
      "Você é um classificador de intenção para chatbot de WhatsApp.",
      "Analise as últimas mensagens e classifique a INTENÇÃO DA ÚLTIMA MENSAGEM do cliente.",
      "",
      "Intenções disponíveis:",
      ...capabilities,
      "",
      "Regras OBRIGATÓRIAS:",
      "- Prefira GENERAL quando houver qualquer dúvida.",
      "- ESCALATE exige: pergunta ESPECÍFICA sobre dado interno (ex: estoque exato, preço interno, prazo específico não documentado). Confidence mínimo: 0.85.",
      "- ESCALATE NUNCA deve ser usado para: confirmações (sim/não/exatamente), intenções de compra/contratação, pedidos genéricos de serviço, ou continuações de conversa.",
      "- Expressões de intenção ('quero contratar', 'quero fazer', 'sim quero') → SEMPRE GENERAL ou FAQ, NUNCA ESCALATE.",
      "- Preferências de horário/data ('pode ser amanhã', 'às 15h', 'quinta-feira') → SEMPRE GENERAL, NUNCA ESCALATE.",
      "- SCHEDULE só se o módulo estiver disponível e o cliente demonstrar intenção clara de agendar.",
      ...(assistantJustProposedSchedule
        ? [
            "- IMPORTANTE: a última mensagem do assistente propôs um agendamento/reunião. Se o cliente CONFIRMOU (ex: 'sim', 'claro', 'com certeza', 'quero', 'pode ser', 'vamos', 'ok', 'combinado') → classifique como SCHEDULE.",
            "- Qualquer confirmação positiva após proposta de agendamento é SCHEDULE, não ESCALATE."
          ]
        : []),
      ...(assistantJustConfirmedSchedule
        ? [
            "- IMPORTANTE: o assistente já CONFIRMOU/CONCLUIU um agendamento na última mensagem. O agendamento JÁ FOI FEITO. Qualquer resposta do cliente agora (ex: 'correto', 'ok', 'obrigado', 'perfeito', 'sim') é SEMPRE GENERAL, nunca SCHEDULE.",
            "- NÃO re-classifique como SCHEDULE — o agendamento já está concluído."
          ]
        : []),
      ...(assistantJustAskedConfirmation
        ? [
            "- IMPORTANTE: a última mensagem do assistente fez uma pergunta de confirmação. Se o cliente confirmou (ex: 'sim', 'exatamente', 'isso mesmo', 'correto', 'é isso', 'perfeito') → classifique como GENERAL.",
            "- Confirmações após pergunta do assistente são SEMPRE GENERAL, nunca ESCALATE."
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
            const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.8;

            // Valida que o intent é compatível com os módulos ativos
            // ESCALATE requer confiança >= 0.85 — threshold alto para evitar falsos positivos
            // que geram notificações desnecessárias ao admin
            const resolvedIntent: ChatIntent =
              intent === "ESCALATE" && !ctx.allowAdminEscalation ? "GENERAL"
              : intent === "ESCALATE" && confidence < 0.85 ? "GENERAL"
              : intent === "SCHEDULE" && !agendamento?.isEnabled ? "GENERAL"
              : intent === "SCHEDULE" && assistantJustConfirmedSchedule ? "GENERAL"
              : intent;

            return { intent: resolvedIntent, confidence };
          }
        }
      }
    } catch (err) {
      console.warn("[intent-router] falha na classificação:", err);
    }

    return { intent: "GENERAL", confidence: 0.5 };
  }
}
