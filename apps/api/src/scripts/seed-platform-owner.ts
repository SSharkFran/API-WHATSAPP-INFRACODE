import { loadConfig } from "../config.js";
import { createPlatformPrisma } from "../lib/database.js";
import { hashPassword } from "../lib/password.js";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const prisma = createPlatformPrisma(config);
  const email = process.env.PLATFORM_OWNER_EMAIL ?? "owner@infracode.local";
  const password = process.env.PLATFORM_OWNER_PASSWORD ?? "ChangeMe123!";
  const name = process.env.PLATFORM_OWNER_NAME ?? "InfraCode Owner";

  try {
    await prisma.user.upsert({
      where: {
        email
      },
      update: {
        isActive: true,
        name,
        passwordHash: await hashPassword(password),
        platformRole: "PLATFORM_OWNER"
      },
      create: {
        email,
        isActive: true,
        name,
        passwordHash: await hashPassword(password),
        platformRole: "PLATFORM_OWNER"
      }
    });

    await prisma.billingPlan.upsert({
      where: {
        code: "STARTER_10K"
      },
      update: {},
      create: {
        code: "STARTER_10K",
        name: "Starter 10K",
        description: "Plano inicial padrão da InfraCode",
        priceCents: 9900,
        currency: "BRL",
        instanceLimit: 1,
        messagesPerMonth: 10000,
        usersLimit: 2,
        rateLimitPerMinute: 20,
        isActive: true
      }
    });

    console.info(JSON.stringify({ email, seeded: true }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
};

void main();
