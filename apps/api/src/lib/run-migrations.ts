import type pino from "pino";

/**
 * Versioned migration record.
 * version format: "YYYY-MM-DD-NNN-description" (sorts lexicographically in apply order)
 */
interface Migration {
  version: string;
  description: string;
  sql: (schema: string) => string;
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll("\"", "\"\"")}"`;

/**
 * Resolve the tenant schema identifier (quoted) from a tenantId.
 * Must match the naming logic in tenant-schema.ts / database.ts.
 */
function resolveTenantSchema(tenantId: string): string {
  const schemaName = `tenant_${tenantId.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;

  // Security: validate schema name matches only safe characters (T-02-04-01)
  if (!/^tenant_[a-z0-9_]+$/i.test(schemaName)) {
    throw new Error(`Invalid tenant schema name derived from tenantId: ${tenantId}`);
  }

  return quoteIdentifier(schemaName);
}

/**
 * All tenant schema migrations — ordered by version ascending.
 * Add new migrations HERE when new columns are needed.
 * NEVER remove or modify an existing migration version.
 *
 * Convention: version = ISO date + 3-digit sequence + short slug
 * Versions are PRIMARY KEY in schema_migrations — must be unique across all history (T-02-04-04).
 *
 * ALTER TABLE migrations are now managed via run-migrations.ts MIGRATIONS[]
 * (previously in buildTenantSchemaSql() in tenant-schema.ts)
 */
export const MIGRATIONS: Migration[] = [
  {
    version: "2026-04-11-001-conversation-phone-number",
    description: "Add phoneNumber column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "phoneNumber" TEXT;`
  },
  {
    version: "2026-04-11-002-conversation-lead-sent",
    description: "Add leadSent column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "leadSent" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-003-conversation-awaiting-lead-extraction",
    description: "Add awaitingLeadExtraction column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "awaitingLeadExtraction" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-004-conversation-human-takeover",
    description: "Add humanTakeover column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "humanTakeover" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-005-conversation-human-takeover-at",
    description: "Add humanTakeoverAt column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "humanTakeoverAt" TIMESTAMPTZ;`
  },
  {
    version: "2026-04-11-006-conversation-ai-disabled-permanent",
    description: "Add aiDisabledPermanent column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "aiDisabledPermanent" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-007-conversation-awaiting-admin-response",
    description: "Add awaitingAdminResponse column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "awaitingAdminResponse" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-008-conversation-pending-client-question",
    description: "Add pendingClientQuestion column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "pendingClientQuestion" TEXT;`
  },
  {
    version: "2026-04-11-009-conversation-pending-client-jid",
    description: "Add pendingClientJid column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "pendingClientJid" TEXT;`
  },
  {
    version: "2026-04-11-010-conversation-pending-client-conversation-id",
    description: "Add pendingClientConversationId column to Conversation table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."Conversation" ADD COLUMN IF NOT EXISTS "pendingClientConversationId" TEXT;`
  },
  {
    version: "2026-04-11-011-chatbot-config-ai-settings",
    description: "Add aiSettings column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "aiSettings" JSONB NOT NULL DEFAULT '{}'::JSONB;`
  },
  {
    version: "2026-04-11-012-chatbot-config-human-takeover-start-message",
    description: "Add humanTakeoverStartMessage column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "humanTakeoverStartMessage" TEXT;`
  },
  {
    version: "2026-04-11-013-chatbot-config-human-takeover-end-message",
    description: "Add humanTakeoverEndMessage column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "humanTakeoverEndMessage" TEXT;`
  },
  {
    version: "2026-04-11-014-chatbot-config-ai-api-key-encrypted",
    description: "Add aiApiKeyEncrypted column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "aiApiKeyEncrypted" TEXT;`
  },
  {
    version: "2026-04-11-015-chatbot-config-ai-fallback-provider",
    description: "Add aiFallbackProvider column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "aiFallbackProvider" TEXT;`
  },
  {
    version: "2026-04-11-016-chatbot-config-ai-fallback-api-key",
    description: "Add aiFallbackApiKey column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "aiFallbackApiKey" TEXT;`
  },
  {
    version: "2026-04-11-017-chatbot-config-ai-fallback-model",
    description: "Add aiFallbackModel column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "aiFallbackModel" TEXT;`
  },
  {
    version: "2026-04-11-018-chatbot-config-leads-group-jid",
    description: "Add leadsGroupJid column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "leadsGroupJid" TEXT;`
  },
  {
    version: "2026-04-11-019-chatbot-config-leads-group-name",
    description: "Add leadsGroupName column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "leadsGroupName" TEXT;`
  },
  {
    version: "2026-04-11-020-chatbot-config-leads-phone-number",
    description: "Add leadsPhoneNumber column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "leadsPhoneNumber" TEXT;`
  },
  {
    version: "2026-04-11-021-chatbot-config-leads-enabled",
    description: "Add leadsEnabled column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "leadsEnabled" BOOLEAN NOT NULL DEFAULT TRUE;`
  },
  {
    version: "2026-04-11-022-chatbot-config-fiado-enabled",
    description: "Add fiadoEnabled column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "fiadoEnabled" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-023-chatbot-config-audio-enabled",
    description: "Add audioEnabled column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "audioEnabled" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-024-chatbot-config-vision-enabled",
    description: "Add visionEnabled column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "visionEnabled" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-025-chatbot-config-vision-prompt",
    description: "Add visionPrompt column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "visionPrompt" TEXT;`
  },
  {
    version: "2026-04-11-026-chatbot-config-response-delay-ms",
    description: "Add responseDelayMs column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "responseDelayMs" INTEGER NOT NULL DEFAULT 3000;`
  },
  {
    version: "2026-04-11-027-chatbot-config-lead-auto-extract",
    description: "Add leadAutoExtract column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "leadAutoExtract" BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    version: "2026-04-11-028-chatbot-config-lead-vehicle-table",
    description: "Add leadVehicleTable column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "leadVehicleTable" JSONB NOT NULL DEFAULT '{}'::JSONB;`
  },
  {
    version: "2026-04-11-029-chatbot-config-lead-price-table",
    description: "Add leadPriceTable column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "leadPriceTable" JSONB NOT NULL DEFAULT '{}'::JSONB;`
  },
  {
    version: "2026-04-11-030-chatbot-config-lead-surcharge-table",
    description: "Add leadSurchargeTable column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "leadSurchargeTable" JSONB NOT NULL DEFAULT '{}'::JSONB;`
  },
  {
    version: "2026-04-11-031-chatbot-config-modules",
    description: "Add modules column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "modules" JSONB NOT NULL DEFAULT '{}'::JSONB;`
  },
  {
    version: "2026-04-11-032-chatbot-config-knowledge-synthesis",
    description: "Add knowledgeSynthesis column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "knowledgeSynthesis" TEXT;`
  },
  {
    version: "2026-04-11-033-chatbot-config-knowledge-synthesis-updated-at",
    description: "Add knowledgeSynthesisUpdatedAt column to ChatbotConfig table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."ChatbotConfig" ADD COLUMN IF NOT EXISTS "knowledgeSynthesisUpdatedAt" TIMESTAMPTZ;`
  },
  {
    version: "2026-04-11-034-tenant-knowledge-updated-at",
    description: "Add updatedAt column to TenantKnowledge table",
    sql: (schema) =>
      `ALTER TABLE ${schema}."TenantKnowledge" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();`
  }
];

/**
 * Run all pending migrations for a single tenant.
 * Per locked decision D-MIGRATION-FAIL:
 *   - Errors are caught per-tenant
 *   - Returns "failed" without throwing
 *   - Caller handles startup summary logging
 */
export async function runMigrations(
  platformPrisma: {
    $executeRawUnsafe: (sql: string) => Promise<unknown>;
    $queryRawUnsafe: <T>(sql: string) => Promise<T>;
  },
  tenantId: string,
  logger: pino.Logger
): Promise<"success" | "skipped" | "failed"> {
  const schema = resolveTenantSchema(tenantId);

  try {
    // Step 1: Ensure migrations table exists (T-02-04-01: schema name validated above)
    await platformPrisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS ${schema}."schema_migrations" (` +
      `"version" TEXT PRIMARY KEY, ` +
      `"appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()` +
      `);`
    );

    // Step 2: Fetch applied versions
    const applied = await platformPrisma.$queryRawUnsafe<{ version: string }[]>(
      `SELECT "version" FROM ${schema}."schema_migrations";`
    );
    const appliedSet = new Set(applied.map((r) => r.version));

    // Step 3: Check if all migrations already applied
    const pending = MIGRATIONS.filter((m) => !appliedSet.has(m.version));
    if (pending.length === 0) return "skipped";

    // Step 4: Apply pending migrations in order
    for (const migration of pending) {
      try {
        await platformPrisma.$executeRawUnsafe(migration.sql(schema));
        await platformPrisma.$executeRawUnsafe(
          `INSERT INTO ${schema}."schema_migrations" ("version") VALUES ('${migration.version}');`
        );
      } catch (err) {
        // Per D-MIGRATION-FAIL: log structured error, return "failed"
        logger.error(
          { tenantId, migration: migration.version, error: err },
          "Migration failed — tenant will operate on partial schema"
        );
        return "failed";
      }
    }

    return "success";
  } catch (err) {
    // Outer catch: migrations table creation failed or schema doesn't exist
    logger.error(
      { tenantId, migration: "schema_migrations-create", error: err },
      "Migration infrastructure failed for tenant"
    );
    return "failed";
  }
}
