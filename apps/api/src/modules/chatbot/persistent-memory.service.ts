import type { MemoriaPersonalizadaField } from "@infracode/types";
import type { TenantPrismaRegistry } from "../../lib/database.js";

interface PersistentMemoryServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
}

interface AiCallOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class PersistentMemoryService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;

  public constructor(deps: PersistentMemoryServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
  }

  /**
   * Retorna os dados de memoria persistente de um contato como objeto.
   */
  public async getData(
    tenantId: string,
    instanceId: string,
    phoneNumber: string
  ): Promise<Record<string, string | null>> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const record = await prisma.contactPersistentMemory.findUnique({
      where: { instanceId_phoneNumber: { instanceId, phoneNumber } },
      select: { data: true }
    });

    if (!record?.data || typeof record.data !== "object" || Array.isArray(record.data)) {
      return {};
    }

    return record.data as Record<string, string | null>;
  }

  /**
   * Formata o bloco de contexto para injecao no system prompt.
   */
  public buildContextBlock(
    data: Record<string, string | null>,
    fields: MemoriaPersonalizadaField[]
  ): string | null {
    const lines: string[] = [];

    for (const field of fields) {
      const value = data[field.key];
      if (value && value.trim()) {
        lines.push(`${field.label}: ${value.trim()}`);
      }
    }

    if (lines.length === 0) {
      return null;
    }

    return [
      "### MEMORIA DO CLIENTE ###",
      "(Informacoes coletadas em conversas anteriores — use como contexto, nao mencione ao cliente)",
      ...lines
    ].join("\n");
  }

  /**
   * Executa extracao de dados da conversa via IA e salva no banco.
   * Deve ser chamado de forma assíncrona (fire-and-forget) para nao bloquear a resposta.
   */
  public async extractAndSave(
    tenantId: string,
    instanceId: string,
    phoneNumber: string,
    recentMessages: Array<{ role: "user" | "assistant"; content: string }>,
    fields: MemoriaPersonalizadaField[],
    ai: AiCallOptions
  ): Promise<void> {
    if (fields.length === 0 || recentMessages.length === 0) {
      return;
    }

    const existingData = await this.getData(tenantId, instanceId, phoneNumber);

    const fieldDescriptions = fields
      .map((f) => `- "${f.key}": ${f.label} — ${f.description}`)
      .join("\n");

    const currentJson = JSON.stringify(
      Object.fromEntries(fields.map((f) => [f.key, existingData[f.key] ?? null])),
      null,
      2
    );

    const conversationText = recentMessages
      .slice(-10)
      .map((m) => `${m.role === "user" ? "Cliente" : "Assistente"}: ${m.content}`)
      .join("\n");

    const systemPrompt = [
      "Voce e um extrator de dados para um sistema de CRM via WhatsApp.",
      "Analise o trecho de conversa e extraia ou atualize as informacoes sobre o cliente.",
      "Retorne APENAS um objeto JSON valido, sem markdown, sem explicacao.",
      "Use null para campos nao mencionados neste trecho.",
      "Extraia somente o que o cliente afirmou explicitamente. Nao invente dados.",
      "",
      "Campos a extrair:",
      fieldDescriptions
    ].join("\n");

    const userPrompt = [
      `Dados conhecidos atualmente:\n${currentJson}`,
      "",
      `Trecho da conversa:\n${conversationText}`,
      "",
      "Retorne o JSON atualizado com os campos extraidos (null se nao mencionado neste trecho):"
    ].join("\n");

    let extracted: Record<string, string | null> = {};

    try {
      const url = new URL(
        "chat/completions",
        ai.baseUrl.endsWith("/") ? ai.baseUrl : `${ai.baseUrl}/`
      ).toString();

      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${ai.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: ai.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.1,
          max_tokens: 400
        })
      });

      if (!response.ok) {
        console.warn(`[persistent-memory] AI retornou ${response.status}, pulando extracao`);
        return;
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn("[persistent-memory] resposta da IA nao continha JSON valido");
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      for (const field of fields) {
        const val = parsed[field.key];
        if (typeof val === "string" && val.trim()) {
          extracted[field.key] = val.trim();
        }
      }
    } catch (err) {
      console.warn("[persistent-memory] erro na extracao via IA:", err);
      return;
    }

    const hasNewData = Object.keys(extracted).length > 0;
    if (!hasNewData) {
      return;
    }

    const mergedData: Record<string, string | null> = { ...existingData };
    for (const [key, value] of Object.entries(extracted)) {
      if (value && value.trim()) {
        mergedData[key] = value.trim();
      }
    }

    try {
      const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
      await prisma.contactPersistentMemory.upsert({
        where: { instanceId_phoneNumber: { instanceId, phoneNumber } },
        create: { instanceId, phoneNumber, data: mergedData },
        update: { data: mergedData }
      });
      console.log(`[persistent-memory] memoria atualizada para ${phoneNumber} (${Object.keys(extracted).length} campos)`);
    } catch (err) {
      console.error("[persistent-memory] erro ao salvar no banco:", err);
    }
  }
}
