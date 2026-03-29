import { randomUUID } from "node:crypto";
import type { TenantPrismaRegistry } from "../../lib/database.js";

interface KnowledgeServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
}

export interface LearnedKnowledge {
  id: string;
  instanceId: string;
  question: string;
  answer: string;
  rawAnswer: string | null;
  taughtBy: string | null;
  createdAt: string;
}

export class KnowledgeService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;

  public constructor(deps: KnowledgeServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
  }

  /**
   * Salva conhecimento aprendido do admin no Supabase.
   */
  public async save(
    tenantId: string,
    instanceId: string,
    question: string,
    answer: string,
    rawAnswer: string,
    taughtBy: string
  ): Promise<LearnedKnowledge> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const record = await prisma.tenantKnowledge.create({
      data: {
        id: randomUUID(),
        instanceId,
        question: question.trim(),
        answer: answer.trim(),
        rawAnswer: rawAnswer.trim(),
        taughtBy
      }
    });

    return this.mapRecord(record);
  }

  /**
   * Retorna todos os conhecimentos da instancia como bloco de contexto
   * para injetar no system prompt do LLM.
   */
  public async buildContextBlock(
    tenantId: string,
    instanceId: string
  ): Promise<string | null> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const records = await prisma.tenantKnowledge.findMany({
      where: { instanceId },
      orderBy: { createdAt: "asc" },
      select: { question: true, answer: true }
    });

    if (records.length === 0) {
      return null;
    }

    const lines = records.map(
      (record, index) => `${index + 1}. Pergunta: "${record.question}"\n   Resposta: "${record.answer}"`
    );

    return [
      "### CONHECIMENTO APRENDIDO COM O ADMIN ###",
      "As informacoes abaixo foram ensinadas pelo administrador e devem ser usadas como verdade:",
      ...lines
    ].join("\n");
  }

  private mapRecord(record: {
    id: string;
    instanceId: string;
    question: string;
    answer: string;
    rawAnswer: string | null;
    taughtBy: string | null;
    createdAt: Date;
  }): LearnedKnowledge {
    return {
      id: record.id,
      instanceId: record.instanceId,
      question: record.question,
      answer: record.answer,
      rawAnswer: record.rawAnswer,
      taughtBy: record.taughtBy,
      createdAt: record.createdAt.toISOString()
    };
  }
}
