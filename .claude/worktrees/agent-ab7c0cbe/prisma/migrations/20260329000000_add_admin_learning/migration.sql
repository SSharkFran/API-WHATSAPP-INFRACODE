-- Campos de aprendizado na Conversation
ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "awaitingAdminResponse" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pendingClientQuestion" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingClientJid" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingClientConversationId" TEXT;

-- Tabela de conhecimento aprendido por instância
CREATE TABLE IF NOT EXISTS "TenantKnowledge" (
  "id"          TEXT NOT NULL,
  "instanceId"  TEXT NOT NULL,
  "question"    TEXT NOT NULL,
  "answer"      TEXT NOT NULL,
  "rawAnswer"   TEXT,
  "taughtBy"    TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TenantKnowledge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TenantKnowledge_instanceId_idx"
  ON "TenantKnowledge"("instanceId");

ALTER TABLE "TenantKnowledge"
  ADD CONSTRAINT "TenantKnowledge_instanceId_fkey"
  FOREIGN KEY ("instanceId")
  REFERENCES "Instance"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
