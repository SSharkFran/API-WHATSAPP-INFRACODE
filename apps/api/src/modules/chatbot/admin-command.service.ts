import { decrypt } from "../../lib/crypto.js";
import type { TenantPrismaRegistry } from "../../lib/database.js";
import type { PlatformPrisma } from "../../lib/database.js";
import { GroqKeyRotator } from "../../lib/groq-key-rotator.js";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";

interface AdminCommandServiceConfig {
  API_ENCRYPTION_KEY: string;
  GROQ_API_KEY: string;
  GROQ_EXTRA_API_KEYS?: string;
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
  adminPhone?: string;
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
  },
  {
    type: "function",
    function: {
      name: "pegar_ultimo_cliente_atendido",
      description: "Retorna dados do cliente da conversa mais recentemente ativa. Use quando o admin falar 'o último cliente', 'quem eu atendi agora pouco', 'o cliente anterior', 'esse cliente', sem especificar telefone.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "status_instancia",
      description: "Retorna status geral da instância: conversas abertas agora, atendimentos hoje, leads novos hoje, agendamentos pendentes. Use para responder 'como estamos?', 'status', 'resumo do dia'.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bloquear_contato",
      description: "Adiciona um contato à blacklist — o bot para de responder para esse número.",
      parameters: {
        type: "object",
        required: ["telefone"],
        properties: {
          telefone: {
            type: "string",
            description: "Número de telefone do contato a bloquear"
          },
          motivo: {
            type: "string",
            description: "Motivo do bloqueio (opcional)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desbloquear_contato",
      description: "Remove um contato da blacklist — o bot volta a responder para esse número.",
      parameters: {
        type: "object",
        required: ["telefone"],
        properties: {
          telefone: {
            type: "string",
            description: "Número de telefone do contato a desbloquear"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "buscar_mensagens_cliente",
      description: "Busca o histórico de mensagens de um cliente específico. Use quando o admin perguntar o que um cliente disse, qual foi a última conversa, etc.",
      parameters: {
        type: "object",
        required: ["telefone"],
        properties: {
          telefone: {
            type: "string",
            description: "Número de telefone do cliente"
          },
          limite: {
            type: "number",
            description: "Máximo de mensagens a retornar (padrão: 20, máx: 50)"
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
  | "devolver_para_bot"
  | "pegar_ultimo_cliente_atendido"
  | "status_instancia"
  | "bloquear_contato"
  | "desbloquear_contato"
  | "buscar_mensagens_cliente";

interface AiCompletionResponse {
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
}

// ---------------------------------------------------------------------------

export class AdminCommandService {
  private readonly tenantPrismaRegistry: TenantPrismaRegistry;
  private readonly platformPrisma: PlatformPrisma;
  private readonly config: AdminCommandServiceConfig;
  private readonly groqKeyRotator: GroqKeyRotator;

  public constructor(deps: AdminCommandServiceDeps) {
    this.tenantPrismaRegistry = deps.tenantPrismaRegistry;
    this.platformPrisma = deps.platformPrisma;
    this.config = deps.config;
    const extraKeys = deps.config.GROQ_EXTRA_API_KEYS
      ?.split(",")
      .map((k) => k.trim())
      .filter(Boolean) ?? [];
    this.groqKeyRotator = new GroqKeyRotator([deps.config.GROQ_API_KEY, ...extraKeys]);
  }

  /**
   * Ponto de entrada principal. Recebe a mensagem livre do admin,
   * interpreta via IA com tool calling, executa ações e responde.
   */
  public async handleCommand(ctx: AdminCommandContext): Promise<boolean> {
    // Resolve modelo e baseUrl: prioriza tenantAiProvider se configurado,
    // mas SEMPRE usa as chaves da plataforma (GroqKeyRotator) para GROQ.
    const aiProvider = await this.getAiProvider(ctx.tenantId);

    // Detecta se o provider é GROQ-compatível (usa chaves da plataforma)
    const usesPlatformKeys = !aiProvider || aiProvider.provider === "GROQ" || aiProvider.provider === "OPENAI_COMPATIBLE";
    const baseUrl = aiProvider?.baseUrl ?? GROQ_BASE_URL;
    const model = aiProvider?.model ?? GROQ_DEFAULT_MODEL;

    // Para provedores não-GROQ (ex: OpenAI com chave própria do tenant)
    let tenantApiKey: string | null = null;
    if (aiProvider && !usesPlatformKeys) {
      tenantApiKey = decrypt(aiProvider.apiKeyEncrypted, this.config.API_ENCRYPTION_KEY);
    }

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
    let toolsExecuted = false;
    let lastToolResults: Array<{ name: string; result: string }> = [];

    for (let iteration = 0; iteration < 5; iteration++) {
      const data = await this.callAi(baseUrl, model, messages, usesPlatformKeys, tenantApiKey);

      if (!data) {
        await ctx.sendResponse("⚠️ Erro ao processar comando. Tente novamente.");
        return true;
      }

      const choice = data.choices?.[0];
      if (!choice?.message) break;

      const assistantMessage = choice.message;
      messages.push({ ...assistantMessage });

      // Sem tool calls → resposta final
      if (!assistantMessage.tool_calls?.length) {
        const finalText = assistantMessage.content?.trim();
        // Alguns modelos retornam content: null após tool calls — envia fallback
        await ctx.sendResponse(finalText || (toolsExecuted ? "✅ Pronto." : ""));
        return true;
      }

      // Executa cada tool call
      const toolResults: Array<{ name: string; result: string }> = [];
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
        toolResults.push({ name: toolCall.function.name, result: toolResult });
      }
      toolsExecuted = true;
      lastToolResults = toolResults;
    }

    // Loop encerrou sem resposta final do modelo
    if (toolsExecuted) {
      await ctx.sendResponse(this.buildFallbackResponse(lastToolResults));
    }

    return true;
  }

  /**
   * Constrói resposta de fallback legível quando o modelo não gera texto final.
   * Tenta extrair info relevante dos resultados das tools para dar contexto ao admin.
   */
  private buildFallbackResponse(toolResults: Array<{ name: string; result: string }>): string {
    if (toolResults.length === 0) return "✅ Pronto.";

    // Verifica se algum envio de mensagem foi feito
    const sendResult = toolResults.find((t) => t.name === "enviar_mensagem_cliente");
    if (sendResult) {
      try {
        const parsed = JSON.parse(sendResult.result) as Record<string, unknown>;
        if (parsed["sucesso"] === true) {
          const phone = parsed["telefone"] as string | undefined;
          const msg = parsed["mensagem_enviada"] as string | undefined;
          const preview = msg ? `\n\n_"${msg.slice(0, 120)}${msg.length > 120 ? "..." : ""}"_` : "";
          return `✅ Mensagem enviada${phone ? ` para *${phone}*` : ""}.${preview}`;
        }
        return `⚠️ Falha ao enviar mensagem: ${String(parsed["erro"] ?? "erro desconhecido")}`;
      } catch { /* segue */ }
    }

    // Assumir/devolver atendimento
    const takeoverResult = toolResults.find((t) => t.name === "assumir_atendimento" || t.name === "devolver_para_bot");
    if (takeoverResult) {
      try {
        const parsed = JSON.parse(takeoverResult.result) as Record<string, unknown>;
        if (parsed["sucesso"] === true) {
          return takeoverResult.name === "assumir_atendimento"
            ? `✅ Atendimento assumido para *${parsed["telefone"] ?? ""}*.`
            : `✅ Atendimento devolvido ao bot para *${parsed["telefone"] ?? ""}*.`;
        }
      } catch { /* segue */ }
    }

    // Blacklist
    const blockResult = toolResults.find((t) => t.name === "bloquear_contato" || t.name === "desbloquear_contato");
    if (blockResult) {
      try {
        const parsed = JSON.parse(blockResult.result) as Record<string, unknown>;
        if (parsed["sucesso"] === true) {
          return blockResult.name === "bloquear_contato"
            ? `✅ Contato *${parsed["telefone"] ?? ""}* bloqueado.`
            : `✅ Contato *${parsed["telefone"] ?? ""}* desbloqueado.`;
        }
      } catch { /* segue */ }
    }

    return "✅ Pronto.";
  }

  /**
   * Chama a API de completions com rotação de chaves (para GROQ)
   * ou chave única do tenant (para outros provedores).
   */
  private async callAi(
    baseUrl: string,
    model: string,
    messages: Array<Record<string, unknown>>,
    usesPlatformKeys: boolean,
    tenantApiKey: string | null
  ): Promise<AiCompletionResponse | null> {
    const body = JSON.stringify({
      model,
      temperature: 0.3,
      messages,
      tools: TOOLS,
      tool_choice: "auto"
    });

    if (!usesPlatformKeys && tenantApiKey) {
      // Provedor externo (ex: OpenAI) com chave única do tenant — retry simples
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tenantApiKey}` },
          body
        });
        if (response.ok) return response.json() as Promise<AiCompletionResponse>;
        if (response.status === 429 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
          continue;
        }
        console.warn(`[admin-cmd] erro na chamada de IA: ${response.status}`);
        return null;
      }
      return null;
    }

    // Usa pool de chaves da plataforma com rotação automática
    const keys = this.groqKeyRotator.availableKeys();
    if (keys.length === 0) {
      console.warn("[admin-cmd] nenhuma chave GROQ disponivel (todas em cooldown)");
      return null;
    }

    for (const key of keys) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body
      });

      if (response.ok) {
        this.groqKeyRotator.reportSuccess(key);
        return response.json() as Promise<AiCompletionResponse>;
      }

      this.groqKeyRotator.reportFailure(key, response.status);

      if (response.status !== 429) {
        console.warn(`[admin-cmd] erro na chamada de IA: ${response.status}`);
        return null;
      }

      // 429: tenta próxima chave disponível
      console.warn(`[admin-cmd] chave ...${key.slice(-6)} com rate limit, tentando proxima`);
    }

    console.warn("[admin-cmd] todas as chaves GROQ com rate limit");
    return null;
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

      case "pegar_ultimo_cliente_atendido": {
        // Exclui o próprio admin da busca filtrando pelo telefone dele
        const adminPhoneSuffix = ctx.adminPhone?.replace(/\D/g, "").slice(-8);
        const lastConv = await prisma.conversation.findFirst({
          where: {
            instanceId: ctx.instanceId,
            ...(adminPhoneSuffix ? {
              contact: { NOT: { phoneNumber: { contains: adminPhoneSuffix } } }
            } : {})
          },
          orderBy: { lastMessageAt: "desc" },
          select: {
            id: true,
            status: true,
            humanTakeover: true,
            lastMessageAt: true,
            tags: true,
            contact: {
              select: {
                displayName: true,
                phoneNumber: true,
                notes: true
              }
            }
          }
        });

        if (!lastConv) {
          return JSON.stringify({ erro: "Nenhum atendimento encontrado." });
        }

        const memory = await prisma.clientMemory.findFirst({
          where: { phoneNumber: { contains: lastConv.contact.phoneNumber.slice(-8) } },
          select: { serviceInterest: true, status: true, scheduledAt: true, notes: true }
        });

        return JSON.stringify({
          nome: lastConv.contact.displayName ?? lastConv.contact.phoneNumber,
          telefone: lastConv.contact.phoneNumber,
          status_conversa: lastConv.status,
          humano_ativo: lastConv.humanTakeover,
          ultima_mensagem: lastConv.lastMessageAt?.toISOString().slice(0, 16).replace("T", " "),
          tags: lastConv.tags,
          interesse: memory?.serviceInterest,
          status_lead: memory?.status,
          agendamento: memory?.scheduledAt?.toISOString().slice(0, 16).replace("T", " "),
          notas: memory?.notes ?? lastConv.contact.notes
        });
      }

      case "status_instancia": {
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        const [abertas, hoje_total, leads_hoje, agendamentos] = await Promise.all([
          prisma.conversation.count({
            where: { instanceId: ctx.instanceId, status: "OPEN" }
          }),
          prisma.conversation.count({
            where: { instanceId: ctx.instanceId, lastMessageAt: { gte: hoje } }
          }),
          prisma.clientMemory.count({
            where: { lastContactAt: { gte: hoje } }
          }),
          prisma.clientMemory.count({
            where: {
              scheduledAt: { gte: new Date() }
            }
          })
        ]);

        return JSON.stringify({
          conversas_abertas_agora: abertas,
          atendimentos_hoje: hoje_total,
          leads_novos_hoje: leads_hoje,
          agendamentos_futuros: agendamentos,
          data: new Date().toLocaleString("pt-BR")
        });
      }

      case "bloquear_contato": {
        const rawPhone = String(args["telefone"] ?? "").replace(/\D/g, "");
        const motivo = String(args["motivo"] ?? "").trim() || null;
        if (!rawPhone) return JSON.stringify({ sucesso: false, erro: "Telefone inválido." });

        const updated = await prisma.contact.updateMany({
          where: { instanceId: ctx.instanceId, phoneNumber: { contains: rawPhone.slice(-8) } },
          data: { isBlacklisted: true, ...(motivo ? { notes: motivo } : {}) }
        });

        if (updated.count === 0) {
          return JSON.stringify({ sucesso: false, erro: `Contato ${rawPhone} não encontrado.` });
        }

        return JSON.stringify({ sucesso: true, telefone: rawPhone, contatos_atualizados: updated.count });
      }

      case "desbloquear_contato": {
        const rawPhone = String(args["telefone"] ?? "").replace(/\D/g, "");
        if (!rawPhone) return JSON.stringify({ sucesso: false, erro: "Telefone inválido." });

        const updated = await prisma.contact.updateMany({
          where: { instanceId: ctx.instanceId, phoneNumber: { contains: rawPhone.slice(-8) } },
          data: { isBlacklisted: false }
        });

        if (updated.count === 0) {
          return JSON.stringify({ sucesso: false, erro: `Contato ${rawPhone} não encontrado.` });
        }

        return JSON.stringify({ sucesso: true, telefone: rawPhone, contatos_atualizados: updated.count });
      }

      case "buscar_mensagens_cliente": {
        const rawPhone = String(args["telefone"] ?? "").replace(/\D/g, "");
        const limit = typeof args["limite"] === "number" ? Math.min(args["limite"], 50) : 20;
        if (!rawPhone) return JSON.stringify({ erro: "Telefone inválido." });

        const contact = await prisma.contact.findFirst({
          where: { instanceId: ctx.instanceId, phoneNumber: { contains: rawPhone.slice(-8) } },
          select: { id: true, displayName: true, phoneNumber: true }
        });

        if (!contact) {
          return JSON.stringify({ erro: `Cliente ${rawPhone} não encontrado.` });
        }

        const messages = await prisma.message.findMany({
          where: { instanceId: ctx.instanceId, remoteJid: { contains: contact.phoneNumber.slice(-8) } },
          orderBy: { createdAt: "desc" },
          take: limit,
          select: {
            direction: true,
            type: true,
            payload: true,
            createdAt: true
          }
        });

        const result = messages.reverse().map((m) => {
          const payload = m.payload as Record<string, unknown> | null;
          const texto = (payload?.["text"] ?? payload?.["caption"] ?? "") as string;
          return {
            de: m.direction === "outbound" ? "bot" : "cliente",
            texto: texto.slice(0, 300),
            tipo: m.type,
            horario: m.createdAt.toISOString().slice(0, 16).replace("T", " ")
          };
        });

        return JSON.stringify({
          cliente: contact.displayName ?? contact.phoneNumber,
          telefone: contact.phoneNumber,
          total_mensagens: result.length,
          mensagens: result
        });
      }

      default:
        return JSON.stringify({ erro: `Ferramenta desconhecida: ${name}` });
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Gera o texto do resumo diário para uma instância.
   * Chamado pelo scheduler do InstanceOrchestrator às 8h.
   */
  public async generateDailySummary(tenantId: string, instanceId: string): Promise<string> {
    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const semana = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [abertasHoje, fechadasHoje, totalSemana, semAgendamento, agendamentosFuturos, humanAtivos] = await Promise.all([
      prisma.conversation.count({
        where: { instanceId, status: "OPEN", lastMessageAt: { gte: hoje } }
      }),
      prisma.conversation.count({
        where: { instanceId, status: "CLOSED", lastMessageAt: { gte: hoje } }
      }),
      prisma.conversation.count({
        where: { instanceId, lastMessageAt: { gte: semana } }
      }),
      prisma.clientMemory.count({
        where: {
          serviceInterest: { not: null },
          scheduledAt: null,
          lastContactAt: { gte: semana },
          status: { notIn: ["closed", "client"] }
        }
      }),
      prisma.clientMemory.findMany({
        where: { scheduledAt: { gte: new Date() } },
        orderBy: { scheduledAt: "asc" },
        take: 5,
        select: { name: true, phoneNumber: true, scheduledAt: true, serviceInterest: true }
      }),
      prisma.conversation.count({
        where: { instanceId, humanTakeover: true, status: "OPEN" }
      })
    ]);

    const dataHoje = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" });

    const linhas = [
      `📊 *Resumo Diário — ${dataHoje}*`,
      "",
      "*Hoje:*",
      `• Conversas abertas: ${abertasHoje}`,
      `• Conversas finalizadas: ${fechadasHoje}`,
      `• Em atendimento humano: ${humanAtivos}`,
      "",
      `*Últimos 7 dias:* ${totalSemana} atendimentos`,
      `*Leads sem agendamento:* ${semAgendamento}`,
    ];

    if (agendamentosFuturos.length > 0) {
      linhas.push("", "*Próximos agendamentos:*");
      for (const ag of agendamentosFuturos) {
        const data = ag.scheduledAt?.toLocaleDateString("pt-BR") ?? "?";
        const nome = ag.name ?? ag.phoneNumber;
        linhas.push(`• ${nome} — ${data}${ag.serviceInterest ? ` (${ag.serviceInterest})` : ""}`);
      }
    }

    return linhas.join("\n");
  }

  // ---------------------------------------------------------------------------

  private async getAiProvider(tenantId: string): Promise<{
    baseUrl: string;
    model: string;
    apiKeyEncrypted: string;
    provider: string | null;
  } | null> {
    const record = await this.platformPrisma.tenantAiProvider.findUnique({
      where: { tenantId },
      select: { baseUrl: true, model: true, apiKeyEncrypted: true, isActive: true, provider: true }
    });

    if (!record?.isActive || !record.apiKeyEncrypted || !record.model?.trim()) {
      return null;
    }

    return { baseUrl: record.baseUrl, model: record.model, apiKeyEncrypted: record.apiKeyEncrypted, provider: record.provider ?? null };
  }
}
