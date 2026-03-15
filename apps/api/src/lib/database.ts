import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient as PlatformPrismaClientType } from "../../../../prisma/generated/platform-client/index.js";
import type { PrismaClient as TenantPrismaClientType } from "../../../../prisma/generated/tenant-client/index.js";
import type { AppConfig } from "../config.js";
import type { MetricsService } from "./metrics.js";
import { buildTenantSchemaSql, resolveTenantSchemaName } from "./tenant-schema.js";

const require = createRequire(import.meta.url);
const currentFileDirectory = dirname(fileURLToPath(import.meta.url));

const resolveWorkspaceRoot = (): string => {
  let directory = currentFileDirectory;

  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(resolve(directory, "pnpm-workspace.yaml")) && existsSync(resolve(directory, "prisma/generated/platform-client"))) {
      return directory;
    }

    const parent = dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  throw new Error("Nao foi possivel localizar a raiz do workspace para carregar os clients Prisma gerados.");
};

const workspaceRoot = resolveWorkspaceRoot();
const { PrismaClient: PlatformPrismaClient } = require(resolve(workspaceRoot, "prisma/generated/platform-client")) as {
  PrismaClient: new (options?: { datasourceUrl?: string }) => PlatformPrismaClientType;
};
const { PrismaClient: TenantPrismaClient } = require(resolve(workspaceRoot, "prisma/generated/tenant-client")) as {
  PrismaClient: new (options?: { datasourceUrl?: string }) => TenantPrismaClientType;
};

const withSchema = (value: string, schema: string, connectionLimit?: number): string => {
  const url = new URL(value);
  url.searchParams.set("schema", schema);

  if (connectionLimit) {
    url.searchParams.set("connection_limit", String(connectionLimit));
  }

  return url.toString();
};

export type PlatformPrisma = PlatformPrismaClientType;
export type TenantPrisma = TenantPrismaClientType;

export const createPlatformPrisma = (config: AppConfig): PlatformPrisma =>
  new PlatformPrismaClient({
    datasourceUrl: withSchema(config.PLATFORM_DATABASE_URL ?? config.DATABASE_URL, "platform")
  });

interface TenantRegistryEntry {
  client: TenantPrisma;
  timer?: NodeJS.Timeout;
}

/**
 * Mantem um cache LRU com TTL de Prisma clients tenant-scoped.
 */
export class TenantPrismaRegistry {
  private readonly config: AppConfig;
  private readonly metricsService: MetricsService;
  private readonly entries = new Map<string, TenantRegistryEntry>();

  public constructor(config: AppConfig, metricsService: MetricsService) {
    this.config = config;
    this.metricsService = metricsService;
  }

  public async ensureSchema(platformPrisma: PlatformPrisma, tenantId: string): Promise<string> {
    const schemaName = resolveTenantSchemaName(tenantId);

    for (const sql of buildTenantSchemaSql(schemaName)) {
      await platformPrisma.$executeRawUnsafe(sql);
    }

    return schemaName;
  }

  public async getClient(tenantId: string): Promise<TenantPrisma> {
    const existing = this.entries.get(tenantId);

    if (existing) {
      this.touch(tenantId, existing);
      this.metricsService.recordTenantPrismaCacheHit();
      return existing.client;
    }

    this.metricsService.recordTenantPrismaCacheMiss();
    const client = new TenantPrismaClient({
      datasourceUrl: withSchema(
        this.config.TENANT_DATABASE_URL ?? this.config.DATABASE_URL,
        resolveTenantSchemaName(tenantId),
        this.config.TENANT_PRISMA_CONNECTION_LIMIT
      )
    });

    const entry = { client };
    this.entries.set(tenantId, entry);
    this.touch(tenantId, entry);
    await this.evictIfNeeded();
    this.metricsService.setTenantPrismaActiveClients(this.entries.size);
    return client;
  }

  public async disposeClient(tenantId: string): Promise<void> {
    const entry = this.entries.get(tenantId);

    if (!entry) {
      return;
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    this.entries.delete(tenantId);
    await entry.client.$disconnect();
    this.metricsService.recordTenantPrismaCacheEviction();
    this.metricsService.setTenantPrismaActiveClients(this.entries.size);
  }

  public async close(): Promise<void> {
    for (const tenantId of [...this.entries.keys()]) {
      await this.disposeClient(tenantId);
    }
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.entries.size > this.config.TENANT_PRISMA_CACHE_MAX) {
      const oldest = this.entries.keys().next().value as string | undefined;

      if (!oldest) {
        return;
      }

      await this.disposeClient(oldest);
    }
  }

  private touch(tenantId: string, entry: TenantRegistryEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    this.entries.delete(tenantId);
    this.entries.set(tenantId, entry);
    entry.timer = setTimeout(() => {
      void this.disposeClient(tenantId);
    }, this.config.TENANT_PRISMA_IDLE_TTL_MS);
    entry.timer.unref?.();
  }
}
