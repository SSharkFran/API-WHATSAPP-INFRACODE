import { describe, it, expect, vi, beforeEach } from "vitest";
import { InstanceOrchestrator } from "../service.js";
import { InstanceEventBus } from "../../../lib/instance-events.js";
import type { Instance } from "../../../../../../prisma/generated/tenant-client/index.js";

// ---------------------------------------------------------------------------
// Minimal stub factories
// ---------------------------------------------------------------------------

function makeContact() {
  return {
    id: "contact-1",
    instanceId: "inst-1",
    phoneNumber: "5511999999999",
    displayName: "Test User",
    fields: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makePrisma() {
  const contact = makeContact();
  return {
    contact: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(contact),
    },
    message: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    chatbotConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    instance: {
      findUnique: vi.fn().mockResolvedValue({ phoneNumber: null }),
    },
    conversation: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "conv-1" }),
    },
    $transaction: vi.fn().mockImplementation((fn: unknown) =>
      typeof fn === "function" ? fn(makePrisma()) : Promise.resolve([])
    ),
  };
}

function makePlatformPrisma() {
  return {
    platformConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ id: "tenant-1" }),
    },
  };
}

function makeTenantPrismaRegistry(prisma: ReturnType<typeof makePrisma>) {
  return {
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    getClient: vi.fn().mockResolvedValue(prisma),
  };
}

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    hget: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue(null),
  };
}

function makeEscalationService() {
  return {
    resolveConversationIdByAdminAlertMessageAsync: vi.fn().mockResolvedValue(null),
    resolveConversationIdByAdminAlertChat: vi.fn().mockReturnValue(null),
    resolveConversationIdByPersistedAdminPrompt: vi.fn().mockResolvedValue(null),
    releaseTimedOutEscalations: vi.fn().mockResolvedValue(undefined),
    setPlatformAlertService: vi.fn(),
    setChatbotService: vi.fn(),
  };
}

function makeChatbotService() {
  return {
    generateResponse: vi.fn().mockResolvedValue({ text: "ok" }),
    setPlatformAlertService: vi.fn(),
  };
}

function makeLogger() {
  const child = () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child,
  });
  return { child, info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as import("pino").Logger;
}

function makeOrchestratorDeps(overrides: Record<string, unknown> = {}) {
  const prisma = makePrisma();
  return {
    config: {
      NODE_ENV: "test",
      DATA_DIR: "/tmp/test-data",
    } as unknown as import("../../../config.js").AppConfig,
    metricsService: {
      setInstanceStatus: vi.fn(),
      recordInstanceMessage: vi.fn(),
    } as unknown,
    platformPrisma: makePlatformPrisma() as unknown,
    tenantPrismaRegistry: makeTenantPrismaRegistry(prisma) as unknown,
    redis: makeRedis() as unknown,
    webhookService: {
      dispatchWebhook: vi.fn().mockResolvedValue(undefined),
    } as unknown,
    planEnforcementService: {} as unknown,
    chatbotService: makeChatbotService() as unknown,
    clientMemoryService: {
      getOrCreateMemory: vi.fn().mockResolvedValue({}),
      getTags: vi.fn().mockResolvedValue([]),
    } as unknown,
    adminMemoryService: {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
    } as unknown,
    adminCommandService: {
      generateDailySummary: vi.fn().mockResolvedValue(""),
    } as unknown,
    fiadoService: {
      listFiados: vi.fn().mockResolvedValue([]),
    } as unknown,
    escalationService: makeEscalationService() as unknown,
    sendMessageQueue: {
      add: vi.fn().mockResolvedValue({ id: "msg-job" }),
    } as unknown,
    ...overrides,
  };
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    tenantId: "tenant-1",
    name: "Test Instance",
    status: "CONNECTED",
    phoneNumber: "5511900000000",
    avatarUrl: null,
    isEnabled: true,
    chatbotEnabled: true,
    autoStart: true,
    aiBlocked: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  } as unknown as Instance;
}

function makeInboundEvent(text: string, fromMe = false) {
  return {
    type: "inbound-message" as const,
    remoteJid: "5511999999999@s.whatsapp.net",
    senderJid: "5511999999999@s.whatsapp.net",
    messageType: "text" as const,
    payload: { text },
    rawMessage: {},
    externalMessageId: `ext-${Date.now()}`,
    messageKey: { fromMe, id: `key-${Date.now()}`, remoteJid: "5511999999999@s.whatsapp.net" },
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers to stub adminIdentityService.resolve on an orchestrator instance
// ---------------------------------------------------------------------------

function stubAdminIdentity(orchestrator: InstanceOrchestrator, isAdmin: boolean) {
  const identityService = (orchestrator as unknown as Record<string, unknown>).adminIdentityService;
  vi.spyOn(identityService as { resolve: (i: unknown) => unknown }, "resolve").mockReturnValue({
    isAdmin,
    isVerifiedAdmin: isAdmin,
    isInstanceSelf: false,
    isAdminSelfChat: false,
    canReceiveLearningReply: false,
    matchedAdminPhone: isAdmin ? "5511900000000" : null,
    isAdminOrInstanceSender: isAdmin,
    shouldBypassDirectSenderTakeover: false,
    isAdminLearningReply: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InstanceOrchestrator — InstanceEventBus wiring", () => {
  let eventBus: InstanceEventBus;
  let orchestrator: InstanceOrchestrator;
  const tenantId = "tenant-1";
  const instance = makeInstance();

  beforeEach(() => {
    eventBus = new InstanceEventBus();
    vi.spyOn(eventBus, "emit");

    const deps = makeOrchestratorDeps({ eventBus });
    orchestrator = new InstanceOrchestrator(deps as Parameters<typeof InstanceOrchestrator.prototype.constructor>[0]);
  });

  // Test 1: session.activity NOT emitted for admin messages
  it("does NOT emit session.activity when identityContext.isAdmin === true", async () => {
    stubAdminIdentity(orchestrator, true);
    const event = makeInboundEvent("hello admin");

    await (orchestrator as unknown as Record<string, (a: string, b: Instance, c: unknown) => Promise<void>>)
      .handleInboundMessage(tenantId, instance, event);

    const activityCalls = (eventBus.emit as ReturnType<typeof vi.spyOn>).mock.calls.filter(
      ([name]) => name === "session.activity"
    );
    expect(activityCalls).toHaveLength(0);
  });

  // Test 2: session.activity IS emitted for client messages
  it("emits session.activity when identityContext.isAdmin === false (client message)", async () => {
    stubAdminIdentity(orchestrator, false);
    const event = makeInboundEvent("boa tarde");

    await (orchestrator as unknown as Record<string, (a: string, b: Instance, c: unknown) => Promise<void>>)
      .handleInboundMessage(tenantId, instance, event);

    expect(eventBus.emit).toHaveBeenCalledWith(
      "session.activity",
      expect.objectContaining({
        type: "session.activity",
        tenantId,
        instanceId: instance.id,
        remoteJid: event.remoteJid,
      })
    );
  });

  // Test 3: admin.command IS emitted for admin messages
  it("emits admin.command when identityContext.isAdmin === true", async () => {
    stubAdminIdentity(orchestrator, true);
    const event = makeInboundEvent("status do sistema");

    await (orchestrator as unknown as Record<string, (a: string, b: Instance, c: unknown) => Promise<void>>)
      .handleInboundMessage(tenantId, instance, event);

    expect(eventBus.emit).toHaveBeenCalledWith(
      "admin.command",
      expect.objectContaining({
        type: "admin.command",
        tenantId,
        instanceId: instance.id,
        command: "status do sistema",
        fromJid: event.remoteJid,
      })
    );
  });

  // Test 4: session.close_intent_detected IS emitted when recognizeCloseIntent returns true
  it("emits session.close_intent_detected when message contains a closure phrase (non-admin)", async () => {
    stubAdminIdentity(orchestrator, false);
    const event = makeInboundEvent("obrigado, era só isso");

    await (orchestrator as unknown as Record<string, (a: string, b: Instance, c: unknown) => Promise<void>>)
      .handleInboundMessage(tenantId, instance, event);

    expect(eventBus.emit).toHaveBeenCalledWith(
      "session.close_intent_detected",
      expect.objectContaining({
        type: "session.close_intent_detected",
        tenantId,
        instanceId: instance.id,
        remoteJid: event.remoteJid,
        intentLabel: "ENCERRAMENTO",
      })
    );
  });

  // Test 5: session.close_intent_detected NOT emitted for non-closure messages
  it("does NOT emit session.close_intent_detected when message has no closure phrase", async () => {
    stubAdminIdentity(orchestrator, false);
    const event = makeInboundEvent("qual o horario de funcionamento?");

    await (orchestrator as unknown as Record<string, (a: string, b: Instance, c: unknown) => Promise<void>>)
      .handleInboundMessage(tenantId, instance, event);

    const closeCalls = (eventBus.emit as ReturnType<typeof vi.spyOn>).mock.calls.filter(
      ([name]) => name === "session.close_intent_detected"
    );
    expect(closeCalls).toHaveLength(0);
  });
});
