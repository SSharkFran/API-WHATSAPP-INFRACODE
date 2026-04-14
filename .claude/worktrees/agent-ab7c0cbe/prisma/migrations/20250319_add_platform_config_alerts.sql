-- Migration: add_platform_config_alert_fields
-- Description: Adds PlatformConfig table for global admin alert configuration

CREATE TABLE IF NOT EXISTS "PlatformConfig" (
  "id" TEXT PRIMARY KEY DEFAULT 'singleton',
  "adminAlertPhone" TEXT DEFAULT NULL,
  "groqUsageLimit" INTEGER DEFAULT 80,
  "alertInstanceDown" BOOLEAN DEFAULT true,
  "alertNewLead" BOOLEAN DEFAULT true,
  "alertHighTokens" BOOLEAN DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Insert default singleton config if not exists
INSERT INTO "PlatformConfig" ("id", "adminAlertPhone", "groqUsageLimit", "alertInstanceDown", "alertNewLead", "alertHighTokens", "updatedAt", "createdAt")
VALUES ('singleton', NULL, 80, true, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
