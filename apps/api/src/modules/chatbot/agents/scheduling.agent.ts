import { getAgendamentoAdminModuleConfig } from "../module-runtime.js";
import type { AgentContext } from "./types.js";

/** Melhor modelo do Groq — segue instruções complexas e PT-BR com precisão. */
const SPECIALIST_MODEL = "llama-3.3-70b-versatile";

/**
 * Agent especializado em coletar informações de agendamento e emitir o marcador
 * [AGENDAR_ADMIN:{...}] quando tiver nome e assunto do cliente.
 * Usado quando o IntentRouter classifica a intenção como "SCHEDULE".
 */
export class SchedulingAgent {
  public async respond(ctx: AgentContext): Promise<string | null> {
    const { blocks, modules } = ctx;
    const agendamentoConfig = getAgendamentoAdminModuleConfig(modules);

    const parts: string[] = [];

    if (blocks.globalSystemPrompt) {
      parts.push(`### PROMPT GLOBAL DA PLATAFORMA ###\n${blocks.globalSystemPrompt}`);
    }
    parts.push(blocks.baseSystemPrompt);
    parts.push(blocks.currentDateLine);

    if (blocks.servicesAndPrices) {
      parts.push(blocks.servicesAndPrices);
    }
    if (blocks.persistentMemory) {
      parts.push(blocks.persistentMemory);
    }

    parts.push([
      "### AGENDAMENTO VIA ADMINISTRADOR ###",
      "O cliente demonstrou intenção de agendar. Seu objetivo é coletar as informações mínimas e emitir o marcador de agendamento.",
      "",
      "FLUXO OBRIGATÓRIO (siga em ordem):",
      "1. NOME: Se o nome do cliente já está na MEMORIA DO CLIENTE acima → não pergunte novamente. Caso contrário, pergunte em uma mensagem curta.",
      "2. ASSUNTO: Pergunte o motivo/assunto da reunião em uma mensagem curta.",
      "3. DATA: Se o cliente mencionar preferência de data/horário, registre. Se não, use 'Sem preferência'.",
      "4. EMITIR MARCADOR: Assim que tiver nome + assunto, inclua EXATAMENTE este marcador no início da sua resposta:",
      '   [AGENDAR_ADMIN:{"assunto":"<assunto>","dataPreferencia":"<preferência ou Sem preferência>","clientName":"<nome>"}]',
      "5. Após o marcador, escreva UMA mensagem curta informando que está verificando disponibilidade.",
      "",
      "REGRAS:",
      "- Máximo 2 perguntas antes de emitir o marcador.",
      "- BREVIDADE: máximo 2-3 frases por mensagem. Use '|||' para separar mensagens.",
      "- NUNCA invente horários disponíveis ou confirme data/horário sem verificação real.",
      "- NUNCA discuta detalhes técnicos, orçamentos ou escopo antes da reunião.",
      "- OBRIGATÓRIO: ao calcular datas relativas ('essa quinta', 'amanhã', 'semana que vem'), use SEMPRE a data atual informada acima. O ANO é o da data atual — NUNCA use 2024 ou outro ano diferente.",
      ...(agendamentoConfig?.clientPendingMessage
        ? [`- Mensagem padrão para o cliente após o marcador: "${agendamentoConfig.clientPendingMessage}"`]
        : [])
    ].join("\n"));

    return ctx.callAi(parts.join("\n\n"), ctx.history, { temperature: 0.4, model: SPECIALIST_MODEL });
  }
}
