import type { AgentContext } from "./types.js";

/** Melhor modelo do Groq — segue instruções complexas e PT-BR com precisão. */
const SPECIALIST_MODEL = "llama-3.3-70b-versatile";

/**
 * Agent especializado em lidar com perguntas que requerem verificação interna.
 * Tem duas saídas possíveis:
 * - Se a resposta ESTÁ no contexto documentado: responde brevemente.
 * - Se NÃO está: retorna exatamente [ESCALATE_ADMIN] para o sistema disparar o fluxo de escalação.
 */
export class EscalationAgent {
  public async respond(ctx: AgentContext): Promise<string | null> {
    const { blocks } = ctx;

    const parts: string[] = [];

    if (blocks.globalSystemPrompt) {
      parts.push(`### PROMPT GLOBAL DA PLATAFORMA ###\n${blocks.globalSystemPrompt}`);
    }
    parts.push(blocks.baseSystemPrompt);
    parts.push(blocks.currentDateLine);

    if (blocks.memoryMd) {
      parts.push(`--- CONTEXTO LOCAL ---\n${blocks.memoryMd}`);
    }
    if (blocks.knowledge) {
      parts.push(blocks.knowledge);
    }
    if (blocks.persistentMemory) {
      parts.push(blocks.persistentMemory);
    }

    parts.push([
      "### REGRA DE ESCALAÇÃO — LEIA COM ATENÇÃO ###",
      "O cliente fez uma pergunta que pode requerer verificação com o administrador.",
      "",
      "Sua ÚNICA decisão é:",
      "A) A resposta está EXPLICITAMENTE documentada no contexto acima? → Responda em 1-2 frases curtas.",
      "B) A resposta NÃO está no contexto? → Responda EXATAMENTE com o token: [ESCALATE_ADMIN]",
      "   (sem nenhum texto antes ou depois do token)",
      "",
      "PROIBIDO:",
      "- Inventar informações, preços, datas ou dados não documentados.",
      "- Usar frases como 'vou verificar', 'vou confirmar', 'aguarde que consulto' sem incluir [ESCALATE_ADMIN].",
      "- Responder de forma vaga ou ambígua.",
      "- Textos longos ou formatação com bullets.",
      "",
      "EXEMPLOS CORRETOS:",
      "Pergunta: 'Qual o preço do serviço X?' | Preço não está no contexto → responda: [ESCALATE_ADMIN]",
      "Pergunta: 'Vocês atendem aos sábados?' | Horário está no contexto → responda brevemente."
    ].join("\n"));

    return ctx.callAi(parts.join("\n\n"), ctx.history, { temperature: 0.0, model: SPECIALIST_MODEL });
  }
}
