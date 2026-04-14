-- Migration: add_ai_fallback_fields_to_chatbot_config
-- Description: Adds AI fallback provider fields to ChatbotConfig table for automatic failover on rate limit or server errors

ALTER TABLE "ChatbotConfig"
  ADD COLUMN IF NOT EXISTS "aiFallbackProvider" TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "aiFallbackApiKey" TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "aiFallbackModel" TEXT DEFAULT NULL;
