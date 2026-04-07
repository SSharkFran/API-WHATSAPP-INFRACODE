import type { AgentContext } from "./types.js";

/**
 * Agent de conversação geral — fallback para interações que não se encaixam
 * em FAQ, escalação ou agendamento. Recebe o contexto completo e responde
 * de forma natural e breve como um atendente humano.
 */
export class GeneralAgent {
  public async respond(ctx: AgentContext): Promise<string | null> {
    const { blocks, allowAdminEscalation } = ctx;

    const parts: string[] = [];

    if (blocks.globalSystemPrompt) {
      parts.push(`### PROMPT GLOBAL DA PLATAFORMA ###\n${blocks.globalSystemPrompt}`);
    }
    parts.push(blocks.baseSystemPrompt);
    parts.push(blocks.currentDateLine);
    parts.push(`Número do cliente: ${blocks.phoneNumber}.`);

    if (blocks.memoryMd) {
      parts.push(`--- CONTEXTO LOCAL ---\n${blocks.memoryMd}`);
    }
    if (blocks.clientContext) {
      parts.push(blocks.clientContext);
    }
    if (blocks.knowledge) {
      parts.push(blocks.knowledge);
    }
    if (blocks.persistentMemory) {
      parts.push(blocks.persistentMemory);
    }

    const escalationRule = allowAdminEscalation
      ? [
          "7. Para perguntas institucionais (preços específicos, dados internos, informações não documentadas): use [ESCALATE_ADMIN].",
          "8. NUNCA escreva 'vou verificar', 'vou confirmar', 'aguarde que consulto' sem incluir [ESCALATE_ADMIN] na mesma mensagem."
        ]
      : [
          "7. Se faltar informação institucional: diga brevemente que não tem essa informação disponível agora. NUNCA diga 'vou verificar' — você não consegue consultar ninguém.",
          "8. Não use [ESCALATE_ADMIN] neste modo."
        ];

    parts.push([
      "### REGRAS GERAIS ###",
      "1. BREVIDADE OBRIGATÓRIA: máximo 2-3 frases por mensagem. Use '|||' para separar múltiplas mensagens. PROIBIDO: bullets, listas numeradas, parágrafos longos.",
      "2. Use o nome do cliente SOMENTE se aparecer na MEMORIA DO CLIENTE. Nunca use placeholders como {nome} ou [nome].",
      "3. Nunca invente informações, preços, datas ou dados não documentados.",
      "4. Cumprimentos (oi, olá, bom dia, boa tarde) são SEMPRE abertura — responda com entusiasmo e pergunte como pode ajudar.",
      "5. Nunca diga que você é uma IA a menos que o cliente pergunte diretamente.",
      "6. Se o cliente pedir explicitamente para falar com humano: responda com [TRANSBORDO_HUMANO].",
      ...escalationRule
    ].join("\n"));

    return ctx.callAi(parts.join("\n\n"), ctx.history, { temperature: 0.7 });
  }
}
