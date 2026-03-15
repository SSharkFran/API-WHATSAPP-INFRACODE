import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/lib/password.js";

const describeIfDb = process.env.RUN_DB_TESTS === "true" ? describe : describe.skip;

describeIfDb("InfraCode SaaS Multi-tenant", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    process.env.ENABLE_AUTH = "true";

    execFileSync("cmd.exe", ["/c", "pnpm.cmd", "--filter", "@infracode/api", "prisma:push:platform"], {
      cwd: process.cwd(),
      env: {
        ...process.env
      },
      stdio: "inherit"
    });

    app = await buildApp();
  });

  beforeEach(async () => {
    await cleanPlatformState(app);
    await seedPlatformOwner(app);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("isola tenants, aplica permissao por escopo e permite impersonacao controlada", async () => {
    const adminToken = await loginAdmin(app);
    const planId = await createPlan(app, adminToken, {
      code: "SCALE_25",
      instanceLimit: 2,
      messagesPerMonth: 25000,
      usersLimit: 4,
      rateLimitPerMinute: 30
    });

    const tenantA = await createTenant(app, adminToken, {
      firstAdminEmail: "owner-a@tenant.test",
      name: "Tenant A",
      slug: "tenant-a",
      planId
    });

    const tenantB = await createTenant(app, adminToken, {
      firstAdminEmail: "owner-b@tenant.test",
      name: "Tenant B",
      slug: "tenant-b",
      planId
    });

    const tenantATokens = await acceptInvitation(app, tenantA.firstAccessToken, "Alice A", "TenantA123!");
    const tenantBTokens = await acceptInvitation(app, tenantB.firstAccessToken, "Bob B", "TenantB123!");

    const tenantDashboardForbidden = await app.inject({
      method: "GET",
      url: "/tenant/dashboard",
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });

    expect(tenantDashboardForbidden.statusCode).toBe(403);

    const createInstanceResponse = await app.inject({
      method: "POST",
      url: "/instances",
      headers: {
        authorization: `Bearer ${tenantATokens.accessToken}`
      },
      payload: {
        name: "Primary WA",
        autoStart: false
      }
    });

    expect(createInstanceResponse.statusCode).toBe(200);
    const instanceA = createInstanceResponse.json() as { id: string };

    const listTenantA = await app.inject({
      method: "GET",
      url: "/instances",
      headers: {
        authorization: `Bearer ${tenantATokens.accessToken}`
      }
    });

    const listTenantB = await app.inject({
      method: "GET",
      url: "/instances",
      headers: {
        authorization: `Bearer ${tenantBTokens.accessToken}`
      }
    });

    expect(listTenantA.statusCode).toBe(200);
    expect(listTenantB.statusCode).toBe(200);
    expect((listTenantA.json() as Array<{ id: string }>)).toHaveLength(1);
    expect((listTenantB.json() as Array<{ id: string }>)).toHaveLength(0);

    const crossTenantHealth = await app.inject({
      method: "GET",
      url: `/instances/${instanceA.id}/health`,
      headers: {
        authorization: `Bearer ${tenantBTokens.accessToken}`
      }
    });

    expect(crossTenantHealth.statusCode).toBe(404);

    const readOnlyKeyResponse = await app.inject({
      method: "POST",
      url: "/tenant/api-keys",
      headers: {
        authorization: `Bearer ${tenantATokens.accessToken}`
      },
      payload: {
        name: "Read Only",
        scopes: ["read"]
      }
    });

    expect(readOnlyKeyResponse.statusCode).toBe(200);
    const readOnlyKey = readOnlyKeyResponse.json() as { apiKey: string };

    const readOnlyCreate = await app.inject({
      method: "POST",
      url: "/instances",
      headers: {
        "x-api-key": readOnlyKey.apiKey
      },
      payload: {
        name: "Blocked by scope",
        autoStart: false
      }
    });

    expect(readOnlyCreate.statusCode).toBe(403);

    const apiListInstances = await app.inject({
      method: "GET",
      url: "/instances",
      headers: {
        "x-api-key": readOnlyKey.apiKey
      }
    });

    expect(apiListInstances.statusCode).toBe(200);
    expect((apiListInstances.json() as Array<{ id: string }>).map((item) => item.id)).toEqual([instanceA.id]);

    const impersonationResponse = await app.inject({
      method: "POST",
      url: `/admin/impersonation/${tenantA.tenant.id}`,
      headers: {
        authorization: `Bearer ${adminToken}`
      },
      payload: {
        reason: "Suporte onboarding"
      }
    });

    expect(impersonationResponse.statusCode).toBe(200);
    const impersonationTokens = impersonationResponse.json() as { accessToken: string };

    const dashboardViaImpersonation = await app.inject({
      method: "GET",
      url: "/tenant/dashboard",
      headers: {
        authorization: `Bearer ${impersonationTokens.accessToken}`
      }
    });

    expect(dashboardViaImpersonation.statusCode).toBe(200);

    const adminRouteWithImpersonation = await app.inject({
      method: "GET",
      url: "/admin/tenants",
      headers: {
        authorization: `Bearer ${impersonationTokens.accessToken}`
      }
    });

    expect(adminRouteWithImpersonation.statusCode).toBe(403);
  });

  it("aceita os tipos de mensagem suportados, configura webhook e respeita limite de instancias do plano", async () => {
    const adminToken = await loginAdmin(app);
    const planId = await createPlan(app, adminToken, {
      code: "STARTER_1",
      instanceLimit: 1,
      messagesPerMonth: 1000,
      usersLimit: 2,
      rateLimitPerMinute: 60
    });

    const tenant = await createTenant(app, adminToken, {
      firstAdminEmail: "owner@starter.test",
      name: "Starter Tenant",
      slug: "starter-tenant",
      planId
    });

    const tenantTokens = await acceptInvitation(app, tenant.firstAccessToken, "Starter User", "Starter123!");

    const createInstanceResponse = await app.inject({
      method: "POST",
      url: "/instances",
      headers: {
        authorization: `Bearer ${tenantTokens.accessToken}`
      },
      payload: {
        name: "Only Instance",
        autoStart: false
      }
    });

    expect(createInstanceResponse.statusCode).toBe(200);
    const instance = createInstanceResponse.json() as { id: string };

    const secondInstanceResponse = await app.inject({
      method: "POST",
      url: "/instances",
      headers: {
        authorization: `Bearer ${tenantTokens.accessToken}`
      },
      payload: {
        name: "Should Fail",
        autoStart: false
      }
    });

    expect(secondInstanceResponse.statusCode).toBe(409);

    const messagePayloads = [
      { type: "text", to: "5511999999999", text: "Oi" },
      { type: "image", to: "5511999999999", media: { mimeType: "image/png", base64: "aGVsbG8=" } },
      { type: "video", to: "5511999999999", media: { mimeType: "video/mp4", base64: "aGVsbG8=" } },
      { type: "audio", to: "5511999999999", media: { mimeType: "audio/mpeg", base64: "aGVsbG8=" } },
      { type: "document", to: "5511999999999", media: { mimeType: "application/pdf", base64: "aGVsbG8=", fileName: "doc.pdf" } },
      { type: "sticker", to: "5511999999999", media: { mimeType: "image/webp", base64: "aGVsbG8=" } },
      { type: "location", to: "5511999999999", latitude: -23.55, longitude: -46.63, name: "Sao Paulo" },
      { type: "contact", to: "5511999999999", displayName: "Contato", vcard: "BEGIN:VCARD\nFN:Contato\nTEL:+5511999999999\nEND:VCARD" },
      { type: "poll", to: "5511999999999", title: "Escolha", options: ["A", "B"] },
      { type: "reaction", to: "5511999999999", emoji: "👍", targetMessageId: "wamid.demo" },
      { type: "list", to: "5511999999999", title: "Menu", description: "Escolha", buttonText: "Abrir", sections: [{ title: "Secao", rows: [{ id: "1", title: "Item 1" }] }] },
      { type: "buttons", to: "5511999999999", text: "Escolha", buttons: [{ id: "a", text: "A" }] },
      { type: "template", to: "5511999999999", templateName: "hello", body: "Ola {{nome}}", variables: { nome: "Cliente" } }
    ] satisfies Array<Record<string, unknown>>;

    for (const payload of messagePayloads) {
      const response = await app.inject({
        method: "POST",
        url: `/instances/${instance.id}/messages/send`,
        headers: {
          authorization: `Bearer ${tenantTokens.accessToken}`
        },
        payload
      });

      expect(response.statusCode).toBe(200);
    }

    const webhookResponse = await app.inject({
      method: "POST",
      url: `/instances/${instance.id}/webhooks`,
      headers: {
        authorization: `Bearer ${tenantTokens.accessToken}`
      },
      payload: {
        url: "https://example.org/webhook",
        secret: "tenant-secret-123",
        headers: {
          "x-custom-header": "1"
        },
        subscribedEvents: ["message.sent", "message.failed"],
        isActive: true
      }
    });

    expect(webhookResponse.statusCode).toBe(200);

    const onboardingResponse = await app.inject({
      method: "GET",
      url: "/tenant/onboarding",
      headers: {
        authorization: `Bearer ${tenantTokens.accessToken}`
      }
    });

    expect(onboardingResponse.statusCode).toBe(200);
    expect(onboardingResponse.json()).toMatchObject({
      currentStep: "INSTANCE_CONNECTED"
    });
  });
});

const seedPlatformOwner = async (app: Awaited<ReturnType<typeof buildApp>>) => {
  await app.platformPrisma.user.create({
    data: {
      email: "owner@infracode.test",
      name: "InfraCode Owner",
      passwordHash: await hashPassword("Admin123!"),
      platformRole: "PLATFORM_OWNER",
      isActive: true
    }
  });
};

const cleanPlatformState = async (app: Awaited<ReturnType<typeof buildApp>>) => {
  const tenants = await app.platformPrisma.tenant.findMany({
    select: {
      id: true,
      schemaName: true
    }
  });

  for (const tenant of tenants) {
    await app.tenantPrismaRegistry.disposeClient(tenant.id);
    await app.platformPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${tenant.schemaName.replaceAll("\"", "\"\"")}" CASCADE;`);
  }

  await app.platformPrisma.platformAuditLog.deleteMany();
  await app.platformPrisma.impersonationSession.deleteMany();
  await app.platformPrisma.refreshSession.deleteMany();
  await app.platformPrisma.passwordResetToken.deleteMany();
  await app.platformPrisma.invitation.deleteMany();
  await app.platformPrisma.apiKey.deleteMany();
  await app.platformPrisma.tenantMembership.deleteMany();
  await app.platformPrisma.billingSubscription.deleteMany();
  await app.platformPrisma.tenant.deleteMany();
  await app.platformPrisma.billingPlan.deleteMany();
  await app.platformPrisma.platformSetting.deleteMany();
  await app.platformPrisma.user.deleteMany();
};

const loginAdmin = async (app: Awaited<ReturnType<typeof buildApp>>) => {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: {
      host: "admin.infracode.local"
    },
    payload: {
      email: "owner@infracode.test",
      password: "Admin123!"
    }
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { accessToken: string }).accessToken;
};

const createPlan = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  accessToken: string,
  input: {
    code: string;
    instanceLimit: number;
    messagesPerMonth: number;
    usersLimit: number;
    rateLimitPerMinute: number;
  }
) => {
  const response = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: {
      ...input,
      name: input.code,
      description: `Plano ${input.code}`,
      priceCents: 9900,
      currency: "BRL"
    }
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { id: string }).id;
};

const createTenant = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  accessToken: string,
  input: {
    firstAdminEmail: string;
    name: string;
    slug: string;
    planId: string;
  }
) => {
  const response = await app.inject({
    method: "POST",
    url: "/admin/tenants",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: {
      ...input,
      billingEmail: input.firstAdminEmail
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json() as {
    firstAccessToken: string;
    tenant: {
      id: string;
      slug: string;
    };
  };
};

const acceptInvitation = async (app: Awaited<ReturnType<typeof buildApp>>, token: string, name: string, password: string) => {
  const response = await app.inject({
    method: "POST",
    url: "/auth/invitations/accept",
    payload: {
      token,
      name,
      password
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json() as {
    accessToken: string;
    refreshToken: string;
  };
};
