import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock module-runtime before importing DailySummaryService to avoid
// the @infracode/types dependency that isn't built in the worktree
vi.mock("../../chatbot/module-runtime.js", () => ({
  sanitizeChatbotModules: vi.fn((modules: unknown) => modules ?? {}),
  getResumoDiarioModuleConfig: vi.fn(),
  getAprendizadoContinuoModuleConfig: vi.fn(),
}));

import { DailySummaryService } from "../daily-summary.service.js";
import {
  sanitizeChatbotModules,
  getResumoDiarioModuleConfig,
  getAprendizadoContinuoModuleConfig,
} from "../../chatbot/module-runtime.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRedisMock() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  };
}

function makePrismaMock() {
  return {
    chatbotConfig: { findUnique: vi.fn() },
    instance: { findUnique: vi.fn().mockResolvedValue({ id: "inst-1" }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([
      {
        timedOutCount: "2",
        totalClosedCount: "10",
        startedCount: "8",
        endedCount: "5",
        inactiveCount: "1",
        handoffCount: "1",
        avgDurationSeconds: "180",
        avgFirstResponseMs: "3000",
      },
    ]),
  };
}

function makeTenantPrismaRegistryMock(p = makePrismaMock()) {
  return { getClient: vi.fn().mockResolvedValue(p), _prisma: p };
}

function makeLoggerMock() {
  const inner = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { child: vi.fn(() => inner), _inner: inner };
}

function makeAdminCommandServiceMock() {
  return {
    generateDailySummary: vi.fn().mockResolvedValue("📊 *Resumo Diário*\n• Conversas abertas: 5"),
  };
}

function makeSendMessageMock() {
  return vi.fn().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-abc";
const INSTANCE_ID = "inst-1";
const WORKER_KEY = `${TENANT_ID}:${INSTANCE_ID}`;
const ADMIN_PHONE = "5511999887766";

/** Build a chatbotConfig.findUnique return value with resumoDiario enabled */
function makeModulesConfig({
  resumoDiarioEnabled = true,
  aprendizadoEnabled = false,
  sendHour = 0, // UTC hour — 0 means always past
}: {
  resumoDiarioEnabled?: boolean;
  aprendizadoEnabled?: boolean;
  sendHour?: number;
} = {}) {
  return {
    modules: {
      resumoDiario: {
        isEnabled: resumoDiarioEnabled,
        horaEnvioUtc: sendHour,
      },
      aprendizadoContinuo: {
        isEnabled: aprendizadoEnabled,
        verifiedPhone: ADMIN_PHONE,
        configuredAdminPhone: ADMIN_PHONE,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Typed mock references for module-runtime
// ---------------------------------------------------------------------------

const mockSanitizeChatbotModules = vi.mocked(sanitizeChatbotModules);
const mockGetResumoDiarioModuleConfig = vi.mocked(getResumoDiarioModuleConfig);
const mockGetAprendizadoContinuoModuleConfig = vi.mocked(getAprendizadoContinuoModuleConfig);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DailySummaryService", () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let prismaMock: ReturnType<typeof makePrismaMock>;
  let registry: ReturnType<typeof makeTenantPrismaRegistryMock>;
  let logger: ReturnType<typeof makeLoggerMock>;
  let adminCommandService: ReturnType<typeof makeAdminCommandServiceMock>;
  let sendMessage: ReturnType<typeof makeSendMessageMock>;
  let service: DailySummaryService;
  let workers: Map<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeRedisMock();
    prismaMock = makePrismaMock();
    registry = makeTenantPrismaRegistryMock(prismaMock);
    logger = makeLoggerMock();
    adminCommandService = makeAdminCommandServiceMock();
    sendMessage = makeSendMessageMock();
    workers = new Map([[WORKER_KEY, {}]]);

    // Default: sanitizeChatbotModules passes through
    mockSanitizeChatbotModules.mockImplementation((m: unknown) => m as never);

    service = new DailySummaryService({
      redis: redis as never,
      tenantPrismaRegistry: registry as never,
      adminCommandService: adminCommandService as never,
      sendMessage,
      logger: logger as never,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1 (MET-06 active): when resumoDiario.isEnabled === true AND past sendHour,
  // generateDailySummary is called and sendAutomatedTextMessage is called once with admin phone.
  // Redis dedup key is SET after send.
  it("Test 1 (MET-06 active): sends summary when module enabled and past sendHour", async () => {
    prismaMock.chatbotConfig.findUnique.mockResolvedValue({ modules: {} });
    mockGetResumoDiarioModuleConfig.mockReturnValue({ isEnabled: true, horaEnvioUtc: 0 } as never);
    mockGetAprendizadoContinuoModuleConfig.mockReturnValue({
      isEnabled: true,
      verifiedPhone: ADMIN_PHONE,
      configuredAdminPhone: ADMIN_PHONE,
    } as never);

    await service.sendForAllInstances(workers);

    expect(adminCommandService.generateDailySummary).toHaveBeenCalledOnce();
    expect(adminCommandService.generateDailySummary).toHaveBeenCalledWith(TENANT_ID, INSTANCE_ID);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      TENANT_ID,
      INSTANCE_ID,
      ADMIN_PHONE,
      `${ADMIN_PHONE}@s.whatsapp.net`,
      expect.any(String),
      expect.objectContaining({ action: "daily_summary" })
    );
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining("daily-summary:sent:"),
      "1",
      "EX",
      86400
    );
  });

  // Test 2 (MET-06 disabled): when resumoDiario.isEnabled === false and aprendizadoContinuo.isEnabled === false,
  // generateDailySummary is NOT called and sendMessage is NOT called.
  it("Test 2 (MET-06 disabled): no-op when both modules disabled", async () => {
    prismaMock.chatbotConfig.findUnique.mockResolvedValue({ modules: {} });
    mockGetResumoDiarioModuleConfig.mockReturnValue({ isEnabled: false, horaEnvioUtc: 8 } as never);
    mockGetAprendizadoContinuoModuleConfig.mockReturnValue({ isEnabled: false } as never);

    await service.sendForAllInstances(workers);

    expect(adminCommandService.generateDailySummary).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // Test 3 (MET-06 dedup): when Redis already has the dedup key set,
  // generateDailySummary is NOT called even if module is enabled.
  it("Test 3 (MET-06 dedup): skips when Redis dedup key already set", async () => {
    redis.get.mockResolvedValue("1"); // Already sent
    mockGetResumoDiarioModuleConfig.mockReturnValue({ isEnabled: true, horaEnvioUtc: 0 } as never);
    mockGetAprendizadoContinuoModuleConfig.mockReturnValue({
      isEnabled: true,
      verifiedPhone: ADMIN_PHONE,
    } as never);

    await service.sendForAllInstances(workers);

    expect(adminCommandService.generateDailySummary).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // Test 4 (MET-06 hour gate): when getUTCHours() < sendHour,
  // generateDailySummary is NOT called.
  it("Test 4 (MET-06 hour gate): skips when current UTC hour is before sendHour", async () => {
    const currentHour = new Date().getUTCHours();
    const futureHour = currentHour + 2; // Always in the future
    prismaMock.chatbotConfig.findUnique.mockResolvedValue({ modules: {} });
    mockGetResumoDiarioModuleConfig.mockReturnValue({ isEnabled: true, horaEnvioUtc: futureHour } as never);
    mockGetAprendizadoContinuoModuleConfig.mockReturnValue({
      isEnabled: true,
      verifiedPhone: ADMIN_PHONE,
    } as never);

    await service.sendForAllInstances(workers);

    expect(adminCommandService.generateDailySummary).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // Test 5 (MET-04 in summary): buildSessionMetricsSummary with mock data
  // produces text containing "Sessões" and "Taxa de continuação: 80.0%".
  it("Test 5 (MET-04 in summary): buildSessionMetricsSummary includes continuation rate", async () => {
    // timedOutCount: 2, totalClosedCount: 10 → continuation rate = (1 - 2/10) * 100 = 80.0%
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      {
        timedOutCount: "2",
        totalClosedCount: "10",
        startedCount: "8",
        endedCount: "5",
        inactiveCount: "1",
        transferredCount: "0",
        avgDurationSeconds: "180",
      },
    ]);

    const result = await service.buildSessionMetricsSummary(TENANT_ID, INSTANCE_ID);

    expect(result).not.toBeNull();
    expect(result).toContain("Sess");
    expect(result).toContain("Taxa de continuação: 80.0%");
  });
});
