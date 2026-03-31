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
 * Usa o maximo entre Jaccard e Containment para lidar bem com perguntas curtas:
 * - Jaccard: bom para perguntas de tamanho similar
 * - Containment: se as palavras de A estao contidas em B (ou vice-versa),
 *   considera similar mesmo que B tenha palavras extras (ex: "endereco" vs "endereco empresa")
 */
const semanticSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const jaccard = intersection / (a.size + b.size - intersection);
  const containment = intersection / Math.min(a.size, b.size);

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
