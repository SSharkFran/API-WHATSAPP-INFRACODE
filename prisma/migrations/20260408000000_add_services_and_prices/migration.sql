-- AlterTable: add servicesAndPrices column to ChatbotConfig
-- Stores structured services/pricing info separately from the system prompt
-- so the AI can reference it as a lookup document instead of inline instructions.
ALTER TABLE "ChatbotConfig" ADD COLUMN "servicesAndPrices" TEXT;
