import { EscalationAgent } from "./escalation.agent.js";
import { FaqAgent } from "./faq.agent.js";
import { GeneralAgent } from "./general.agent.js";
import { IntentRouter } from "./intent-router.js";
import { SchedulingAgent } from "./scheduling.agent.js";
import type { AgentContext, RouterResult } from "./types.js";

/**
 * Orquestrador central dos sub-agents.
 *
 * Fluxo:
 *  1. IntentRouter classifica a intenção (1 chamada de IA rápida)
 *  2. Roteia para o agent especializado correto
 *  3. Se qualquer etapa falhar → cai no GeneralAgent como fallback seguro
 *
 * Cada agent especializado tem um system prompt focado — sem sobrecarga de
 * regras irrelevantes para o contexto.
 */
export class OrchestratorAgent {
  private readonly intentRouter = new IntentRouter();
  private readonly faqAgent = new FaqAgent();
  private readonly escalationAgent = new EscalationAgent();
  private readonly schedulingAgent = new SchedulingAgent();
  private readonly generalAgent = new GeneralAgent();

  public async process(ctx: AgentContext): Promise<string | null> {
    let routerResult: RouterResult;

    try {
      routerResult = await this.intentRouter.classify(ctx);
      console.log(`[orchestrator] intent=${routerResult.intent} confidence=${routerResult.confidence.toFixed(2)}`);
    } catch (err) {
      console.warn("[orchestrator] IntentRouter falhou, usando GENERAL como fallback:", err);
      routerResult = { intent: "GENERAL", confidence: 0.5 };
    }

    try {
      switch (routerResult.intent) {
        case "FAQ":
          return await this.faqAgent.respond(ctx);

        case "ESCALATE":
          return await this.escalationAgent.respond(ctx);

        case "SCHEDULE":
          return await this.schedulingAgent.respond(ctx);

        case "HANDOFF":
          // Não precisa de chamada de IA — retorna o marcador diretamente
          return "[TRANSBORDO_HUMANO]";

        case "GENERAL":
        default:
          return await this.generalAgent.respond(ctx);
      }
    } catch (err) {
      console.warn(`[orchestrator] agent para intent="${routerResult.intent}" falhou, caindo no GeneralAgent:`, err);
      try {
        return await this.generalAgent.respond(ctx);
      } catch (fallbackErr) {
        console.error("[orchestrator] GeneralAgent também falhou:", fallbackErr);
        return null; // IA-03: never return undefined — null signals "no response available"
      }
    }
  }
}
