import { PrismaClient } from "@prisma/client";

/**
 * Instância única do Prisma Client para o processo atual.
 */
export const prisma = new PrismaClient({
  log: ["error", "warn"]
});
