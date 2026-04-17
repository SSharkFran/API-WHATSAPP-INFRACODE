/**
 * Migration script: encrypt plaintext API keys in database
 *
 * Migrates records where apiKeyEncrypted (TenantAiProvider) or
 * aiFallbackApiKey (ChatbotConfig) are stored as plaintext.
 *
 * Safe to run multiple times — skips already-encrypted values.
 *
 * Usage:
 *   npx tsx scripts/migrate-encrypt-api-keys.ts
 *
 * Required env:
 *   DATABASE_URL / PLATFORM_DATABASE_URL
 *   API_ENCRYPTION_KEY
 */

import { PrismaClient as PlatformPrismaClient } from "../prisma/generated/platform-client/index.js";
import { createHash, randomBytes, createCipheriv } from "node:crypto";

// ---------------------------------------------------------------------------
// Inline encrypt (avoids importing from compiled app)
// ---------------------------------------------------------------------------

const IV_LENGTH = 12;

function encrypt(plaintext: string, key: string): string {
  const normalizedKey = createHash("sha256").update(key).digest();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", normalizedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function isAlreadyEncrypted(value: string): boolean {
  // Encrypted format: base64.base64.base64 (3 dot-separated segments)
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  // Each segment must be valid base64
  return parts.every(p => /^[A-Za-z0-9+/=]+$/.test(p) && p.length > 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const encryptionKey = process.env.API_ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error("❌ API_ENCRYPTION_KEY is not set");
    process.exit(1);
  }
  if (encryptionKey.length < 32) {
    console.error("❌ API_ENCRYPTION_KEY must be at least 32 characters");
    process.exit(1);
  }

  const platformUrl = process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL;
  const tenantUrl   = process.env.TENANT_DATABASE_URL   ?? process.env.DATABASE_URL;

  if (!platformUrl || !tenantUrl) {
    console.error("❌ DATABASE_URL (or PLATFORM_DATABASE_URL + TENANT_DATABASE_URL) must be set");
    process.exit(1);
  }

  // --- Platform DB: TenantAiProvider.apiKeyEncrypted ---
  const platformUrlWithSchema = platformUrl.includes("?")
    ? `${platformUrl}&schema=platform`
    : `${platformUrl}?schema=platform`;
  const platformPrisma = new PlatformPrismaClient({ datasources: { db: { url: platformUrlWithSchema } } });

  console.log("\n📦 Migrating TenantAiProvider.apiKeyEncrypted (platform DB)...");
  let platformUpdated = 0;
  let platformSkipped = 0;

  const providers = await platformPrisma.tenantAiProvider.findMany({
    select: { id: true, apiKeyEncrypted: true },
  });

  for (const provider of providers) {
    if (isAlreadyEncrypted(provider.apiKeyEncrypted)) {
      platformSkipped++;
      continue;
    }
    const encrypted = encrypt(provider.apiKeyEncrypted, encryptionKey);
    await platformPrisma.tenantAiProvider.update({
      where: { id: provider.id },
      data: { apiKeyEncrypted: encrypted },
    });
    platformUpdated++;
    console.log(`  ✓ TenantAiProvider ${provider.id} — encrypted`);
  }

  console.log(`  Platform: ${platformUpdated} updated, ${platformSkipped} already encrypted`);
  await platformPrisma.$disconnect();

  // --- Tenant DB(s): ChatbotConfig.aiFallbackApiKey ---
  // Get all tenants from platform DB to iterate their schemas
  const platformPrisma2 = new PlatformPrismaClient({ datasources: { db: { url: platformUrlWithSchema } } });
  const tenants = await platformPrisma2.tenant.findMany({ select: { id: true, slug: true } });
  await platformPrisma2.$disconnect();

  console.log(`\n📦 Migrating ChatbotConfig.aiFallbackApiKey (${tenants.length} tenant schemas)...`);
  let tenantUpdated = 0;
  let tenantSkipped = 0;

  for (const tenant of tenants) {
    // Each tenant has its own schema — connect with schema search_path
    const schemaName = `tenant_${tenant.id.replace(/-/g, "_")}`;
    const tenantPrismaUrl = `${tenantUrl}?schema=${schemaName}`;

    // Dynamic import to get a fresh client per schema
    const { PrismaClient: TenantPrismaClient } = await import(
      "../prisma/generated/tenant-client/index.js"
    );

    const tenantPrisma = new TenantPrismaClient({
      datasources: { db: { url: tenantPrismaUrl } },
    });

    try {
      const configs = await tenantPrisma.chatbotConfig.findMany({
        where: { aiFallbackApiKey: { not: null } },
        select: { id: true, aiFallbackApiKey: true },
      });

      for (const config of configs) {
        const raw = config.aiFallbackApiKey!;
        if (isAlreadyEncrypted(raw)) {
          tenantSkipped++;
          continue;
        }
        const encrypted = encrypt(raw, encryptionKey);
        await tenantPrisma.chatbotConfig.update({
          where: { id: config.id },
          data: { aiFallbackApiKey: encrypted },
        });
        tenantUpdated++;
        console.log(`  ✓ Tenant ${tenant.slug} — ChatbotConfig ${config.id} encrypted`);
      }
    } catch (err) {
      console.warn(`  ⚠ Tenant ${tenant.slug} (${schemaName}): ${(err as Error).message}`);
    } finally {
      await tenantPrisma.$disconnect();
    }
  }

  console.log(`  Tenant configs: ${tenantUpdated} updated, ${tenantSkipped} already encrypted`);
  console.log("\n✅ Migration complete.");
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
