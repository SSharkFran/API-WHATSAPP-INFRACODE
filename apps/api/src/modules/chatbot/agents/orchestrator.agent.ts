import { EscalationAgent } from "./escalation.agent.js";
import { FaqAgent } from "./faq.agent.js";
import { GeneralAgent } from "./general.agent.js";
import { IntentRouter } from "./intent-router.js";
import { SchedulingAgent } from "./scheduling.agent.js";
import type { AgentContext, RouterResult } from "./types.js";
import type pino from "pino";

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
  private readonly logger?: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger = logger;
  }

  public async process(ctx: AgentContext): Promise<string | null> {
    let routerResult: RouterResult;

    try {
      routerResult = await this.intentRouter.classify(ctx);
      this.logger?.debug({ intent: routerResult.intent, confidence: routerResult.confidence }, '[orchestrator] intent classified');
    } catch (err) {
      this.logger?.warn({ err }, '[orchestrator] IntentRouter failed — falling back to GENERAL');
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
      this.logger?.warn({ err, intent: routerResult.intent }, '[orchestrator] sub-agent failed — falling back to GeneralAgent');
      try {
        return await this.generalAgent.respond(ctx);
      } catch (fallbackErr) {
        this.logger?.error({ err: fallbackErr }, '[orchestrator] GeneralAgent also failed — returning null');
        return null; // IA-03: never return undefined — null signals "no response available"
      }
    }
  }
}
