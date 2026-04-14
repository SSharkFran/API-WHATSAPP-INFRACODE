CREATE TABLE IF NOT EXISTS "ContactPersistentMemory" (
  "id"          TEXT NOT NULL,
  "instanceId"  TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  "data"        JSONB NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "ContactPersistentMemory_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ContactPersistentMemory_instanceId_phoneNumber_key"
  ON "ContactPersistentMemory"("instanceId", "phoneNumber");

CREATE INDEX IF NOT EXISTS "ContactPersistentMemory_instanceId_idx"
  ON "ContactPersistentMemory"("instanceId");
