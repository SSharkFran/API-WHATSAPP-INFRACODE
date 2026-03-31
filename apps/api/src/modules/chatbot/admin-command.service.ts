import { decrypt } from "../../lib/crypto.js";
import type { TenantPrismaRegistry } from "../../lib/database.js";
import type { PlatformPrisma } from "../../lib/database.js";

interface AdminCommandServiceConfig {
  API_ENCRYPTION_KEY: string;
}

interface AdminCommandServiceDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
  platformPrisma: PlatformPrisma;
  config: AdminCommandServiceConfig;
}

export interface AdminCommandContext {
  tenantId: string;
  instanceId: string;
  text: string;
  sendResponse: (text: string) => Promise<void>;
  sendMessageToClient: (jid: string, normalizedPhone: string, text: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI-compatible para GROQ)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "estatisticas_atendimentos",
      description: "Retorna estatísticas de atendimentos: total, abertos, fechados, com humanTakeover. Usa o campo lastMessageAt para filtrar por período.",
      parameters: {
        type: "object",
        properties: {
          periodo_dias: {
            type: "number",
            description: "Contar atendimentos dos últimos N dias (padrão: 7)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "listar_conversas",
      description: "Lista conversas recentes de clientes com nome, telefone, status e última mensagem.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["OPEN", "CLOSED", "all"],
            description: "Filtrar por status (padrão: all)"
          },
          periodo_dias: {
            type: "number",
            description: "Apenas conversas com atividade nos últimos N dias (padrão: 7)"
          },
          limite: {
            type: "number",
            description: "Máximo de resultados (padrão: 15)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "buscar_interesse_sem_agendamento",
      description: "Encontra clientes que demonstraram interesse em algum serviço mas ainda NÃO agendaram reunião ou visita.",
      parameters: {
        type: "object",
        properties: {
          periodo_dias: {
            type: "number",
            description: "Buscar nos últimos N dias (padrão: 30)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "buscar_reunioes_agendadas",
      description: "Lista clientes que agendaram reunião ou visita, com data e detalhes.",
      parameters: {
        type: "object",
        properties: {
          periodo_dias: {
            type: "number",
            description: "Buscar agendamentos nos últimos N dias (padrão: 30)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ver_cliente",
      description: "Busca informações detalhadas de um cliente específico: nome, interesse, histórico resumido, status.",
      parameters: {
        type: "object",
        required: ["telefone"],
        properties: {
          telefone: {
            type: "string",
            description: "Número de telefone do cliente (apenas dígitos ou com formatação)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "enviar_mensagem_cliente",
      description: "Envia uma mensagem de texto diretamente para um cliente via WhatsApp.",
      parameters: {
        type: "object",
        required: ["telefone", "mensagem"],
        properties: {
          telefone: {
            type: "string",
            description: "Número de telefone do cliente (apenas dígitos)"
          },
          mensagem: {
            type: "string",
            description: "Texto da mensagem a enviar"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "assumir_atendimento",
      description: "Ativa humanTakeover numa conversa: o bot para de responder e o admin assume manualmente.",
      parameters: {
        type: "object",
        required: ["telefone"],
        properties: {
          telefone: {
            type: "string",
            description: "Número de telefone do cliente"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "devolver_para_bot",
      description: "Desativa humanTakeover: o bot volta a responder automaticamente para o cliente.",
      parameters: {
        type: "object",
        required: ["telefone"],
        properties: {
          telefone: {
            type: "string",
            description: "Número de telefone do cliente"
          }
        }
      }
    }
  }
] as const;

type ToolName =
  | "estatisticas_atendimentos"
  | "listar_conversas"
  | "buscar_interesse_sem_agendamento"
  | "buscar_reunioes_agendadas"
  | "ver_cliente"
  | "enviar_mensagem_cliente"
  | "assumir_atendimento"
  | "devolver_para_bot";

// ---------------------------------------------------------------------------

export class AdminCommandService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;
  private readonly platformPrisma: PlatformPrisma;
  private readonly config: AdminCommandServiceConfig;

  public constructor(deps: AdminCommandServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.platformPrisma = deps.platformPrisma;
    this.config = deps.config;
  }

  /**
   * Ponto de entrada principal. Recebe a mensagem livre do admin,
   * interpreta via IA com tool calling, executa ações e responde.
   */
  public async handleCommand(ctx: AdminCommandContext): Promise<boolean> {
    const aiProvider = await this.getAiProvider(ctx.tenantId);
    if (!aiProvider) {
      console.log("[admin-cmd] provedor de IA nao configurado, ignorando comando admin");
      return false;
    }

    const apiKey = decrypt(aiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);

    const systemPrompt = [
      "Você é um assistente administrativo inteligente integrado ao WhatsApp.",
      "Você tem acesso a ferramentas para consultar dados de atendimentos e executar ações.",
      "Responda de forma direta e concisa, usando formatação WhatsApp (*negrito*, _itálico_).",
      "Quando o admin pedir para enviar mensagem a um cliente, use a ferramenta enviar_mensagem_cliente.",
      "Para consultas sobre atendimentos, use as ferramentas de busca antes de responder.",
      "Se não encontrar dados, informe claramente. Nunca invente informações.",
      "Responda sempre em português brasileiro."
    ].join("\n");

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: ctx.text }
    ];

    // Loop de tool calling (máximo 5 iterações para segurança)
    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await fetch(`${aiProvider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: aiProvider.model,
          temperature: 0.3,
          messages,
          tools: TOOLS,
          tool_choice: "auto"
        })
      });

      if (!response.ok) {
        console.warn(`[admin-cmd] erro na chamada de IA: ${response.status}`);
        await ctx.sendResponse("⚠️ Erro ao processar comando. Tente novamente.");
        return true;
      }

      const data = await response.json() as {
        choices?: Array<{
          message?: {
            role?: string;
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason?: string;
        }>;
      };

      const choice = data.choices?.[0];
      if (!choice?.message) break;

      const assistantMessage = choice.message;
      messages.push({ ...assistantMessage });

      // Sem tool calls → resposta final
      if (!assistantMessage.tool_calls?.length) {
        const finalText = assistantMessage.content?.trim();
        if (finalText) {
          await ctx.sendResponse(finalText);
        }
        return true;
      }

      // Executa cada tool call
      for (const toolCall of assistantMessage.tool_calls) {
        let toolResult: string;

        try {
          const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
          toolResult = await this.executeTool(
            toolCall.function.name as ToolName,
            args,
            ctx
          );
        } catch (err) {
          toolResult = `Erro ao executar ferramenta: ${String(err)}`;
          console.warn(`[admin-cmd] erro na tool ${toolCall.function.name}:`, err);
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Execução das ferramentas
  // ---------------------------------------------------------------------------

  private async executeTool(
    name: ToolName,
    args: Record<string, unknown>,
    ctx: AdminCommandContext
  ): Promise<string> {
    const prisma = await this.tenantPrismaRegistry.getClient(ctx.tenantId);

    switch (name) {
      case "estatisticas_atendimentos": {
        const days = typeof args["periodo_dias"] === "number" ? args["periodo_dias"] : 7;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const [total, open, closed, takeover] = await Promise.all([
          prisma.conversation.count({
            where: { instanceId: ctx.instanceId, lastMessageAt: { gte: cutoff } }
          }),
          prisma.conversation.count({
            where: { instanceId: ctx.instanceId, status: "OPEN", lastMessageAt: { gte: cutoff } }
          }),
          prisma.conversation.count({
            where: { instanceId: ctx.instanceId, status: "CLOSED", lastMessageAt: { gte: cutoff } }
          }),
          prisma.conversation.count({
            where: { instanceId: ctx.instanceId, humanTakeover: true, lastMessageAt: { gte: cutoff } }
          })
        ]);

        return JSON.stringify({ periodo_dias: days, total, abertos: open, fechados: closed, com_humano_ativo: takeover });
      }

      case "listar_conversas": {
        const status = typeof args["status"] === "string" ? args["status"] : "all";
        const days = typeof args["periodo_dias"] === "number" ? args["periodo_dias"] : 7;
        const limit = typeof args["limite"] === "number" ? Math.min(args["limite"], 30) : 15;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const where: Record<string, unknown> = {
          instanceId: ctx.instanceId,
          lastMessageAt: { gte: cutoff }
        };
        if (status !== "all") where["status"] = status;

        const convs = await prisma.conversation.findMany({
          where,
          orderBy: { lastMessageAt: "desc" },
          take: limit,
          select: {
            id: true,
            status: true,
            humanTakeover: true,
            lastMessageAt: true,
            tags: true,
            contact: { select: { displayName: true, phoneNumber: true } }
          }
        });

        const result = convs.map((c) => ({
          cliente: c.contact.displayName ?? c.contact.phoneNumber,
          telefone: c.contact.phoneNumber,
          status: c.status,
          humano_ativo: c.humanTakeover,
          ultima_mensagem: c.lastMessageAt?.toISOString().slice(0, 16).replace("T", " "),
          tags: c.tags
        }));

        return JSON.stringify({ total: result.length, conversas: result });
      }

      case "buscar_interesse_sem_agendamento": {
        const days = typeof args["periodo_dias"] === "number" ? args["periodo_dias"] : 30;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const records = await prisma.clientMemory.findMany({
          where: {
            serviceInterest: { not: null },
            scheduledAt: null,
            lastContactAt: { gte: cutoff },
            status: { notIn: ["closed", "client"] }
          },
          orderBy: { lastContactAt: "desc" },
          take: 20,
          select: {
            name: true,
            phoneNumber: true,
            serviceInterest: true,
            status: true,
            lastContactAt: true,
            notes: true
          }
        });

        if (records.length === 0) {
          return JSON.stringify({ total: 0, mensagem: "Nenhum cliente com interesse pendente encontrado no período." });
        }

        const result = records.map((r) => ({
          cliente: r.name ?? r.phoneNumber,
          telefone: r.phoneNumber,
          interesse: r.serviceInterest,
          status: r.status,
          ultimo_contato: r.lastContactAt.toISOString().slice(0, 10),
          notas: r.notes
        }));

        return JSON.stringify({ total: result.length, clientes: result });
      }

      case "buscar_reunioes_agendadas": {
        const days = typeof args["periodo_dias"] === "number" ? args["periodo_dias"] : 30;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const records = await prisma.clientMemory.findMany({
          where: {
            scheduledAt: { not: null, gte: cutoff }
          },
          orderBy: { scheduledAt: "asc" },
          take: 20,
          select: {
            name: true,
            phoneNumber: true,
            serviceInterest: true,
            scheduledAt: true,
            status: true,
            notes: true
          }
        });

        if (records.length === 0) {
          return JSON.stringify({ total: 0, mensagem: "Nenhuma reunião/visita agendada encontrada no período." });
        }

        const result = records.map((r) => ({
          cliente: r.name ?? r.phoneNumber,
          telefone: r.phoneNumber,
          interesse: r.serviceInterest,
          agendado_para: r.scheduledAt?.toISOString().slice(0, 16).replace("T", " "),
          status: r.status,
          notas: r.notes
        }));

        return JSON.stringify({ total: result.length, agendamentos: result });
      }

      case "ver_cliente": {
        const rawPhone = String(args["telefone"] ?? "").replace(/\D/g, "");
        if (!rawPhone) return JSON.stringify({ erro: "Telefone inválido" });

        const [contact, memory] = await Promise.all([
          prisma.contact.findFirst({
            where: { instanceId: ctx.instanceId, phoneNumber: { contains: rawPhone.slice(-8) } },
            select: {
              displayName: true,
              phoneNumber: true,
              notes: true,
              fields: true,
              isBlacklisted: true,
              conversations: {
                orderBy: { lastMessageAt: "desc" },
                take: 1,
                select: { status: true, humanTakeover: true, tags: true, lastMessageAt: true }
              }
            }
          }),
          prisma.clientMemory.findFirst({
            where: { phoneNumber: { contains: rawPhone.slice(-8) } },
            select: {
              name: true,
              serviceInterest: true,
              status: true,
              scheduledAt: true,
              notes: true,
              isExistingClient: true,
              lastContactAt: true
            }
          })
        ]);

        if (!contact && !memory) {
          return JSON.stringify({ erro: `Cliente com telefone ${rawPhone} não encontrado.` });
        }

        return JSON.stringify({
          nome: contact?.displayName ?? memory?.name ?? "Desconhecido",
          telefone: contact?.phoneNumber ?? rawPhone,
          cliente_existente: memory?.isExistingClient ?? false,
          interesse: memory?.serviceInterest,
          status_lead: memory?.status,
          agendamento: memory?.scheduledAt?.toISOString().slice(0, 16).replace("T", " "),
          notas: memory?.notes ?? contact?.notes,
          blacklist: contact?.isBlacklisted ?? false,
          ultima_conversa: contact?.conversations?.[0]
            ? {
                status: contact.conversations[0].status,
                humano_ativo: contact.conversations[0].humanTakeover,
                tags: contact.conversations[0].tags,
                ultima_mensagem: contact.conversations[0].lastMessageAt?.toISOString().slice(0, 16).replace("T", " ")
              }
            : null
        });
      }

      case "enviar_mensagem_cliente": {
        const rawPhone = String(args["telefone"] ?? "").replace(/\D/g, "");
        const mensagem = String(args["mensagem"] ?? "").trim();

        if (!rawPhone || !mensagem) {
          return JSON.stringify({ sucesso: false, erro: "Telefone ou mensagem inválidos." });
        }

        const jid = `${rawPhone}@s.whatsapp.net`;
        const ok = await ctx.sendMessageToClient(jid, rawPhone, mensagem);

        return JSON.stringify({
          sucesso: ok,
          telefone: rawPhone,
          mensagem_enviada: ok ? mensagem : undefined,
          erro: ok ? undefined : "Falha ao enviar mensagem."
        });
      }

      case "assumir_atendimento": {
        const rawPhone = String(args["telefone"] ?? "").replace(/\D/g, "");
        if (!rawPhone) return JSON.stringify({ sucesso: false, erro: "Telefone inválido." });

        const contact = await prisma.contact.findFirst({
          where: { instanceId: ctx.instanceId, phoneNumber: { contains: rawPhone.slice(-8) } },
          select: { id: true }
        });

        if (!contact) return JSON.stringify({ sucesso: false, erro: `Contato ${rawPhone} não encontrado.` });

        const updated = await prisma.conversation.updateMany({
          where: { instanceId: ctx.instanceId, contactId: contact.id, status: "OPEN" },
          data: { humanTakeover: true, humanTakeoverAt: new Date() }
        });

        return JSON.stringify({ sucesso: true, conversas_atualizadas: updated.count, telefone: rawPhone });
      }

      case "devolver_para_bot": {
        const rawPhone = String(args["telefone"] ?? "").replace(/\D/g, "");
        if (!rawPhone) return JSON.stringify({ sucesso: false, erro: "Telefone inválido." });

        const contact = await prisma.contact.findFirst({
          where: { instanceId: ctx.instanceId, phoneNumber: { contains: rawPhone.slice(-8) } },
          select: { id: true }
        });

        if (!contact) return JSON.stringify({ sucesso: false, erro: `Contato ${rawPhone} não encontrado.` });

        const updated = await prisma.conversation.updateMany({
          where: { instanceId: ctx.instanceId, contactId: contact.id },
          data: { humanTakeover: false, humanTakeoverAt: null }
        });

        return JSON.stringify({ sucesso: true, conversas_atualizadas: updated.count, telefone: rawPhone });
      }

      default:
        return JSON.stringify({ erro: `Ferramenta desconhecida: ${name}` });
    }
  }

  // ---------------------------------------------------------------------------

  private async getAiProvider(tenantId: string): Promise<{
    baseUrl: string;
    model: string;
    apiKeyEncrypted: string;
  } | null> {
    const record = await this.platformPrisma.tenantAiProvider.findUnique({
      where: { tenantId },
      select: { baseUrl: true, model: true, apiKeyEncrypted: true, isActive: true }
    });

    if (!record?.isActive || !record.apiKeyEncrypted || !record.model?.trim()) {
      return null;
    }

    return { baseUrl: record.baseUrl, model: record.model, apiKeyEncrypted: record.apiKeyEncrypted };
  }
}
