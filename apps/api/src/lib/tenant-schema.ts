const quoteIdentifier = (value: string): string => `"${value.replaceAll("\"", "\"\"")}"`;
const tenantSchemaNamePattern = /^[a-zA-Z0-9_]+$/;

/**
 * Gera o nome fisico do schema de um tenant a partir do seu ID imutavel.
 */
export const resolveTenantSchemaName = (tenantId: string): string => {
  const schemaName = `tenant_${tenantId.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;

  if (!tenantSchemaNamePattern.test(schemaName)) {
    throw new Error("Nome de schema do tenant invalido");
  }

  return schemaName;
};

/**
 * Retorna o conjunto de comandos SQL necessario para provisionar um schema de tenant (baseline).
 * Apenas CREATE TABLE IF NOT EXISTS — sem ALTER TABLE.
 * ALTER TABLE migrations are now managed via run-migrations.ts MIGRATIONS[]
 */
export const buildTenantSchemaSql = (schemaName: string): string[] => {
  const schema = quoteIdentifier(schemaName);

  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema};`,
    `CREATE TABLE IF NOT EXISTS ${schema}."Instance" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL,
      "phoneNumber" TEXT,
      "avatarUrl" TEXT,
      "status" TEXT NOT NULL DEFAULT 'INITIALIZING',
      "authDirectory" TEXT NOT NULL,
      "sessionDbPath" TEXT NOT NULL,
      "proxyUrl" TEXT,
      "workerHeartbeatAt" TIMESTAMPTZ,
      "reconnectAttempts" INTEGER NOT NULL DEFAULT 0,
      "riskScore" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT,
      "lastActivityAt" TIMESTAMPTZ,
      "connectedAt" TIMESTAMPTZ,
      "pausedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_instance_status" ON ${schema}."Instance" ("status");`,
    `CREATE TABLE IF NOT EXISTS ${schema}."InstanceUsage" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL UNIQUE REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "messagesSent" INTEGER NOT NULL DEFAULT 0,
      "messagesReceived" INTEGER NOT NULL DEFAULT 0,
      "errors" INTEGER NOT NULL DEFAULT 0,
      "uptimeSeconds" INTEGER NOT NULL DEFAULT 0,
      "lastResetAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS ${schema}."Message" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "remoteJid" TEXT NOT NULL,
      "externalMessageId" TEXT,
      "direction" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "payload" JSONB NOT NULL,
      "traceId" TEXT,
      "errorMessage" TEXT,
      "scheduledAt" TIMESTAMPTZ,
      "sentAt" TIMESTAMPTZ,
      "deliveredAt" TIMESTAMPTZ,
      "readAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_message_instance_created" ON ${schema}."Message" ("instanceId", "createdAt");`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_message_status" ON ${schema}."Message" ("status");`,
    `CREATE TABLE IF NOT EXISTS ${schema}."WebhookEndpoint" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL UNIQUE REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "url" TEXT NOT NULL,
      "secretEncrypted" TEXT NOT NULL,
      "headers" JSONB NOT NULL,
      "subscribedEvents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS ${schema}."WebhookDelivery" (
      "id" TEXT PRIMARY KEY,
      "webhookEndpointId" TEXT NOT NULL REFERENCES ${schema}."WebhookEndpoint"("id") ON DELETE CASCADE,
      "eventType" TEXT NOT NULL,
      "payload" JSONB NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "attempt" INTEGER NOT NULL DEFAULT 0,
      "httpStatus" INTEGER,
      "responseBody" TEXT,
      "nextRetryAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_delivery_endpoint_status" ON ${schema}."WebhookDelivery" ("webhookEndpointId", "status");`,
    `CREATE TABLE IF NOT EXISTS ${schema}."Contact" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "phoneNumber" TEXT NOT NULL,
      "displayName" TEXT,
      "fields" JSONB,
      "notes" TEXT,
      "isBlacklisted" BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "uniq_${schemaName}_instance_phone" UNIQUE ("instanceId", "phoneNumber")
    );`,
    `CREATE TABLE IF NOT EXISTS ${schema}."Conversation" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "contactId" TEXT NOT NULL REFERENCES ${schema}."Contact"("id") ON DELETE CASCADE,
      "phoneNumber" TEXT,
      "assignedToUserId" TEXT,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "leadSent" BOOLEAN NOT NULL DEFAULT FALSE,
      "awaitingLeadExtraction" BOOLEAN NOT NULL DEFAULT FALSE,
      "humanTakeover" BOOLEAN NOT NULL DEFAULT FALSE,
      "humanTakeoverAt" TIMESTAMPTZ,
      "aiDisabledPermanent" BOOLEAN NOT NULL DEFAULT FALSE,
      "awaitingAdminResponse" BOOLEAN NOT NULL DEFAULT FALSE,
      "pendingClientQuestion" TEXT,
      "pendingClientJid" TEXT,
      "pendingClientConversationId" TEXT,
      "slaDeadlineAt" TIMESTAMPTZ,
      "lastMessageAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_conversation_status" ON ${schema}."Conversation" ("status");`,
    `CREATE TABLE IF NOT EXISTS ${schema}."MessageTemplate" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL UNIQUE,
      "body" TEXT NOT NULL,
      "variables" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS ${schema}."ChatbotConfig" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL UNIQUE REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "isEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "welcomeMessage" TEXT,
      "fallbackMessage" TEXT,
      "humanTakeoverStartMessage" TEXT,
      "humanTakeoverEndMessage" TEXT,
      "rules" JSONB NOT NULL DEFAULT '[]'::JSONB,
      "aiSettings" JSONB NOT NULL DEFAULT '{}'::JSONB,
      "aiApiKeyEncrypted" TEXT,
      "aiFallbackProvider" TEXT,
      "aiFallbackApiKey" TEXT,
      "aiFallbackModel" TEXT,
      "leadsGroupJid" TEXT,
      "leadsGroupName" TEXT,
      "leadsPhoneNumber" TEXT,
      "leadsEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
      "fiadoEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "audioEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "visionEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
      "visionPrompt" TEXT,
      "responseDelayMs" INTEGER NOT NULL DEFAULT 3000,
      "leadAutoExtract" BOOLEAN NOT NULL DEFAULT FALSE,
      "leadVehicleTable" JSONB NOT NULL DEFAULT '{}'::JSONB,
      "leadPriceTable" JSONB NOT NULL DEFAULT '{}'::JSONB,
      "leadSurchargeTable" JSONB NOT NULL DEFAULT '{}'::JSONB,
      "modules" JSONB NOT NULL DEFAULT '{}'::JSONB,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS ${schema}."AuditLog" (
      "id" TEXT PRIMARY KEY,
      "actorType" TEXT NOT NULL,
      "actorId" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "ipAddress" TEXT NOT NULL,
      "targetType" TEXT NOT NULL,
      "targetId" TEXT NOT NULL,
      "payload" JSONB NOT NULL,
      "signature" TEXT NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS ${schema}."ClientMemory" (
      "id" TEXT PRIMARY KEY,
      "phoneNumber" TEXT NOT NULL UNIQUE,
      "name" TEXT,
      "isExistingClient" BOOLEAN NOT NULL DEFAULT FALSE,
      "projectDescription" TEXT,
      "serviceInterest" TEXT,
      "status" TEXT NOT NULL DEFAULT 'lead_frio',
      "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "notes" TEXT,
      "lastContactAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "scheduledAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS ${schema}."TenantKnowledge" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "question" TEXT NOT NULL,
      "answer" TEXT NOT NULL,
      "rawAnswer" TEXT,
      "taughtBy" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_knowledge_instance" ON ${schema}."TenantKnowledge" ("instanceId");`,
    `CREATE TABLE IF NOT EXISTS ${schema}."FiadoTab" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "phoneNumber" TEXT NOT NULL,
      "displayName" TEXT,
      "total" DECIMAL(10,2) NOT NULL DEFAULT 0,
      "items" JSONB NOT NULL DEFAULT '[]'::JSONB,
      "paidAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "uniq_${schemaName}_fiado_instance_phone" UNIQUE ("instanceId", "phoneNumber")
    );`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_audit_created" ON ${schema}."AuditLog" ("createdAt");`,
    `CREATE TABLE IF NOT EXISTS ${schema}."ContactPersistentMemory" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "phoneNumber" TEXT NOT NULL,
      "data" JSONB NOT NULL DEFAULT '{}'::JSONB,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "uniq_${schemaName}_persistent_memory_instance_phone" UNIQUE ("instanceId", "phoneNumber")
    );`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_persistent_memory_instance" ON ${schema}."ContactPersistentMemory" ("instanceId");`,
    `CREATE TABLE IF NOT EXISTS ${schema}."ConversationSession" (
      "id" TEXT PRIMARY KEY,
      "instanceId" TEXT NOT NULL REFERENCES ${schema}."Instance"("id") ON DELETE CASCADE,
      "contactId" TEXT,
      "remoteJid" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'ATIVA',
      "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "endedAt" TIMESTAMPTZ,
      "durationSeconds" INTEGER,
      "firstResponseMs" INTEGER,
      "handoffCount" INTEGER NOT NULL DEFAULT 0,
      "closedReason" TEXT,
      "conversationId" TEXT REFERENCES ${schema}."Conversation"("id") ON DELETE SET NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_session_instance_started"
      ON ${schema}."ConversationSession" ("instanceId", "startedAt");`,
    `CREATE INDEX IF NOT EXISTS "idx_${schemaName}_session_remote_jid"
      ON ${schema}."ConversationSession" ("instanceId", "remoteJid");`
  ];
};
