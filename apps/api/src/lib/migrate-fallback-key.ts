/**
 * One-time migration: encrypt any plaintext aiFallbackApiKey values in tenant ChatbotConfig rows.
 * Safe to run multiple times (idempotent) — rows already encrypted are skipped.
 *
 * For multi-tenant deployments where each tenant has its own PostgreSQL schema,
 * invoke migrateFallbackApiKeys() once per schema:
 *   for (const schema of tenantSchemas) {
 *     await migrateFallbackApiKeys(prisma, encryptionKey, schema);
 *   }
 *
 * Usage (single schema): pnpm tsx apps/api/src/lib/migrate-fallback-key.ts
 */
import { PrismaClient } from "../../../../prisma/generated/tenant-client/index.js";
import { encrypt } from "./crypto.js";
import { loadConfig } from "../config.js";

/**
 * Detects whether a stored value is already AES-256-GCM ciphertext in iv.tag.ciphertext format.
 * The IV is 12 bytes, which when base64-encoded produces exactly 16 characters and decodes to 12 bytes.
 */
const isAlreadyEncrypted = (value: string): boolean => {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    return Buffer.from(parts[0], 'base64').length === 12;
  } catch {
    return false;
  }
};

export async function migrateFallbackApiKeys(
  prisma: PrismaClient,
  encryptionKey: string,
  schema: string = 'public'
): Promise<{ updated: number; skipped: number; errors: number }> {
  const results = { updated: 0, skipped: 0, errors: 0 };

  // Use raw SQL with schema prefix — Prisma ORM targets the configured schema only.
  // For per-tenant schemas, pass the correct schema name for each tenant.
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; aiFallbackApiKey: string }>>(
    `SELECT id, "aiFallbackApiKey" FROM ${schema}."ChatbotConfig" WHERE "aiFallbackApiKey" IS NOT NULL`
  );

  for (const row of rows) {
    try {
      if (isAlreadyEncrypted(row.aiFallbackApiKey)) {
        results.skipped++;
        continue;
      }
      const encrypted = encrypt(row.aiFallbackApiKey, encryptionKey);
      await prisma.$executeRawUnsafe(
        `UPDATE ${schema}."ChatbotConfig" SET "aiFallbackApiKey" = $1 WHERE id = $2`,
        encrypted,
        row.id
      );
      results.updated++;
      // Log row ID only — never log the plaintext key value
      console.log(`[migrate-fallback-key] Encrypted row ${row.id}`);
    } catch (err) {
      console.error(`[migrate-fallback-key] Error for row ${row.id}:`, err);
      results.errors++;
    }
  }

  return results;
}

// CLI entry point — only runs when executed directly, not when imported as a module
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = loadConfig();
  const prisma = new PrismaClient({
    datasources: { db: { url: config.TENANT_DATABASE_URL } }
  });

  migrateFallbackApiKeys(prisma, config.API_ENCRYPTION_KEY)
    .then((r) => {
      console.log(
        `[migrate-fallback-key] Done. Updated: ${r.updated}, Skipped: ${r.skipped}, Errors: ${r.errors}`
      );
      process.exit(r.errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("[migrate-fallback-key] Fatal error:", err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
