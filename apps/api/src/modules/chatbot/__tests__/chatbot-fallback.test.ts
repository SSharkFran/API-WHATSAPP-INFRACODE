/**
 * Unit tests for IA-03 and IA-04: Honest fallback when chatbotResult is null.
 *
 * Strategy: Call the private processConversationTurn method directly with the minimal
 * set of dependencies mocked. The method name is "processConversationTurn" in
 * InstanceOrchestrator.
 *
 * These tests verify that:
 * - When chatbotResult is null AND session is not blocked, client receives honest fallback (IA-03)
 * - When chatbotResult is null AND session IS blocked, silence is preserved
 * - Part B admin notification fires only when aprendizadoContinuo is enabled (IA-04)
 * - Part B is suppressed when aprendizadoContinuo is disabled
 * - Part B is skipped (warn logged) when adminPhone is null, but Part A still fires
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InstanceOrchestrator } from "../../instances/service.js";

// ---------------------------------------------------------------------------
// Constants under test (asserted in tests to match service.ts exactly)
// ---------------------------------------------------------------------------

const HONEST_FALLBACK_MESSAGE =
  "Essa é uma ótima pergunta! Não tenho essa informação no momento. Vou verificar com nossa equipe e retorno em breve.";

// ---------------------------------------------------------------------------
// Minimal stub factories
// ---------------------------------------------------------------------------

function makePrisma() {
  return {
    contact: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "contact-1" }),
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
      findUnique: vi.fn().mockResolvedValue({
        id: "conv-1",
        humanTakeover: false,
        aiDisabledPermanent: false,
        awaitingAdminResponse: false,
      }),
      upsert: vi.fn().mockResolvedValue({ id: "conv-1" }),
    },
    $transaction: vi.fn().mockImplementation((fn: unknown) =>
      typeof fn === "function" ? fn(makePrisma()) : Promise.resolve([])
    ),
  };
}

function makePlatformPrisma(adminAlertPhone: string | null = null) {
  return {
    platformConfig: {
      findUnique: vi.fn().mockResolvedValue(adminAlertPhone ? { adminAlertPhone } : null),
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
    hset: vi.fn().mockResolvedValue(1),
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

function makeClientMemoryService() {
  return {
    findByPhone: vi.fn().mockResolvedValue(null),
    getOrCreateMemory: vi.fn().mockResolvedValue({ tags: [] }),
    getTags: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
  };
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
    clientMemoryService: makeClientMemoryService() as unknown,
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

// ---------------------------------------------------------------------------
// Helper: build minimal processConversationTurn params
// ---------------------------------------------------------------------------

function makeSession() {
  return {
    history: [],
    leadAlreadySent: false,
    generation: 1,
    lastIntentClassification: null,
  };
}

function makeParams(chatbotConfigOverrides: Record<string, unknown> | null = null) {
  const session = makeSession();
  return {
    tenantId: "tenant-1",
    instance: {
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
    },
    conversationId: "conv-1",
    targetJid: "5511999999999@s.whatsapp.net",
    remoteNumber: "5511999999999",
    resolvedContactNumber: "5511999999999",
    conversationPhoneNumber: "5511999999999",
    contactPhoneNumber: "5511999999999",
    contactDisplayName: "Test User",
    contactFields: null,
    inputText: "Qual o valor do plano premium?",
    isFirstContact: false,
    session,
    sessionGeneration: session.generation,
    chatbotConfig: chatbotConfigOverrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IA-03/IA-04: Honest fallback when chatbotResult is null", () => {
  let deps: ReturnType<typeof makeOrchestratorDeps>;
  let orchestrator: InstanceOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeOrchestratorDeps();
    orchestrator = new InstanceOrchestrator(deps as ConstructorParameters<typeof InstanceOrchestrator>[0]);
  });

  /**
   * Helper: stub the private internals of processConversationTurn to isolate the
   * honest fallback path. Returns the sendAutomatedTextMessage spy for assertions.
   */
  function stubForFallbackTest(options: {
    isBlocked: boolean;
    conversationAgentResult: null | { action?: string; responseText?: string };
  }) {
    // Stub conversationAgent.reply to return null (simulating AI failure / no match)
    const orch = orchestrator as unknown as Record<string, unknown>;

    const fakeConversationAgent = {
      reply: vi.fn().mockResolvedValue(options.conversationAgentResult),
    };
    orch["conversationAgent"] = fakeConversationAgent;

    // Stub isConversationAiBlocked to return the desired value
    vi.spyOn(orchestrator as never, "isConversationAiBlocked").mockResolvedValue(options.isBlocked);

    // Stub isSessionExecutionStale to always return false (no staleness)
    vi.spyOn(orchestrator as never, "isSessionExecutionStale").mockReturnValue(false);

    // Stub memoryAgent.getContext and update
    const fakeMemoryAgent = {
      getContext: vi.fn().mockResolvedValue({ contextString: "" }),
      update: vi.fn().mockResolvedValue(undefined),
    };
    orch["memoryAgent"] = fakeMemoryAgent;

    // Stub appendConversationHistory
    vi.spyOn(orchestrator as never, "appendConversationHistory").mockReturnValue(undefined);

    // Spy on sendAutomatedTextMessage (the key assertion point)
    const sendSpy = vi.spyOn(orchestrator as never, "sendAutomatedTextMessage").mockResolvedValue(undefined);

    return { sendSpy };
  }

  it("Test 1: chatbotResult null AND not blocked → client receives honest fallback message", async () => {
    const { sendSpy } = stubForFallbackTest({ isBlocked: false, conversationAgentResult: null });

    const params = makeParams();
    await (orchestrator as never)["processConversationTurn"](params);

    const honestFallbackCalls = sendSpy.mock.calls.filter(
      (call: unknown[]) => (call[5] as { action: string })?.action === "honest_fallback"
    );
    expect(honestFallbackCalls.length).toBe(1);
    expect(honestFallbackCalls[0]![4]).toBe(HONEST_FALLBACK_MESSAGE);
  });

  it("Test 2: chatbotResult null AND isConversationAiBlocked true → NO honest fallback (silence preserved)", async () => {
    const { sendSpy } = stubForFallbackTest({ isBlocked: true, conversationAgentResult: null });

    const params = makeParams();
    await (orchestrator as never)["processConversationTurn"](params);

    const honestFallbackCalls = sendSpy.mock.calls.filter(
      (call: unknown[]) => (call[5] as { action: string })?.action === "honest_fallback"
    );
    expect(honestFallbackCalls.length).toBe(0);
  });

  it("Test 3: chatbotResult null AND aprendizadoContinuo DISABLED → Part B admin notification NOT sent", async () => {
    const { sendSpy } = stubForFallbackTest({ isBlocked: false, conversationAgentResult: null });

    const params = makeParams({
      modules: {
        aprendizadoContinuo: {
          isEnabled: false,
          verificationStatus: "UNVERIFIED",
        },
      },
    });

    await (orchestrator as never)["processConversationTurn"](params);

    // Part A (client honest fallback) must fire
    const partACalls = sendSpy.mock.calls.filter(
      (call: unknown[]) => (call[5] as { action: string })?.action === "honest_fallback"
    );
    expect(partACalls.length).toBe(1);

    // Part B (admin notify) must NOT fire
    const partBCalls = sendSpy.mock.calls.filter(
      (call: unknown[]) => (call[5] as { action: string })?.action === "honest_fallback_admin_notify"
    );
    expect(partBCalls.length).toBe(0);
  });

  it("Test 4: chatbotResult null AND aprendizadoContinuo ENABLED+VERIFIED AND adminPhone exists → Part B fires with question text", async () => {
    const { sendSpy } = stubForFallbackTest({ isBlocked: false, conversationAgentResult: null });

    const params = makeParams({
      modules: {
        aprendizadoContinuo: {
          isEnabled: true,
          verificationStatus: "VERIFIED",
          verifiedPhone: "5511888888888",
          verifiedPhones: [],
          additionalAdminPhones: [],
        },
      },
      leadsPhoneNumber: null,
    });
    // Set inputText to something recognizable
    (params as Record<string, unknown>)["inputText"] = "Qual o valor do plano premium?";

    await (orchestrator as never)["processConversationTurn"](params);

    // Part A
    const partACalls = sendSpy.mock.calls.filter(
      (call: unknown[]) => (call[5] as { action: string })?.action === "honest_fallback"
    );
    expect(partACalls.length).toBe(1);
    expect(partACalls[0]![4]).toBe(HONEST_FALLBACK_MESSAGE);

    // Part B — admin notification containing question text
    const partBCalls = sendSpy.mock.calls.filter(
      (call: unknown[]) => (call[5] as { action: string })?.action === "honest_fallback_admin_notify"
    );
    expect(partBCalls.length).toBe(1);
    const adminMsg = partBCalls[0]![4] as string;
    expect(adminMsg).toContain("Qual o valor do plano premium?");
  });

  it("Test 5: chatbotResult null AND aprendizadoContinuo ENABLED but adminPhone null → Part B skipped, Part A fires", async () => {
    const { sendSpy } = stubForFallbackTest({ isBlocked: false, conversationAgentResult: null });

    const params = makeParams({
      modules: {
        aprendizadoContinuo: {
          isEnabled: true,
          verificationStatus: "VERIFIED",
          verifiedPhone: null,
          verifiedPhones: [],
          additionalAdminPhones: [],
        },
      },
      leadsPhoneNumber: null,
    });

    await (orchestrator as never)["processConversationTurn"](params);

    // Part A fires
    const partACalls = sendSpy.mock.calls.filter(
      (call: unknown[]) => (call[5] as { action: string })?.action === "honest_fallback"
    );
    expect(partACalls.length).toBe(1);

    // Part B NOT called
    const partBCalls = sendSpy.mock.calls.filter(
      (call: unknown[]) => (call[5] as { action: string })?.action === "honest_fallback_admin_notify"
    );
    expect(partBCalls.length).toBe(0);
  });
});
