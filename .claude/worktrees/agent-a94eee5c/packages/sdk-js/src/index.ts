import type {
  InstanceHealthReport,
  InstanceSummary,
  MessageRecord,
  PaginatedResult,
  SendMessagePayload,
  WebhookConfig
} from "@infracode/types";

export interface InfraCodeClientOptions {
  apiKey: string;
  baseUrl: string;
  tenantId: string;
}

export interface ListMessagesParams {
  page?: number;
  pageSize?: number;
  status?: string;
  type?: string;
}

/**
 * Cliente oficial JavaScript/TypeScript para consumo da InfraCode WhatsApp API.
 */
export class InfraCodeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly tenantId: string;

  public constructor(options: InfraCodeClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tenantId = options.tenantId;
  }

  /**
   * Lista instâncias de um tenant.
   */
  public async listInstances(): Promise<InstanceSummary[]> {
    return this.request<InstanceSummary[]>("/instances");
  }

  /**
   * Consulta o health report detalhado da instância.
   */
  public async getInstanceHealth(instanceId: string): Promise<InstanceHealthReport> {
    return this.request<InstanceHealthReport>(`/instances/${instanceId}/health`);
  }

  /**
   * Envia uma mensagem para a instância informada.
   */
  public async sendMessage(instanceId: string, payload: SendMessagePayload): Promise<MessageRecord> {
    return this.request<MessageRecord>(`/instances/${instanceId}/messages/send`, {
      body: JSON.stringify(payload),
      method: "POST"
    });
  }

  /**
   * Lista mensagens com paginação e filtros.
   */
  public async listMessages(
    instanceId: string,
    params: ListMessagesParams = {}
  ): Promise<PaginatedResult<MessageRecord>> {
    const search = new URLSearchParams();

    if (params.page) {
      search.set("page", String(params.page));
    }

    if (params.pageSize) {
      search.set("pageSize", String(params.pageSize));
    }

    if (params.status) {
      search.set("status", params.status);
    }

    if (params.type) {
      search.set("type", params.type);
    }

    return this.request<PaginatedResult<MessageRecord>>(
      `/instances/${instanceId}/messages${search.size > 0 ? `?${search.toString()}` : ""}`
    );
  }

  /**
   * Atualiza a configuração de webhook da instância.
   */
  public async upsertWebhook(instanceId: string, payload: Omit<WebhookConfig, "id" | "instanceId">): Promise<WebhookConfig> {
    return this.request<WebhookConfig>(`/instances/${instanceId}/webhooks`, {
      body: JSON.stringify(payload),
      method: "POST"
    });
  }

  private async request<TResponse>(path: string, init?: RequestInit): Promise<TResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "x-tenant-id": this.tenantId,
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(payload.message ?? `HTTP ${response.status}`);
    }

    return (await response.json()) as TResponse;
  }
}
