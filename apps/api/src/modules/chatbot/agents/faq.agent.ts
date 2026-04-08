import type { AgentContext } from "./types.js";

/** Melhor modelo do Groq — segue instruções complexas e PT-BR com precisão. */
const SPECIALIST_MODEL = "llama-3.3-70b-versatile";

/**
 * Agent especializado em responder perguntas sobre produtos, serviços e informações
 * da empresa. Usa APENAS o que está documentado no contexto — nunca inventa.
 */
export class FaqAgent {
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
    if (blocks.clientContext) {
      parts.push(blocks.clientContext);
    }
    if (blocks.knowledge) {
      parts.push(blocks.knowledge);
    }
    if (blocks.servicesAndPrices) {
      parts.push(blocks.servicesAndPrices);
    }
    if (blocks.persistentMemory) {
      parts.push(blocks.persistentMemory);
    }

    parts.push([
      "### REGRAS DE RESPOSTA ###",
      "1. FORMATAÇÃO E BREVIDADE:",
      "   - Use '|||' para separar múltiplas mensagens (máximo 2-3 frases cada).",
      "   - PROIBIDO: enumerar preços ou serviços em uma única frase longa separada por vírgulas.",
      "   - Para tabelas de preços/serviços: use *negrito* para o título do veículo/categoria (ex: *HB20x — Porte Pequeno:*) e quebre cada serviço em nova linha (ex: • Essencial: R$120). Se houver mais de um veículo, separe cada um em mensagem distinta via '|||'.",
      "   - Mensagens de texto puro (saudação, pergunta, CTA) continuam curtas, sem formatação.",
      "2. Responda com base EXCLUSIVAMENTE no contexto documentado acima.",
      "3. Se a informação solicitada NÃO estiver no contexto: diga apenas 'Não tenho essa informação disponível no momento.' — sem inventar, sem especular.",
      "4. Nunca invente preços, prazos, especificações ou dados não documentados.",
      "5. Use o nome do cliente somente se aparecer no bloco MEMORIA DO CLIENTE.",
      "6. Nunca diga que é uma IA a menos que perguntado diretamente."
    ].join("\n"));

    return ctx.callAi(parts.join("\n\n"), ctx.history, { temperature: 0.3, model: SPECIALIST_MODEL });
  }
}
