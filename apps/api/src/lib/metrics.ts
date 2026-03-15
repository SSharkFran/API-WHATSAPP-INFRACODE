import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from "prom-client";

/**
 * Encapsula registradores Prometheus para uso consistente nos modulos da API.
 */
export class MetricsService {
  public readonly registry: Registry;
  public readonly instanceStatusGauge: Gauge<string>;
  public readonly messagesTotal: Counter<string>;
  public readonly webhookDeliveriesTotal: Counter<string>;
  public readonly messageLatencySeconds: Histogram<string>;
  public readonly tenantPrismaCacheHits: Counter<string>;
  public readonly tenantPrismaCacheMisses: Counter<string>;
  public readonly tenantPrismaCacheEvictions: Counter<string>;
  public readonly tenantPrismaActiveClients: Gauge<string>;

  public constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.instanceStatusGauge = new Gauge({
      name: "infracode_instance_status",
      help: "Status numerico por instancia",
      labelNames: ["instance_id", "tenant_id", "status"],
      registers: [this.registry]
    });

    this.messagesTotal = new Counter({
      name: "infracode_messages_total",
      help: "Mensagens processadas pela plataforma",
      labelNames: ["instance_id", "tenant_id", "direction", "status", "type"],
      registers: [this.registry]
    });

    this.webhookDeliveriesTotal = new Counter({
      name: "infracode_webhook_deliveries_total",
      help: "Entregas de webhook",
      labelNames: ["instance_id", "tenant_id", "event_type", "status"],
      registers: [this.registry]
    });

    this.messageLatencySeconds = new Histogram({
      name: "infracode_message_latency_seconds",
      help: "Latencia de envio de mensagens",
      labelNames: ["instance_id", "tenant_id", "type"],
      buckets: [0.1, 0.3, 0.5, 1, 2, 5, 10, 20],
      registers: [this.registry]
    });

    this.tenantPrismaCacheHits = new Counter({
      name: "infracode_tenant_prisma_cache_hits_total",
      help: "Total de hits no cache de Prisma por tenant",
      registers: [this.registry]
    });

    this.tenantPrismaCacheMisses = new Counter({
      name: "infracode_tenant_prisma_cache_misses_total",
      help: "Total de misses no cache de Prisma por tenant",
      registers: [this.registry]
    });

    this.tenantPrismaCacheEvictions = new Counter({
      name: "infracode_tenant_prisma_cache_evictions_total",
      help: "Total de eviccoes do cache de Prisma por tenant",
      registers: [this.registry]
    });

    this.tenantPrismaActiveClients = new Gauge({
      name: "infracode_tenant_prisma_active_clients",
      help: "Quantidade atual de Prisma clients quentes no cache LRU",
      registers: [this.registry]
    });
  }

  /**
   * Atualiza o gauge de status da instancia com um codigo numerico simples.
   */
  public setInstanceStatus(instanceId: string, tenantId: string, status: string): void {
    const numeric = {
      INITIALIZING: 1,
      QR_PENDING: 2,
      CONNECTED: 3,
      DISCONNECTED: 4,
      BANNED: 5,
      PAUSED: 6
    }[status] ?? 0;

    this.instanceStatusGauge.set({ instance_id: instanceId, tenant_id: tenantId, status }, numeric);
  }

  public recordTenantPrismaCacheHit(): void {
    this.tenantPrismaCacheHits.inc();
  }

  public recordTenantPrismaCacheMiss(): void {
    this.tenantPrismaCacheMisses.inc();
  }

  public recordTenantPrismaCacheEviction(): void {
    this.tenantPrismaCacheEvictions.inc();
  }

  public setTenantPrismaActiveClients(value: number): void {
    this.tenantPrismaActiveClients.set(value);
  }
}
