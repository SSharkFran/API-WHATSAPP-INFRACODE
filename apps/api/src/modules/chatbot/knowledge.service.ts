import { randomUUID } from "node:crypto";
import type { TenantPrismaRegistry } from "../../lib/database.js";

interface KnowledgeServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
}

const SEMANTIC_SIMILARITY_THRESHOLD = 0.55;

const stopWords = new Set([
  "o", "a", "os", "as", "um", "uma", "uns", "umas",
  "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
  "por", "para", "com", "sem", "sob", "sobre", "entre",
  "e", "ou", "mas", "que", "se", "é", "sao", "foi", "ser",
  "me", "te", "se", "nos", "vos", "lhe", "lhes",
  "qual", "quais", "como", "onde", "quando", "porque", "qual",
  "voces", "vcs", "vc", "eu", "tu", "ele", "ela",
  "otimo", "obrigado", "ola", "oi", "bom", "dia", "tarde", "noite"
]);

/**
 * Normaliza texto para comparacao semantica:
 * lowercase, remove acentos, pontuacao, e stop words.
 */
const normalizeForComparison = (text: string): Set<string> => {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();

  const words = normalized.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  return new Set(words);
};

/**
 * Calcula a similaridade semantica entre dois conjuntos de palavras.
 * Usa Jaccard como base. Containment so e aplicado quando 2+ palavras coincidem,
 * evitando falsos positivos onde uma palavra isolada resulta em 100% de similaridade
 * por containment (ex: "horario" contido em "horario e preco" → seria 1.0 sem esse guard).
 */
const semanticSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const jaccard = intersection / (a.size + b.size - intersection);
  // Containment so conta quando 2+ palavras coincidem para evitar falsos positivos
  const containment = intersection >= 2 ? intersection / Math.min(a.size, b.size) : 0;

  return Math.max(jaccard, containment);
};

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
   * Salva conhecimento aprendido do admin.
   * Se ja existir uma pergunta semanticamente equivalente (similaridade >= 0.55),
   * atualiza a resposta em vez de criar um registro duplicado.
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

    const newQuestionWords = normalizeForComparison(question);

    const existing = await prisma.tenantKnowledge.findMany({
      where: { instanceId },
      select: { id: true, question: true }
    });

    let duplicateId: string | null = null;
    let bestSimilarity = 0;

    for (const record of existing) {
      const existingWords = normalizeForComparison(record.question);
      const similarity = semanticSimilarity(newQuestionWords, existingWords);
      if (similarity >= SEMANTIC_SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        duplicateId = record.id;
      }
    }

    if (duplicateId) {
      console.log(`[knowledge] pergunta similar encontrada (${(bestSimilarity * 100).toFixed(0)}% match), atualizando id=${duplicateId}`);
      const updated = await prisma.tenantKnowledge.update({
        where: { id: duplicateId },
        data: {
          answer: answer.trim(),
          rawAnswer: rawAnswer.trim(),
          taughtBy
        }
      });
      return this.mapRecord(updated);
    }

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
   * Lista todo o conhecimento aprendido de uma instancia, ordenado por mais recente.
   */
  public async list(
    tenantId: string,
    instanceId: string
  ): Promise<LearnedKnowledge[]> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const records = await prisma.tenantKnowledge.findMany({
      where: { instanceId },
      orderBy: { createdAt: "desc" }
    });
    return records.map((r) => this.mapRecord(r));
  }

  /**
   * Remove um conhecimento pelo ID.
   * Retorna false se o registro nao pertencer a instancia.
   */
  public async delete(
    tenantId: string,
    instanceId: string,
    knowledgeId: string
  ): Promise<boolean> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const existing = await prisma.tenantKnowledge.findFirst({
      where: { id: knowledgeId, instanceId },
      select: { id: true }
    });
    if (!existing) return false;
    await prisma.tenantKnowledge.delete({ where: { id: knowledgeId } });
    return true;
  }

  /**
   * Atualiza a resposta de um conhecimento existente.
   * Retorna null se o registro nao pertencer a instancia.
   */
  public async update(
    tenantId: string,
    instanceId: string,
    knowledgeId: string,
    answer: string
  ): Promise<LearnedKnowledge | null> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const existing = await prisma.tenantKnowledge.findFirst({
      where: { id: knowledgeId, instanceId },
      select: { id: true }
    });
    if (!existing) return null;
    const updated = await prisma.tenantKnowledge.update({
      where: { id: knowledgeId },
      data: { answer: answer.trim(), rawAnswer: answer.trim(), taughtBy: "admin_panel" }
    });
    return this.mapRecord(updated);
  }

  /**
   * Invalida a sintese de conhecimento gerada por IA para a instancia.
   * Chamado automaticamente apos PATCH ou DELETE de knowledge.
   */
  public async invalidateSynthesis(tenantId: string, instanceId: string): Promise<void> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    await prisma.chatbotConfig.updateMany({
      where: { instanceId },
      data: { knowledgeSynthesis: null, knowledgeSynthesisUpdatedAt: null }
    });
  }

  /**
   * Retorna o conhecimento da instancia como bloco de contexto para o system prompt.
   * Prioriza o documento de sintese (gerado por IA, organizado e deduplicado).
   * Fallback para lista crua de Q&As se sintese ainda nao existir.
   */
  public async buildContextBlock(
    tenantId: string,
    instanceId: string
  ): Promise<string | null> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);

    const config = await prisma.chatbotConfig.findUnique({
      where: { instanceId },
      select: { knowledgeSynthesis: true }
    });

    if (config?.knowledgeSynthesis?.trim()) {
      return [
        "### BASE DE CONHECIMENTO DA EMPRESA ###",
        "As informacoes abaixo foram organizadas e validadas pelo administrador. Use como fonte de verdade:",
        config.knowledgeSynthesis.trim()
      ].join("\n");
    }

    // fallback: lista crua enquanto sintese ainda nao foi gerada
    const records = await prisma.tenantKnowledge.findMany({
      where: { instanceId },
      orderBy: { createdAt: "asc" },
      select: { question: true, answer: true }
    });

    if (records.length === 0) {
      return null;
    }

    const lines = records.map(
      (record, index) => `${index + 1}. Pergunta: "${record.question}"\n   Resposta: ${record.answer}`
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
    updatedAt?: Date;
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
